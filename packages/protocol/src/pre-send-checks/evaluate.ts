import { isTextMeasurement, PRE_SEND_ACTION_KINDS } from "./types.js";
import type {
  PreSendCheckRule,
  PreSendDisposition,
  PreSendEvaluation,
  PreSendFinding,
  PreSendMeasurementContext,
  PreSendNumericOperator,
  PreSendTextOperator,
} from "./types.js";

/**
 * What a rule means. Deliberately pure and string-free: the app supplies the
 * measured values and renders the outcome, so nothing here needs a clock, a
 * locale, or a store.
 *
 * There is no `resolve` step and no default rule in this package on purpose. The
 * daemon seeds its defaults as real files and always serves a concrete list, so a
 * caller holding `undefined` knows only that it has not loaded the rules yet — and
 * must allow the send. Keeping a default here would put a blocking rule one `??`
 * away from that path, which is the failure this arrangement exists to prevent.
 */

type Comparator = (value: number, threshold: number) => boolean;
type TextComparator = (value: string, operand: string) => boolean;

// Keyed by the exported operator list rather than by `string`, so adding an
// operator there without one here is a type error rather than a rule that
// silently never fires. The lookup below widens back to `string`, because
// `rule.operator` is whatever was on disk.
const COMPARATORS: Record<PreSendNumericOperator, Comparator> = {
  gt: (value, threshold) => value > threshold,
  gte: (value, threshold) => value >= threshold,
  lt: (value, threshold) => value < threshold,
  lte: (value, threshold) => value <= threshold,
};

const COMPARATORS_BY_NAME = COMPARATORS as Record<string, Comparator | undefined>;

/**
 * The second comparison family.
 *
 * Kept apart from the numeric one rather than unified behind a looser signature,
 * because the two do not share a threshold type and pretending they do is how a
 * text rule ends up comparing against `NaN`.
 *
 * Case-insensitive: a rule triggering on `/btw` should fire on `/BTW`, and
 * nobody typing an aside is thinking about case.
 */
const TEXT_COMPARATORS: Record<PreSendTextOperator, TextComparator> = {
  startsWith: (value, operand) => value.trimStart().toLowerCase().startsWith(operand.toLowerCase()),
  contains: (value, operand) => value.toLowerCase().includes(operand.toLowerCase()),
};

const TEXT_COMPARATORS_BY_NAME = TEXT_COMPARATORS as Record<string, TextComparator | undefined>;

// A redirect outranks a block because it does not send the message at all: it
// takes the text somewhere else, so the reasons to hold a send back have nothing
// left to act on. An aside is also the one thing that should still work when the
// agent is in the state the other rules are complaining about.
const SEVERITY: Record<PreSendDisposition, number> = {
  allow: 0,
  warn: 1,
  block: 2,
  redirect: 3,
};

function readMeasurement(
  measurement: string,
  context: PreSendMeasurementContext,
): number | null | undefined {
  switch (measurement) {
    case "agent.idleSeconds":
      return context.idleSeconds;
    case "agent.contextUsedPercent":
      return context.contextUsedPercent;
    case "agent.sessionCostUsd":
      return context.sessionCostUsd;
    default:
      return undefined;
  }
}

/**
 * A rule's disposition, or `null` if it is not one a rule may carry.
 *
 * A `redirect` naming an action this build cannot carry out is refused here
 * rather than reported and declined later. That direction matters: a redirect
 * consumes the message instead of sending it, so an unrecognised one that still
 * counted as a finding would swallow what you typed on the way to a destination
 * that does not exist. Failing back to an ordinary send is the safe miss.
 */
function readRuleDisposition(rule: PreSendCheckRule): PreSendFinding["disposition"] | null {
  if (rule.disposition === "warn" || rule.disposition === "block") {
    return rule.disposition;
  }
  if (rule.disposition !== "redirect") {
    return null;
  }
  const kind = rule.action?.kind;
  return kind && (PRE_SEND_ACTION_KINDS as readonly string[]).includes(kind) ? "redirect" : null;
}

function evaluateRule(
  rule: PreSendCheckRule,
  context: PreSendMeasurementContext,
): PreSendFinding | null {
  // Explicitly `false`, not falsy: absent means enabled, so a rule that predates
  // the field or was written by hand is live without saying so.
  if (rule.enabled === false) {
    return null;
  }
  const disposition = readRuleDisposition(rule);
  if (!disposition) {
    return null;
  }
  const tripped = isTextMeasurement(rule.measurement)
    ? evaluateTextRule(rule, context)
    : evaluateNumericRule(rule, context);
  if (!tripped) {
    return null;
  }
  return {
    ruleId: rule.id,
    measurement: rule.measurement,
    disposition,
    value: tripped.value,
    threshold: tripped.threshold,
    message: rule.message ?? null,
    action: disposition === "redirect" ? (rule.action ?? null) : null,
  };
}

interface TrippedComparison {
  value: number | string;
  threshold: number | string;
}

function evaluateNumericRule(
  rule: PreSendCheckRule,
  context: PreSendMeasurementContext,
): TrippedComparison | null {
  const compare = COMPARATORS_BY_NAME[rule.operator];
  if (!compare) {
    return null;
  }
  if (typeof rule.threshold !== "number" || !Number.isFinite(rule.threshold)) {
    return null;
  }
  const value = readMeasurement(rule.measurement, context);
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return null;
  }
  return compare(value, rule.threshold) ? { value, threshold: rule.threshold } : null;
}

function evaluateTextRule(
  rule: PreSendCheckRule,
  context: PreSendMeasurementContext,
): TrippedComparison | null {
  const compare = TEXT_COMPARATORS_BY_NAME[rule.operator];
  if (!compare) {
    return null;
  }
  // An empty operand would match every message, which for a redirect means every
  // send disappearing into an aside. A rule that says nothing matches nothing.
  if (typeof rule.text !== "string" || rule.text.length === 0) {
    return null;
  }
  const value = readTextMeasurement(rule.measurement, context);
  if (value === undefined) {
    return null;
  }
  return compare(value, rule.text) ? { value, threshold: rule.text } : null;
}

function readTextMeasurement(
  measurement: string,
  context: PreSendMeasurementContext,
): string | undefined {
  return measurement === "message" ? context.message : undefined;
}

/**
 * Evaluates every rule and reports what tripped.
 *
 * Skips rather than throws on anything it cannot read — an unrecognised
 * measurement, operator or disposition, a non-finite threshold, or a value the
 * caller could not measure. A rule list is hand-edited JSON that also arrives
 * from daemons of other versions, so one unreadable entry must cost that entry
 * and nothing else. Failing open is the deliberate direction: a gate that
 * blocks because it could not read its own config is worse than one that
 * occasionally misses.
 */
export function evaluatePreSendChecks(
  rules: readonly PreSendCheckRule[],
  context: PreSendMeasurementContext,
): PreSendEvaluation {
  const findings: PreSendFinding[] = [];

  for (const rule of rules) {
    const finding = evaluateRule(rule, context);
    if (finding) {
      findings.push(finding);
    }
  }

  const disposition = findings.reduce<PreSendDisposition>(
    (worst, finding) =>
      SEVERITY[finding.disposition] > SEVERITY[worst] ? finding.disposition : worst,
    "allow",
  );

  return { disposition, findings };
}
