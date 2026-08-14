import { evaluateRules, evaluateRuleEvent } from "./evaluate.js";
import { findRuleEventDefinition } from "./events.js";
import { DEFAULT_RULE_EVENT, normalizeRule } from "./vocabulary.js";
import { isTextTrigger } from "./types.js";
import type { Rule, RuleMeasurementContext } from "./types.js";

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
export type RuleDryRunVerdict =
  | { fires: true }
  | { fires: false; because: "disabled" }
  | { fires: false; because: "unknown-event" }
  | { fires: false; because: "trigger-not-at-this-event" }
  | { fires: false; because: "outcome-not-at-this-event" }
  | { fires: false; because: "condition-false" };

export interface RuleDryRunResult {
  ruleId: string;
  event: string;
  verdict: RuleDryRunVerdict;
}

/**
 * Answers for one rule against measurements the caller supplies.
 *
 * Ordered so the most structural answer wins: a rule asking its seam for
 * something impossible is broken whether or not its condition happens to hold
 * today, and reporting "condition false" for it would send someone off adjusting
 * a threshold that was never the problem.
 */
/**
 * The half of the answer that needs no measurements.
 *
 * Separated because the two halves have different audiences. Whether a rule
 * *would* fire right now depends on an agent and changes minute to minute;
 * whether it *could ever* fire is a property of the rule alone, is always a
 * mistake when the answer is no, and can therefore be shown beside the rule in
 * a list without asking anyone to pick anything.
 *
 * It matters most for rules the editor never saw. The editor now refuses to
 * build an impossible rule, but this directory is hand-editable by design — so
 * a rule someone typed into a file naming `block` at `turn.failed` is stored,
 * evaluated, and silently does nothing, with nothing anywhere saying why.
 */
export function explainRuleStructure(
  rule: Rule,
): Exclude<RuleDryRunVerdict, { fires: true }> | null {
  const normalized = normalizeRule(rule);
  if (!normalized.enabled) {
    return { fires: false, because: "disabled" };
  }
  const definition = findRuleEventDefinition(normalized.event);
  if (!definition) {
    return { fires: false, because: "unknown-event" };
  }
  if (!definition.triggers.includes(normalized.trigger)) {
    return { fires: false, because: "trigger-not-at-this-event" };
  }
  // Only when the seam refuses *every* outcome. A rule with one the seam accepts
  // still fires, so badging it as broken would be wrong — the evaluator drops the
  // refused half and carries out the rest.
  if (!normalized.outcomes.some((outcome) => definition.outcomeKinds.includes(outcome.kind))) {
    return { fires: false, because: "outcome-not-at-this-event" };
  }
  return null;
}

/**
 * Whether a rule can never fire, as opposed to merely not firing today.
 *
 * `disabled` is excluded: a rule someone turned off is doing what they asked,
 * and badging it as broken would be telling them off for using the switch.
 */
export function ruleNeverFires(rule: Rule): boolean {
  const structural = explainRuleStructure(rule);
  return structural !== null && structural.because !== "disabled";
}

export function dryRunRule(rule: Rule, context: RuleMeasurementContext): RuleDryRunResult {
  const normalized = normalizeRule(rule);
  const event = normalized.event;
  const base = { ruleId: normalized.id, event };

  const structural = explainRuleStructure(rule);
  if (structural) {
    return { ...base, verdict: structural };
  }

  // Through the real evaluator rather than a copy of its comparison, so a dry
  // run cannot drift from what actually happens - which is the one way a
  // feature like this becomes worse than nothing.
  const fired =
    event === DEFAULT_RULE_EVENT
      ? evaluateRules([rule], context).findings.length > 0
      : evaluateRuleEvent([rule], event, context).length > 0;

  return fired
    ? { ...base, verdict: { fires: true } }
    : { ...base, verdict: { fires: false, because: "condition-false" } };
}

/** Every rule against one set of measurements, in the order they are arranged. */
export function dryRunRules(
  rules: readonly Rule[],
  context: RuleMeasurementContext,
): RuleDryRunResult[] {
  return rules.map((rule) => dryRunRule(rule, context));
}

/**
 * Tries a rule against one value someone typed, rather than against an agent.
 *
 * The interactive half, and deliberately not "run it against a live agent". The
 * question a person actually has while writing a rule is "would this match?" —
 * would `/btw hello` trip my prefix, is 3600 the number I meant — and answering
 * it from a real agent means picking one, waiting for it to be in the right
 * state, and getting an answer that changes by the minute.
 *
 * The sample goes to whichever measurement the rule reads, so one input serves
 * every trigger: text for a message rule, a number for the rest. `always` needs
 * no sample and says so by firing regardless.
 */
export function dryRunRuleSample(rule: Rule, sample: string): RuleDryRunResult {
  const { trigger } = normalizeRule(rule);
  const numeric = Number(sample.trim());
  const measured = sample.trim() === "" || !Number.isFinite(numeric) ? null : numeric;

  // One entry, for the trigger this rule actually reads. Filling every numeric
  // field with the same sample was what a field-per-trigger shape forced; keyed
  // by trigger there is nothing to fill but the key in hand.
  return dryRunRule(rule, {
    [trigger]: isTextTrigger(trigger) ? sample : measured,
  });
}
