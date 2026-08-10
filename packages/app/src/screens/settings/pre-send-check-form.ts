import {
  PRE_SEND_MEASUREMENTS,
  PRE_SEND_OPERATORS,
  PRE_SEND_RULE_DISPOSITIONS,
  isTextMeasurement,
  type PreSendActionDescriptor,
  type PreSendCheckRule,
} from "@getpaseo/protocol/pre-send-checks/types";
import { formatMeasurementValue, type PreSendTranslate } from "@/composer/pre-send-checks";
import { formatDuration } from "@/utils/time";

/**
 * Everything the rule editor does that is not rendering: turning a rule into a
 * draft and back, validating it, and describing it for the list.
 *
 * Kept apart from the components because the interesting behaviour here is the
 * value-preservation rule below, and a behaviour worth a comment is worth a test
 * that does not need a DOM to run.
 */

/** All strings, because that is what a text input holds. Parsed on the way out. */
export interface PreSendCheckDraft {
  measurement: string;
  operator: string;
  /** The number for a numeric measurement, or the text a trigger matches. */
  threshold: string;
  disposition: string;
  message: string;
  /** Which action a redirect performs. Empty for any other disposition. */
  actionKind: string;
  /**
   * The action parameters, keyed by the descriptor's parameter id.
   *
   * Kept as strings for the same reason the threshold is: this is what an input
   * holds. Parameters the current kind does not declare are kept rather than
   * dropped, so switching kind and switching back does not lose what was typed.
   */
  actionParams: Record<string, string>;
}

export type PreSendCheckField = "measurement" | "operator" | "threshold" | "disposition" | "action";

export type PreSendCheckFieldErrors = Partial<Record<PreSendCheckField, string>>;

export const EMPTY_PRE_SEND_CHECK_DRAFT: PreSendCheckDraft = {
  measurement: PRE_SEND_MEASUREMENTS[0],
  operator: "gte",
  threshold: "",
  disposition: "block",
  message: "",
  actionKind: "",
  actionParams: {},
};

export function toPreSendCheckDraft(rule: PreSendCheckRule): PreSendCheckDraft {
  const { kind, ...params } = rule.action ?? {};
  return {
    measurement: rule.measurement,
    operator: rule.operator,
    // A text rule compares against `text`; a numeric one against `threshold`.
    // One input holds whichever applies, so the editor has one field rather
    // than two that are never both meaningful.
    threshold: isTextMeasurement(rule.measurement)
      ? (rule.text ?? "")
      : String(rule.threshold ?? ""),
    disposition: rule.disposition,
    message: rule.message ?? "",
    actionKind: typeof kind === "string" ? kind : "",
    actionParams: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    ),
  };
}

/**
 * Builds the rule to save.
 *
 * Spreads `existing` first so fields this build of the app has never heard of
 * survive an edit — a rule written by a newer daemon must come back out the way
 * it went in. `message` is dropped rather than stored empty, so a cleared message
 * falls back to the translated default instead of rendering as a blank toast.
 */
export function applyPreSendCheckDraft(input: {
  existing: PreSendCheckRule | null;
  draft: PreSendCheckDraft;
  id: string;
  /** What the daemon says each action takes. Absent keeps every parameter. */
  descriptors?: readonly PreSendActionDescriptor[];
}): PreSendCheckRule {
  const message = input.draft.message.trim();
  const isText = isTextMeasurement(input.draft.measurement);
  const next: PreSendCheckRule = {
    ...input.existing,
    id: input.id,
    measurement: input.draft.measurement,
    operator: input.draft.operator,
    disposition: input.draft.disposition,
  };

  // Only the one that applies is written, and the other is removed. A rule
  // carrying both would compare against whichever the evaluator happened to
  // read, which is a rule whose meaning depends on its measurement twice.
  if (isText) {
    next.text = input.draft.threshold.trim();
    delete next.threshold;
  } else {
    next.threshold = Number(input.draft.threshold.trim());
    delete next.text;
  }

  if (message) {
    next.message = message;
  } else {
    delete next.message;
  }

  if (input.draft.disposition === "redirect" && input.draft.actionKind) {
    // Only the parameters the chosen kind declares are written. The draft keeps
    // the rest so switching kind and back does not lose them, but a rule should
    // not carry settings for an action it does not perform.
    const declared = new Set(
      (input.descriptors ?? [])
        .find((descriptor) => descriptor.kind === input.draft.actionKind)
        ?.parameters.map((parameter) => parameter.id) ?? Object.keys(input.draft.actionParams),
    );
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.draft.actionParams)) {
      if (declared.has(key) && value.trim()) {
        params[key] = value;
      }
    }
    next.action = { ...params, kind: input.draft.actionKind };
  } else {
    delete next.action;
  }

  return next;
}

export function validatePreSendCheckDraft(draft: PreSendCheckDraft): PreSendCheckFieldErrors {
  const errors: PreSendCheckFieldErrors = {};
  if (!draft.measurement.trim()) {
    errors.measurement = "settings.preSendChecks.measurementRequired";
  }
  if (!draft.operator.trim()) {
    errors.operator = "settings.preSendChecks.operatorRequired";
  }
  if (!draft.disposition.trim()) {
    errors.disposition = "settings.preSendChecks.dispositionRequired";
  }
  // A text rule compares against a string, so any non-empty value is usable and
  // only a numeric one has to parse.
  if (isTextMeasurement(draft.measurement)) {
    if (!draft.threshold.trim()) {
      errors.threshold = "settings.preSendChecks.textRequired";
    }
  } else {
    const threshold = Number(draft.threshold.trim());
    if (!draft.threshold.trim() || !Number.isFinite(threshold)) {
      errors.threshold = "settings.preSendChecks.thresholdInvalid";
    }
  }
  // A redirect with no action would consume the message and take it nowhere.
  if (draft.disposition === "redirect" && !draft.actionKind.trim()) {
    errors.action = "settings.preSendChecks.actionRequired";
  }
  return errors;
}

/**
 * Whether the editor asks which hosts a rule goes to.
 *
 * One host means there is exactly one place a rule can go, so the modal shows no
 * field and the save has nothing to check. Both the field and the check read
 * this, because a screen that enforces a choice it never offered is a dead end
 * with no way out of it.
 */
export function preSendCheckChoosesHosts(hostCount: number): boolean {
  return hostCount > 1;
}

export type PreSendCheckSaveGate =
  | { kind: "fieldErrors"; errors: PreSendCheckFieldErrors }
  | { kind: "hostsRequired" }
  | { kind: "save" };

/**
 * What pressing save should do.
 *
 * Out here rather than inside the modal's handler so the decision can be read
 * and tested without mounting anything — the component is left with setting
 * state and awaiting the caller, which is all a component should be doing.
 *
 * Order matters: field errors sit under their fields and the host complaint
 * appears once at the bottom, so reporting both at once would put the eye in
 * the wrong place. Fields first, and the host check only once they pass.
 */
export function gatePreSendCheckSave(input: {
  draft: PreSendCheckDraft;
  hostCount: number;
  serverIds: readonly string[];
}): PreSendCheckSaveGate {
  const errors = validatePreSendCheckDraft(input.draft);
  if (Object.keys(errors).length > 0) {
    return { kind: "fieldErrors", errors };
  }
  // A rule on no host is a delete wearing a save's clothes. Refused rather than
  // performed, because nothing about the screen says that is what it means.
  if (preSendCheckChoosesHosts(input.hostCount) && input.serverIds.length === 0) {
    return { kind: "hostsRequired" };
  }
  return { kind: "save" };
}

/**
 * The options a picker offers.
 *
 * When the rule's current value is not one this build knows, it is added to the
 * list and marked, rather than left out. A picker that could only emit known
 * values would quietly rewrite a hand-authored `operator: "approaches"` the first
 * time someone edited that rule's message — which is exactly the outcome the wire
 * schema keeps these fields as plain strings to avoid.
 */
export function preSendCheckOptions(known: readonly string[], current: string): string[] {
  return known.includes(current) || !current ? [...known] : [...known, current];
}

export function isKnownPreSendCheckValue(known: readonly string[], value: string): boolean {
  return known.includes(value);
}

/**
 * The id order after moving one rule a step.
 *
 * Returns the ids rather than the rules because that is what the reorder verb
 * takes, and returns the list unchanged when the move is not possible, so a
 * caller can compare identity to decide whether to send anything at all.
 *
 * Extracted rather than spliced inside the component: terminal profiles keeps
 * the same logic inline and it is the one part of that screen no test covers.
 */
export function movePreSendCheck(
  rules: readonly { id: string }[],
  id: string,
  direction: "up" | "down",
): string[] {
  const ids = rules.map((rule) => rule.id);
  const index = ids.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= ids.length) {
    return ids;
  }
  const next = [...ids];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved as string);
  return next;
}

export const PRE_SEND_MEASUREMENT_OPTIONS = PRE_SEND_MEASUREMENTS;
export const PRE_SEND_OPERATOR_OPTIONS = PRE_SEND_OPERATORS;
export const PRE_SEND_DISPOSITION_OPTIONS = PRE_SEND_RULE_DISPOSITIONS;

// Symbols rather than words, so they need no translation and the sentence stays
// short enough to sit on one line in a row.
const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

const MEASUREMENT_LABEL_KEYS: Record<string, string> = {
  "agent.idleSeconds": "settings.preSendChecks.measurements.idleSeconds",
  "agent.contextUsedPercent": "settings.preSendChecks.measurements.contextUsedPercent",
  "agent.sessionCostUsd": "settings.preSendChecks.measurements.sessionCostUsd",
};

/**
 * The row's title: "Idle time ≥ 1 hour".
 *
 * Falls back to the raw wire value for anything unrecognised, so a rule from a
 * newer daemon reads as something rather than as a blank. The threshold is
 * formatted by the same function the toast uses, so the editor and the message
 * that fires cannot disagree about units.
 */
/**
 * The row's second line: what this rule will actually say when it fires.
 *
 * A custom message is a template, and showing it raw puts `{{value}}` on screen,
 * which reads as broken. There is no measured value at settings time, so the
 * threshold stands in for it — it is the boundary at which the message appears,
 * so the preview is what you would see at the moment the rule first trips rather
 * than an invented number.
 *
 * Rules with no message of their own fall through to the same translated default
 * the toast uses, named here by key so the caller renders it.
 */
export function previewPreSendCheckMessage(
  rule: PreSendCheckRule,
  t: PreSendTranslate,
): string | null {
  if (!rule.message) {
    return null;
  }
  return t(rule.message, {
    defaultValue: rule.message,
    value: formatMeasurementValue(rule.measurement, rule.threshold),
    threshold: formatMeasurementValue(rule.measurement, rule.threshold),
    // A trigger has no threshold to render as a duration; the token is left
    // empty rather than printed as a formatted zero.
    duration: typeof rule.threshold === "number" ? formatDuration(rule.threshold * 1000) : "",
  });
}

export function describePreSendCheck(rule: PreSendCheckRule, t: PreSendTranslate): string {
  const labelKey = MEASUREMENT_LABEL_KEYS[rule.measurement];
  const measurement = labelKey ? t(labelKey) : rule.measurement;
  const operator = OPERATOR_SYMBOLS[rule.operator] ?? rule.operator;
  return `${measurement} ${operator} ${formatMeasurementValue(rule.measurement, rule.threshold)}`;
}
