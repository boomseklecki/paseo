import {
  PRE_SEND_OPERATORS,
  PRE_SEND_TRIGGERS,
  isPlainOutcomeKind,
  isTextTrigger,
  mostSeverePreSendOutcome,
  type PreSendOutcomeDescriptor,
  type PreSendCheckRule,
  type PreSendCheckExample,
  type PreSendOutcome,
} from "@getpaseo/protocol/pre-send-checks/types";
import {
  DEFAULT_PRE_SEND_EVENT,
  normalizePreSendCheckRule,
  projectPreSendCheckRule,
} from "@getpaseo/protocol/pre-send-checks/vocabulary";
import {
  findPreSendEventDefinition,
  isOutcomeValidForEvent,
  PRE_SEND_EVENT_DEFINITIONS,
} from "@getpaseo/protocol/pre-send-checks/events";
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
 * One outcome as the editor holds it.
 *
 * Split from the wire shape because a form holds strings: `params` is keyed by
 * the descriptor's parameter id and every value is what an input contained, so
 * nothing here has to know that `repeat` is a toggle and `delay` is text.
 *
 * Parameters the current kind does not declare are kept rather than dropped, so
 * switching kind and switching back does not lose what was typed. Only the
 * declared ones are written on save.
 */
export interface PreSendCheckOutcomeDraft {
  kind: string;
  params: Record<string, string>;
}

/**
 * All strings, because that is what a text input holds. Parsed on the way out.
 *
 * `outcomes` is a list and `disposition` is gone. The editor used to ask two
 * questions — what should happen, and if that is a redirect then where to —
 * which made `redirect` a word in the interface that was never a word in the
 * rule: it existed only to introduce the second picker. One list of outcomes
 * asks the question once, and the answer is the same shape as the record.
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
  /** Never empty on a saveable draft: a rule with no outcome does nothing. */
  outcomes: PreSendCheckOutcomeDraft[];
  message: string;
}

export type PreSendCheckField = "event" | "trigger" | "operator" | "value" | "outcomes" | "message";

/**
 * Whether this seam has a person typing something for `{{message}}` to be.
 *
 * The token means two different things and that is the honest reading of it: at
 * the composer it is the text in the box, and at a daemon seam nobody typed
 * anything, so what fills it is the rule's own `message`. Everything that has to
 * explain or validate the token asks this first.
 */
export function preSendEventSuppliesTypedMessage(event: string): boolean {
  return event === DEFAULT_PRE_SEND_EVENT;
}

/** Whether any of a draft's outcomes interpolates the token. */
export function preSendDraftUsesMessageToken(draft: PreSendCheckDraft): boolean {
  return draft.outcomes.some((outcome) =>
    Object.values(outcome.params).some((value) => value.includes(MESSAGE_TOKEN)),
  );
}

const MESSAGE_TOKEN = "{{message}}";

export type PreSendCheckFieldErrors = Partial<Record<PreSendCheckField, string>>;

export const EMPTY_PRE_SEND_CHECK_DRAFT: PreSendCheckDraft = {
  event: DEFAULT_PRE_SEND_EVENT,
  trigger: PRE_SEND_TRIGGERS[0],
  operator: "gte",
  value: "",
  outcomes: [{ kind: "block", params: {} }],
  message: "",
};

export function toPreSendCheckDraft(rule: PreSendCheckRule): PreSendCheckDraft {
  const normalized = normalizePreSendCheckRule(rule);
  return {
    event: normalized.event,
    trigger: normalized.trigger,
    operator: normalized.operator,
    value: normalized.value === undefined ? "" : String(normalized.value),
    outcomes: normalized.outcomes.map(toOutcomeDraft),
    message: normalized.message ?? "",
  };
}

/**
 * One wire outcome as the form holds it.
 *
 * A non-string parameter becomes an empty string rather than being coerced.
 * Only text and toggle parameters exist, and a toggle is `"true"` or empty, so
 * anything else came from a daemon this build cannot draw a control for — and
 * an input showing `[object Object]` is worse than one showing nothing.
 */
function toOutcomeDraft(outcome: PreSendOutcome): PreSendCheckOutcomeDraft {
  const { kind, ...params } = outcome;
  return {
    kind,
    params: Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? value : ""]),
    ),
  };
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
  /** What the daemon says each outcome takes. Absent keeps every parameter. */
  descriptors?: readonly PreSendOutcomeDescriptor[];
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
      outcomes: input.draft.outcomes.map((outcome) => buildOutcome(outcome, input.descriptors)),
      message: message || undefined,
      order: previous?.order,
      enabled: previous?.enabled ?? true,
    }),
  };
}

/**
 * One drafted outcome as it is recorded.
 *
 * Only the parameters the chosen kind declares are written. The draft keeps the
 * rest so switching kind and back does not lose them, but a rule should not
 * carry settings for something it does not do. With no descriptors — a daemon
 * too old to describe itself — every parameter is kept, because dropping them
 * all would silently strip a rule of everything it was configured with.
 */
function buildOutcome(
  outcome: PreSendCheckOutcomeDraft,
  descriptors?: readonly PreSendOutcomeDescriptor[],
): PreSendOutcome {
  const declared = new Set(
    (descriptors ?? [])
      .find((descriptor) => descriptor.kind === outcome.kind)
      ?.parameters.map((parameter) => parameter.id) ?? Object.keys(outcome.params),
  );
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(outcome.params)) {
    if (declared.has(key) && value.trim()) {
      params[key] = value;
    }
  }
  return { ...params, kind: outcome.kind };
}

export function validatePreSendCheckDraft(draft: PreSendCheckDraft): PreSendCheckFieldErrors {
  const errors: PreSendCheckFieldErrors = {};
  if (!draft.trigger.trim()) {
    errors.trigger = "settings.preSendChecks.triggerRequired";
  }
  if (!draft.operator.trim()) {
    errors.operator = "settings.preSendChecks.operatorRequired";
  }
  const outcomeError = validateOutcomes(draft.outcomes);
  if (outcomeError) {
    errors.outcomes = outcomeError;
  }
  // A prompt asking for `{{message}}` where nothing supplies one renders a hole.
  // The rule still fires, so nothing else would ever say a word about it: the
  // agent just receives a prompt with a gap where the question should be. This
  // is the only place that catches it.
  if (
    !preSendEventSuppliesTypedMessage(draft.event) &&
    !draft.message.trim() &&
    preSendDraftUsesMessageToken(draft)
  ) {
    errors.message = "settings.preSendChecks.messageNeededForToken";
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
  return errors;
}

/**
 * What is wrong with the list, or null.
 *
 * Two rules, and both are about states the wire would accept and nobody meant.
 * A rule with no outcome is stored, evaluated, and does nothing. The same kind
 * twice is two identical subagents, not two questions.
 *
 * The duplicate check is unreachable from the editor, which leaves a kind out of
 * a row's picker once a sibling holds it — see `preSendOutcomeKindsForRow`. It
 * stays because a draft can also come from a rule someone wrote by hand, and
 * because the day that filter is loosened is the day this becomes the only thing
 * standing between a slip and a saved rule that does its work twice.
 *
 * Not checked here: whether the seam accepts the kind. The editor only offers
 * kinds the seam accepts and drops the rest when the seam changes, so a refusal
 * at this point could only come from a rule written elsewhere — and refusing to
 * save an edit to someone's hand-written rule is a dead end with no way out.
 */
function validateOutcomes(outcomes: readonly PreSendCheckOutcomeDraft[]): string | undefined {
  if (outcomes.length === 0 || outcomes.some((outcome) => !outcome.kind.trim())) {
    return "settings.preSendChecks.outcomeRequired";
  }
  const kinds = new Set(outcomes.map((outcome) => outcome.kind));
  if (kinds.size !== outcomes.length) {
    return "settings.preSendChecks.outcomeDuplicate";
  }
  return undefined;
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
      outcomes: example.rule.outcomes,
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
export const PRE_SEND_EVENT_OPTIONS = PRE_SEND_EVENT_DEFINITIONS.map(
  (definition) => definition.event,
);

export const PRE_SEND_TRIGGER_OPTIONS = PRE_SEND_TRIGGERS;

/**
 * The triggers worth offering at a seam.
 *
 * An event this build has never heard of offers everything rather than nothing:
 * a rule from a newer daemon should still be editable, and an empty picker is a
 * dead end. Same instinct as `preSendCheckOptions`, which keeps an unrecognised
 * value selectable rather than quietly rewriting it.
 */
export function preSendTriggerOptions(event: string): readonly string[] {
  return findPreSendEventDefinition(event)?.triggers ?? PRE_SEND_TRIGGERS;
}

/**
 * Every outcome kind one picker can offer at this seam.
 *
 * One list where there were two. The old pair asked "what should happen" and
 * then "where to", which put the word `redirect` in the interface purely to
 * introduce the second question — a word that named nothing in the rule and
 * nothing a person wanted. Here `Warn` and `Ask on the side` sit in the same
 * list, because they are the same kind of answer.
 *
 * A runnable kind appears only when the daemon described it: this build can
 * name `fork` all it likes, but a daemon that cannot perform one would take the
 * message and decline. The plain kinds need no descriptor — every version can
 * warn — so they are offered on the seam's word alone.
 *
 * A seam this build has never heard of offers the composer's set rather than
 * nothing, for the same reason `preSendTriggerOptions` does: a rule from a newer
 * daemon should still be editable, and an empty picker is a dead end.
 */
export function preSendOutcomeKindOptions(
  event: string,
  descriptors: readonly PreSendOutcomeDescriptor[],
): readonly string[] {
  const definition = findPreSendEventDefinition(event);
  if (!definition) {
    return ["warn", "block"];
  }
  const described = new Set(descriptors.map((descriptor) => descriptor.kind));
  return definition.outcomeKinds.filter((kind) => isPlainOutcomeKind(kind) || described.has(kind));
}

/** The described outcomes a seam will actually carry out, for their parameters. */
export function preSendOutcomeOptions(
  event: string,
  descriptors: readonly PreSendOutcomeDescriptor[],
): PreSendOutcomeDescriptor[] {
  return descriptors.filter((descriptor) => isOutcomeValidForEvent(event, descriptor.kind));
}

/**
 * What one row's picker offers: the seam's kinds, minus the ones its siblings
 * already hold.
 *
 * Removing the error state rather than reporting it. Listing the same kind twice
 * is never something anyone wants — two asides on one condition is two identical
 * subagents — so a picker that cannot express it beats one that can and then
 * complains. It also means a row is uniquely identified by its kind, which is
 * what lets the list be keyed by something stable rather than by position.
 *
 * The row's own current kind is always included, or the picker would have no
 * value selected.
 */
export function preSendOutcomeKindsForRow(
  draft: PreSendCheckDraft,
  index: number,
  descriptors: readonly PreSendOutcomeDescriptor[],
): readonly string[] {
  const taken = new Set(
    draft.outcomes.filter((_, at) => at !== index).map((outcome) => outcome.kind),
  );
  return preSendOutcomeKindOptions(draft.event, descriptors).filter((kind) => !taken.has(kind));
}

/**
 * The next kind to offer when someone presses the `+`.
 *
 * The first the seam accepts that is not already in the list, because adding a
 * row that is immediately invalid makes the person fix the editor's guess before
 * they can say what they meant. `null` when the seam has nothing left to add,
 * which is what hides the button rather than showing one that does nothing.
 */
export function nextPreSendOutcomeKind(
  draft: PreSendCheckDraft,
  descriptors: readonly PreSendOutcomeDescriptor[],
): string | null {
  const taken = new Set(draft.outcomes.map((outcome) => outcome.kind));
  return (
    preSendOutcomeKindOptions(draft.event, descriptors).find((kind) => !taken.has(kind)) ?? null
  );
}

/** Appends an outcome row. A caller with nothing to add gets the draft back. */
export function addPreSendOutcome(
  draft: PreSendCheckDraft,
  kind: string | null,
): PreSendCheckDraft {
  if (!kind) {
    return draft;
  }
  return { ...draft, outcomes: [...draft.outcomes, { kind, params: {} }] };
}

/**
 * Drops one outcome row.
 *
 * Refuses to empty the list. A rule with no outcomes is one that fires and does
 * nothing, and validation would refuse to save it — so the last `-` is disabled
 * rather than allowed and then complained about.
 */
export function removePreSendOutcome(draft: PreSendCheckDraft, index: number): PreSendCheckDraft {
  if (draft.outcomes.length <= 1) {
    return draft;
  }
  return { ...draft, outcomes: draft.outcomes.filter((_, at) => at !== index) };
}

/**
 * Changes one row's kind, keeping what was typed against the old one.
 *
 * The parameters are not cleared, which is deliberate: switching from `aside` to
 * `start` and back should not lose the prompt, and only the parameters the saved
 * kind declares are written anyway. See `buildOutcome`.
 */
export function setPreSendOutcomeKind(
  draft: PreSendCheckDraft,
  index: number,
  kind: string,
): PreSendCheckDraft {
  return {
    ...draft,
    outcomes: draft.outcomes.map((outcome, at) => (at === index ? { ...outcome, kind } : outcome)),
  };
}

export function setPreSendOutcomeParam(
  draft: PreSendCheckDraft,
  index: number,
  id: string,
  value: string,
): PreSendCheckDraft {
  return {
    ...draft,
    outcomes: draft.outcomes.map((outcome, at) =>
      at === index ? { ...outcome, params: { ...outcome.params, [id]: value } } : outcome,
    ),
  };
}

/**
 * Moves a draft to another seam, dropping what that seam cannot express.
 *
 * Changing the event invalidates the other pickers — `turn.failed` has no
 * `message` trigger and no `block` — and leaving one showing a value its seam
 * rejects is how someone saves a rule that is stored, evaluated, and silently
 * does nothing. Each falls back to the first thing the new seam accepts, which
 * is visible in the picker rather than silent.
 *
 * Outcomes are filtered rather than reset, so a rule that says notify and fork
 * keeps both when it moves between two daemon seams. Emptying the list would be
 * saving a rule that does nothing, so a draft left with none falls back to one
 * row of whatever the new seam offers first.
 */
export function applyPreSendEventChange(
  draft: PreSendCheckDraft,
  event: string,
  descriptors: readonly PreSendOutcomeDescriptor[] = [],
): PreSendCheckDraft {
  const triggers = preSendTriggerOptions(event);
  const trigger = triggers.includes(draft.trigger) ? draft.trigger : (triggers[0] ?? draft.trigger);

  const kinds = preSendOutcomeKindOptions(event, descriptors);
  const kept = draft.outcomes.filter((outcome) => kinds.includes(outcome.kind));
  const outcomes =
    kept.length > 0 ? kept : [{ kind: kinds[0] ?? "warn", params: {} as Record<string, string> }];

  return { ...draft, event, trigger, outcomes };
}

// Symbols rather than words, so they need no translation and the sentence stays
// short enough to sit on one line in a row.
const OPERATOR_SYMBOLS: Record<string, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

// The text operators have no symbol, so they take a translated word in the
// sentence form rather than the picker's. Without these a rule read
// "message startsWith /btw" - two raw wire values in the one row a person is
// most likely to look at.
const OPERATOR_PHRASE_KEYS: Record<string, string> = {
  startsWith: "settings.preSendChecks.operatorPhrases.startsWith",
  contains: "settings.preSendChecks.operatorPhrases.contains",
};

const TRIGGER_LABEL_KEYS: Record<string, string> = {
  message: "settings.preSendChecks.triggers.message",
  always: "settings.preSendChecks.triggers.always",
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

/**
 * The row's outcome badge: one label for a list.
 *
 * The most severe outcome names it, because that is the one that decides what
 * happens, and a count carries the rest — "Block +1" rather than a badge wide
 * enough for two names, in a row that already holds a title, a message preview
 * and a host line.
 *
 * A kind the daemon runs takes its label from the descriptor where there is one
 * and falls back to the raw kind, so a rule written against a newer daemon reads
 * as something rather than as a blank.
 */
export function describePreSendCheckOutcome(
  rule: PreSendCheckRule,
  t: PreSendTranslate,
  descriptors: readonly PreSendOutcomeDescriptor[] = [],
): { label: string; isBlocking: boolean } {
  const outcomes = normalizePreSendCheckRule(rule).outcomes;
  const principal = mostSeverePreSendOutcome(outcomes);
  const described = descriptors.find((descriptor) => descriptor.kind === principal.kind);
  const name = isPlainOutcomeKind(principal.kind)
    ? t(`settings.preSendChecks.outcomeKinds.${principal.kind}`)
    : (described?.label ?? principal.kind);
  const extra = outcomes.length - 1;
  return {
    label: extra > 0 ? `${name} +${extra}` : name,
    isBlocking: principal.kind === "block",
  };
}

export function describePreSendCheck(rule: PreSendCheckRule, t: PreSendTranslate): string {
  const { trigger, value, operator } = normalizePreSendCheckRule(rule);
  const labelKey = TRIGGER_LABEL_KEYS[trigger];
  const label = labelKey ? t(labelKey) : trigger;
  const phraseKey = OPERATOR_PHRASE_KEYS[operator];
  const symbol = OPERATOR_SYMBOLS[operator] ?? (phraseKey ? t(phraseKey) : operator);
  return `${label} ${symbol} ${formatTriggerValue(trigger, value)}`;
}
