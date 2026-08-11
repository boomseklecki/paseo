import { isTextTrigger } from "./types.js";
import type { PreSendCheckRule, PreSendOutcome } from "./types.js";

/**
 * COMPAT(preSendCheckVocabulary): added in v0.3.2, remove after 2027-02-10 once
 * daemon floor >= v0.3.2.
 *
 * Rules were first written in a vocabulary that grew wrong as the feature did.
 * `measurement` described a message prefix, which measures nothing. `threshold`
 * and `text` were one operand pretending to be two fields, never both set.
 * `disposition` and `action` were one outcome pretending to be two, and could
 * contradict each other. And `action` collided with a bare verb enum in
 * twenty-one other protocol files.
 *
 * WebSocket schemas are append-only (`docs/architecture.md`), so the rename is
 * not a rename: the new names were added optional, the old ones stay required
 * and are written as projections of the new, and every reader prefers the new.
 * That is the `directories → entries` shape, and it means a rule written by
 * either version is read correctly by both.
 *
 * Everything that reads a rule goes through `normalizePreSendCheckRule` and
 * everything that writes one goes through `projectPreSendCheckRule`. When the
 * COMPAT window closes, the old fields come off the schema and the projector
 * loses its second half; the normaliser loses its fallbacks. Nothing else moves.
 */

/** A rule in one vocabulary, with every fallback already applied. */
export interface NormalizedPreSendCheckRule {
  id: string;
  /** Which seam. `message.send` when the rule does not say, which is what every rule predating the field meant. */
  event: string;
  trigger: string;
  operator: string;
  /** `undefined` for a rule that named no operand, which the evaluator skips. */
  value: string | number | undefined;
  outcome: PreSendOutcome;
  message: string | undefined;
  order: number | undefined;
  enabled: boolean;
}

export const DEFAULT_PRE_SEND_EVENT = "message.send";

/**
 * Reads a rule written in either vocabulary.
 *
 * New wins over old wherever both are present, which is the rule for every
 * projection in this codebase: the old field is a copy kept for older readers,
 * so a disagreement means the writer knew about the new one and something
 * downgraded the copy.
 */
export function normalizePreSendCheckRule(rule: PreSendCheckRule): NormalizedPreSendCheckRule {
  const trigger = rule.trigger ?? rule.measurement;
  return {
    id: rule.id,
    event: rule.event ?? DEFAULT_PRE_SEND_EVENT,
    trigger,
    operator: rule.operator,
    value: readValue(rule, trigger),
    outcome: readOutcome(rule),
    message: rule.message,
    // Explicitly `false`, not falsy: absent means enabled, so a rule that
    // predates the field or was written by hand is live without saying so.
    enabled: rule.enabled !== false,
    order: rule.order,
  };
}

function readValue(rule: PreSendCheckRule, trigger: string): string | number | undefined {
  if (rule.value !== undefined) {
    return rule.value;
  }
  // The old pair needed the trigger to say which half to read, which is the
  // lookup the single `value` field exists to remove.
  return isTextTrigger(trigger) ? rule.text : rule.threshold;
}

/**
 * The outcome, from whichever vocabulary carried it.
 *
 * `redirect` is the one word with no counterpart: it meant "the action field
 * says where", so it resolves to that action's kind. A `redirect` naming no
 * action resolves to a kind of `redirect`, which no build can perform and the
 * evaluator therefore skips — which is the same refusal the old
 * `readRuleDisposition` made, arrived at without a special case.
 */
function readOutcome(rule: PreSendCheckRule): PreSendOutcome {
  if (rule.outcome) {
    return rule.outcome;
  }
  if (rule.disposition === "redirect" && rule.action) {
    return rule.action;
  }
  return { kind: rule.disposition };
}

/**
 * Writes a rule in both vocabularies.
 *
 * The old half is what an older client reads, and it is required rather than
 * optional precisely so that half can never be forgotten: a rule missing it
 * fails to parse here rather than arriving somewhere older as a rule with no
 * measurement at all.
 */
export function projectPreSendCheckRule(rule: NormalizedPreSendCheckRule): PreSendCheckRule {
  const isAction = rule.outcome.kind !== "warn" && rule.outcome.kind !== "block";
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
    outcome: rule.outcome,
    disposition: isAction ? "redirect" : rule.outcome.kind,
    ...(isAction ? { action: rule.outcome } : {}),
    ...(rule.message === undefined ? {} : { message: rule.message }),
    ...(rule.order === undefined ? {} : { order: rule.order }),
    // Absent means enabled, so only an explicit off is written. A rule that
    // always wrote `enabled: true` would be noise in every hand-edited file.
    ...(rule.enabled ? {} : { enabled: false }),
  };
}
