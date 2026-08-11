import {
  PRE_SEND_OPERATORS,
  PRE_SEND_PLAIN_OUTCOME_KINDS,
  PRE_SEND_TRIGGERS,
  isTextTrigger,
  type PreSendActionDescriptor,
  type PreSendCheckRule,
  type PreSendCheckExample,
  type PreSendOutcome,
} from "@getpaseo/protocol/pre-send-checks/types";
import {
  DEFAULT_PRE_SEND_EVENT,
  normalizePreSendCheckRule,
  projectPreSendCheckRule,
} from "@getpaseo/protocol/pre-send-checks/vocabulary";
import { formatTriggerValue, type PreSendTranslate } from "@/composer/pre-send-checks";
import { formatDuration } from "@/utils/time";

/**
 * Everything the rule editor does that is not rendering: turning a rule into a
 * draft and back, validating it, and describing it for the list.
 *
 * Kept apart from the components because the interesting behaviour here is the
 * value-preservation rule below, and a behaviour worth a comment is worth a test
 * that does not need a DOM to run.
 */

/**
 * All strings, because that is what a text input holds. Parsed on the way out.
 *
 * `disposition` survives here where the wire retired it, and that is deliberate
 * rather than missed. The editor asks two questions - what should happen, and if
 * that is a redirect then where to - because two small pickers read better than
 * one long list mixing `Warn` with `Ask on the side`. The rule that comes out
 * carries a single `outcome`; this is the shape of the questions, not of the
 * record.
 */
export interface PreSendCheckDraft {
  /**
   * Which seam the rule belongs to.
   *
   * Carried through an edit rather than chosen: the editor has no picker for it,
   * because with one daemon-side seam a picker would offer a choice between the
   * send and one other thing. A rule written by hand or opened from an example
   * keeps whatever seam it names, which is what stops the editor quietly moving
   * a `turn.failed` rule onto the composer the first time someone fixes a typo
   * in its message.
   */
  event: string;
  trigger: string;
  operator: string;
  /** The number for a numeric trigger, or the text a message trigger matches. */
  value: string;
  disposition: string;
  message: string;
  /** Which action a redirect performs. Empty for any other disposition. */
  actionKind: string;
  /**
   * The action parameters, keyed by the descriptor's parameter id.
   *
   * Kept as strings for the same reason the value is: this is what an input
   * holds. Parameters the current kind does not declare are kept rather than
   * dropped, so switching kind and switching back does not lose what was typed.
   */
  actionParams: Record<string, string>;
}

export type PreSendCheckField = "trigger" | "operator" | "value" | "disposition" | "action";

export type PreSendCheckFieldErrors = Partial<Record<PreSendCheckField, string>>;

export const EMPTY_PRE_SEND_CHECK_DRAFT: PreSendCheckDraft = {
  event: DEFAULT_PRE_SEND_EVENT,
  trigger: PRE_SEND_TRIGGERS[0],
  operator: "gte",
  value: "",
  disposition: "block",
  message: "",
  actionKind: "",
  actionParams: {},
};

export function toPreSendCheckDraft(rule: PreSendCheckRule): PreSendCheckDraft {
  const normalized = normalizePreSendCheckRule(rule);
  const { kind, ...params } = normalized.outcome;
  const isAction = !isPlainDisposition(kind);
  return {
    event: normalized.event,
    trigger: normalized.trigger,
    operator: normalized.operator,
    value: normalized.value === undefined ? "" : String(normalized.value),
    // The two questions the editor asks, read back off the one field that
    // answers both: an action kind means the disposition was a redirect.
    disposition: isAction ? "redirect" : kind,
    message: normalized.message ?? "",
    actionKind: isAction ? kind : "",
    actionParams: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    ),
  };
}

function isPlainDisposition(kind: string): boolean {
  return (PRE_SEND_PLAIN_OUTCOME_KINDS as readonly string[]).includes(kind);
}

/**
 * Fields this build has never heard of, carried through an edit untouched.
 *
 * A rule written by a newer daemon must come back out the way it went in. This
 * replaces spreading the whole existing rule, which would also have carried the
 * *known* fields back - and a stale `text` beside a fresh `threshold` is a rule
 * whose meaning depends on which one the reader happens to prefer.
 */
const KNOWN_RULE_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "event",
  "measurement",
  "trigger",
  "operator",
  "value",
  "threshold",
  "text",
  "disposition",
  "outcome",
  "action",
  "message",
  "order",
  "enabled",
]);

function carryUnknownFields(existing: PreSendCheckRule | null): Record<string, unknown> {
  if (!existing) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(existing).filter(([key]) => !KNOWN_RULE_FIELDS.has(key)),
  );
}

/**
 * Builds the rule to save.
 *
 * Goes out through `projectPreSendCheckRule`, so what is written carries both
 * vocabularies and an older daemon reads it. `message` is dropped rather than
 * stored empty, so a cleared message falls back to the translated default
 * instead of rendering as a blank toast.
 */
export function applyPreSendCheckDraft(input: {
  existing: PreSendCheckRule | null;
  draft: PreSendCheckDraft;
  id: string;
  /** What the daemon says each action takes. Absent keeps every parameter. */
  descriptors?: readonly PreSendActionDescriptor[];
}): PreSendCheckRule {
  const previous = input.existing ? normalizePreSendCheckRule(input.existing) : null;
  const message = input.draft.message.trim();
  const operand = input.draft.value.trim();
  return {
    ...carryUnknownFields(input.existing),
    ...projectPreSendCheckRule({
      id: input.id,
      event: input.draft.event,
      trigger: input.draft.trigger,
      operator: input.draft.operator,
      // The type is the answer to which operand this is, so a text trigger's
      // stays a string and a numeric one is parsed. Nothing has to write both
      // and nothing has to delete the other.
      value: isTextTrigger(input.draft.trigger) ? operand : Number(operand),
      outcome: buildOutcome(input.draft, input.descriptors),
      message: message || undefined,
      order: previous?.order,
      enabled: previous?.enabled ?? true,
    }),
  };
}

/**
 * The two pickers, resolved into the one field that records them.
 *
 * A redirect naming no action produces `{ kind: "redirect" }`, which no build
 * can perform and the evaluator therefore skips. That is the same refusal the
 * old two-field shape made, and validation catches it before a save anyway.
 */
function buildOutcome(
  draft: PreSendCheckDraft,
  descriptors?: readonly PreSendActionDescriptor[],
): PreSendOutcome {
  if (draft.disposition !== "redirect" || !draft.actionKind) {
    return { kind: draft.disposition };
  }
  // Only the parameters the chosen kind declares are written. The draft keeps
  // the rest so switching kind and back does not lose them, but a rule should
  // not carry settings for an action it does not perform.
  const declared = new Set(
    (descriptors ?? [])
      .find((descriptor) => descriptor.kind === draft.actionKind)
      ?.parameters.map((parameter) => parameter.id) ?? Object.keys(draft.actionParams),
  );
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft.actionParams)) {
    if (declared.has(key) && value.trim()) {
      params[key] = value;
    }
  }
  return { ...params, kind: draft.actionKind };
}

export function validatePreSendCheckDraft(draft: PreSendCheckDraft): PreSendCheckFieldErrors {
  const errors: PreSendCheckFieldErrors = {};
  if (!draft.trigger.trim()) {
    errors.trigger = "settings.preSendChecks.triggerRequired";
  }
  if (!draft.operator.trim()) {
    errors.operator = "settings.preSendChecks.operatorRequired";
  }
  if (!draft.disposition.trim()) {
    errors.disposition = "settings.preSendChecks.dispositionRequired";
  }
  // A text rule compares against a string, so any non-empty value is usable and
  // only a numeric one has to parse.
  if (isTextTrigger(draft.trigger)) {
    if (!draft.value.trim()) {
      errors.value = "settings.preSendChecks.textRequired";
    }
  } else {
    const operand = Number(draft.value.trim());
    if (!draft.value.trim() || !Number.isFinite(operand)) {
      errors.value = "settings.preSendChecks.thresholdInvalid";
    }
  }
  // A redirect with no action would consume the message and take it nowhere.
  if (draft.disposition === "redirect" && !draft.actionKind.trim()) {
    errors.action = "settings.preSendChecks.actionRequired";
  }
  return errors;
}

/**
 * An example, opened as a new rule rather than installed as one.
 *
 * It goes through the ordinary create flow — the modal, the host switches, the
 * save — so what lands on disk is a rule the person saw and agreed to, and one
 * they can change before it exists. An example that installed itself would put
 * a rule that intercepts what you type on a host without you reading it.
 *
 * The id is supplied here only because a rule needs one to be projected, and is
 * thrown away: a template has no id, and the one the rule gets is minted at
 * save.
 */
export function preSendCheckExampleToDraft(example: PreSendCheckExample): PreSendCheckDraft {
  // An example's rule is a normalized rule missing exactly the three fields a
  // template has no business carrying, so projecting it and reading it back is
  // the whole conversion.
  return toPreSendCheckDraft(
    projectPreSendCheckRule({
      id: example.id,
      event: example.rule.event ?? DEFAULT_PRE_SEND_EVENT,
      trigger: example.rule.trigger,
      operator: example.rule.operator,
      value: example.rule.value,
      outcome: example.rule.outcome,
      message: example.rule.message,
      order: undefined,
      enabled: true,
    }),
  );
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

export const PRE_SEND_OPERATOR_OPTIONS = PRE_SEND_OPERATORS;
export const PRE_SEND_TRIGGER_OPTIONS = PRE_SEND_TRIGGERS;
export const PRE_SEND_DISPOSITION_OPTIONS = ["warn", "block", "redirect"] as const;

// Symbols rather than words, so they need no translation and the sentence stays
// short enough to sit on one line in a row.
const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

const TRIGGER_LABEL_KEYS: Record<string, string> = {
  "agent.idleSeconds": "settings.preSendChecks.triggers.idleSeconds",
  "agent.contextUsedPercent": "settings.preSendChecks.triggers.contextUsedPercent",
  "agent.sessionCostUsd": "settings.preSendChecks.triggers.sessionCostUsd",
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
  const { trigger, value, message } = normalizePreSendCheckRule(rule);
  if (!message) {
    return null;
  }
  const rendered = formatTriggerValue(trigger, value);
  return t(message, {
    defaultValue: message,
    value: rendered,
    // `threshold` is the token a rule written before the rename uses, and a
    // message is the one part of a rule someone typed by hand. Both names fill.
    threshold: rendered,
    // A text trigger has no number to render as a duration; the token is left
    // empty rather than printed as a formatted zero.
    duration: typeof value === "number" ? formatDuration(value * 1000) : "",
  });
}

export function describePreSendCheck(rule: PreSendCheckRule, t: PreSendTranslate): string {
  const { trigger, value, operator } = normalizePreSendCheckRule(rule);
  const labelKey = TRIGGER_LABEL_KEYS[trigger];
  const label = labelKey ? t(labelKey) : trigger;
  const symbol = OPERATOR_SYMBOLS[operator] ?? operator;
  return `${label} ${symbol} ${formatTriggerValue(trigger, value)}`;
}
