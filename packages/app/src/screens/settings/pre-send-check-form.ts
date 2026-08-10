import {
  PRE_SEND_MEASUREMENTS,
  PRE_SEND_OPERATORS,
  PRE_SEND_RULE_DISPOSITIONS,
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
  threshold: string;
  disposition: string;
  message: string;
}

export type PreSendCheckField = "measurement" | "operator" | "threshold" | "disposition";

export type PreSendCheckFieldErrors = Partial<Record<PreSendCheckField, string>>;

export const EMPTY_PRE_SEND_CHECK_DRAFT: PreSendCheckDraft = {
  measurement: PRE_SEND_MEASUREMENTS[0],
  operator: "gte",
  threshold: "",
  disposition: "block",
  message: "",
};

export function toPreSendCheckDraft(rule: PreSendCheckRule): PreSendCheckDraft {
  return {
    measurement: rule.measurement,
    operator: rule.operator,
    threshold: String(rule.threshold),
    disposition: rule.disposition,
    message: rule.message ?? "",
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
}): PreSendCheckRule {
  const message = input.draft.message.trim();
  const next: PreSendCheckRule = {
    ...input.existing,
    id: input.id,
    measurement: input.draft.measurement,
    operator: input.draft.operator,
    threshold: Number(input.draft.threshold.trim()),
    disposition: input.draft.disposition,
  };
  if (message) {
    next.message = message;
  } else {
    delete next.message;
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
  const threshold = Number(draft.threshold.trim());
  if (!draft.threshold.trim() || !Number.isFinite(threshold)) {
    errors.threshold = "settings.preSendChecks.thresholdInvalid";
  }
  return errors;
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
