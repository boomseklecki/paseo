import { isTextTrigger, mostSevereRuleOutcome } from "./types.js";
import type { Rule, RuleOutcome } from "./types.js";

/**
 * COMPAT(ruleVocabulary): added in v0.3.2, remove after 2027-02-10 once
 * daemon floor >= v0.3.2.
 *
 * Rules were first written in a vocabulary that grew wrong as the feature did.
 * `measurement` described a message prefix, which measures nothing. `threshold`
 * and `text` were one operand pretending to be two fields, never both set.
 * `disposition` and `action` were one outcome pretending to be two, and could
 * contradict each other. And `action` collided with a bare verb enum in
 * twenty-one other protocol files. Then the one outcome became `outcomes`,
 * because a condition worth writing down usually deserves more than one answer.
 *
 * WebSocket schemas are append-only (`docs/architecture.md`), so the rename is
 * not a rename: the new names were added optional, the old ones stay required
 * and are written as projections of the new, and every reader prefers the new.
 * That is the `directories → entries` shape, and it means a rule written by
 * either version is read correctly by both.
 *
 * Everything that reads a rule goes through `normalizeRule` and
 * everything that writes one goes through `projectRule`. When the
 * COMPAT window closes, the old fields come off the schema and the projector
 * loses its second half; the normaliser loses its fallbacks. Nothing else moves.
 */

/** A rule in one vocabulary, with every fallback already applied. */
export interface NormalizedRule {
  id: string;
  /** Which seam. `message.send` when the rule does not say, which is what every rule predating the field meant. */
  event: string;
  trigger: string;
  operator: string;
  /** `undefined` for a rule that named no operand, which the evaluator skips. */
  value: string | number | undefined;
  /** Never empty: a rule that named none reads as one, from whichever field carried it. */
  outcomes: readonly RuleOutcome[];
  message: string | undefined;
  order: number | undefined;
  enabled: boolean;
}

export const DEFAULT_RULE_EVENT = "message.send";

/**
 * Reads a rule written in either vocabulary.
 *
 * New wins over old wherever both are present, which is the rule for every
 * projection in this codebase: the old field is a copy kept for older readers,
 * so a disagreement means the writer knew about the new one and something
 * downgraded the copy.
 */
export function normalizeRule(rule: Rule): NormalizedRule {
  const trigger = rule.trigger ?? rule.measurement;
  return {
    id: rule.id,
    event: rule.event ?? DEFAULT_RULE_EVENT,
    trigger,
    operator: rule.operator,
    value: readValue(rule, trigger),
    outcomes: readOutcomes(rule),
    message: rule.message,
    // Explicitly `false`, not falsy: absent means enabled, so a rule that
    // predates the field or was written by hand is live without saying so.
    enabled: rule.enabled !== false,
    order: rule.order,
  };
}

function readValue(rule: Rule, trigger: string): string | number | undefined {
  if (rule.value !== undefined) {
    return rule.value;
  }
  // The old pair needed the trigger to say which half to read, which is the
  // lookup the single `value` field exists to remove.
  return isTextTrigger(trigger) ? rule.text : rule.threshold;
}

/**
 * The outcomes, from whichever vocabulary carried them.
 *
 * Three tiers, newest first, and each is what the one below it grew out of. An
 * empty `outcomes` array is treated as absent rather than as "this rule asks for
 * nothing": a rule that reached disk with an empty list was written by something
 * broken, and reading its older fields is more likely to recover what was meant
 * than reporting a rule that fires and does nothing.
 *
 * `redirect` is the one word with no counterpart: it meant "the action field
 * says where", so it resolves to that action's kind. A `redirect` naming no
 * action resolves to a kind of `redirect`, which no build can perform and the
 * evaluator therefore skips — which is the same refusal the old
 * `readRuleDisposition` made, arrived at without a special case.
 */
function readOutcomes(rule: Rule): readonly RuleOutcome[] {
  if (rule.outcomes && rule.outcomes.length > 0) {
    return rule.outcomes;
  }
  if (rule.outcome) {
    return [rule.outcome];
  }
  if (rule.disposition === "redirect" && rule.action) {
    return [rule.action];
  }
  return [{ kind: rule.disposition }];
}

/**
 * Writes a rule in every vocabulary.
 *
 * The old half is what an older client reads, and it is required rather than
 * optional precisely so that half can never be forgotten: a rule missing it
 * fails to parse here rather than arriving somewhere older as a rule with no
 * measurement at all.
 *
 * The three older outcome fields all take the *most severe* entry rather than
 * the first. A reader that can carry out only one of them should carry out the
 * one that decides what happens to the message — a client seeing `warn` where
 * the rule also said `aside` would send a message this build would have
 * redirected, which is the one disagreement between versions worth avoiding.
 */
export function projectRule(rule: NormalizedRule): Rule {
  const principal = mostSevereRuleOutcome(rule.outcomes);
  const isAction = principal.kind !== "warn" && principal.kind !== "block";
  return {
    id: rule.id,
    event: rule.event,
    trigger: rule.trigger,
    measurement: rule.trigger,
    operator: rule.operator,
    value: rule.value,
    // By type rather than by looking the trigger up: a text operand is a string
    // and a numeric one is a number, so the value says which field it is.
    ...(typeof rule.value === "string" ? { text: rule.value } : {}),
    ...(typeof rule.value === "number" ? { threshold: rule.value } : {}),
    outcomes: [...rule.outcomes],
    outcome: principal,
    disposition: isAction ? "redirect" : principal.kind,
    ...(isAction ? { action: principal } : {}),
    ...(rule.message === undefined ? {} : { message: rule.message }),
    ...(rule.order === undefined ? {} : { order: rule.order }),
    // Absent means enabled, so only an explicit off is written. A rule that
    // always wrote `enabled: true` would be noise in every hand-edited file.
    ...(rule.enabled ? {} : { enabled: false }),
  };
}
