import { evaluatePreSendChecks, evaluatePreSendEvent } from "./evaluate.js";
import { findPreSendEventDefinition } from "./events.js";
import { DEFAULT_PRE_SEND_EVENT, normalizePreSendCheckRule } from "./vocabulary.js";
import type { PreSendCheckRule, PreSendMeasurementContext } from "./types.js";

/**
 * Why a rule would or would not fire, without firing it.
 *
 * The evaluator has always been pure, so this asks it the same question the
 * real path asks and reports the answer instead of acting on it. What it adds
 * is the *reason*: "did not fire" is the same word for a rule whose condition
 * is false, one naming a trigger this build cannot read, and one asking its seam
 * for something the seam refuses — and those want three different fixes.
 *
 * The last two are the ones worth having. A rule that is simply not tripping is
 * usually working as intended; a rule that can never trip looks identical from
 * the outside and is always a mistake.
 */
export type PreSendDryRunVerdict =
  | { fires: true }
  | { fires: false; because: "disabled" }
  | { fires: false; because: "unknown-event" }
  | { fires: false; because: "trigger-not-at-this-event" }
  | { fires: false; because: "outcome-not-at-this-event" }
  | { fires: false; because: "condition-false" };

export interface PreSendDryRunResult {
  ruleId: string;
  event: string;
  verdict: PreSendDryRunVerdict;
}

/**
 * Answers for one rule against measurements the caller supplies.
 *
 * Ordered so the most structural answer wins: a rule asking its seam for
 * something impossible is broken whether or not its condition happens to hold
 * today, and reporting "condition false" for it would send someone off adjusting
 * a threshold that was never the problem.
 */
export function dryRunPreSendCheck(
  rule: PreSendCheckRule,
  context: PreSendMeasurementContext,
): PreSendDryRunResult {
  const normalized = normalizePreSendCheckRule(rule);
  const event = normalized.event;
  const base = { ruleId: normalized.id, event };

  if (!normalized.enabled) {
    return { ...base, verdict: { fires: false, because: "disabled" } };
  }

  const definition = findPreSendEventDefinition(event);
  if (!definition) {
    return { ...base, verdict: { fires: false, because: "unknown-event" } };
  }
  if (!definition.triggers.includes(normalized.trigger)) {
    return { ...base, verdict: { fires: false, because: "trigger-not-at-this-event" } };
  }
  if (!definition.outcomeKinds.includes(normalized.outcome.kind)) {
    return { ...base, verdict: { fires: false, because: "outcome-not-at-this-event" } };
  }

  // Through the real evaluator rather than a copy of its comparison, so a dry
  // run cannot drift from what actually happens - which is the one way a
  // feature like this becomes worse than nothing.
  const fired =
    event === DEFAULT_PRE_SEND_EVENT
      ? evaluatePreSendChecks([rule], context).findings.length > 0
      : evaluatePreSendEvent([rule], event, context).length > 0;

  return fired
    ? { ...base, verdict: { fires: true } }
    : { ...base, verdict: { fires: false, because: "condition-false" } };
}

/** Every rule against one set of measurements, in the order they are arranged. */
export function dryRunPreSendChecks(
  rules: readonly PreSendCheckRule[],
  context: PreSendMeasurementContext,
): PreSendDryRunResult[] {
  return rules.map((rule) => dryRunPreSendCheck(rule, context));
}
