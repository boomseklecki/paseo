import {
  isPlainOutcomeKind,
  isPreSendActionKind,
  isTextTrigger,
  PRE_SEND_ALWAYS_TRIGGER,
} from "./types.js";
import type {
  PreSendCheckRule,
  PreSendDisposition,
  PreSendEvaluation,
  PreSendFinding,
  PreSendMeasurementContext,
  PreSendNumericOperator,
  PreSendTextOperator,
} from "./types.js";
import {
  DEFAULT_PRE_SEND_EVENT,
  normalizePreSendCheckRule,
  type NormalizedPreSendCheckRule,
} from "./vocabulary.js";
import { isOutcomeValidForEvent, rulesForPreSendEvent } from "./events.js";
import type { PreSendOutcome } from "./types.js";

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

// An action outranks a block because it does not send the message at all: it
// takes the text somewhere else, so the reasons to hold a send back have nothing
// left to act on. An aside is also the one thing that should still work when the
// agent is in the state the other rules are complaining about.
const SEVERITY: Record<PreSendDisposition, number> = {
  allow: 0,
  warn: 1,
  block: 2,
  redirect: 3,
};

function readNumericTrigger(
  trigger: string,
  context: PreSendMeasurementContext,
): number | null | undefined {
  switch (trigger) {
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
 * How severe an outcome is, or `null` for one this build cannot carry out.
 *
 * An outcome kind that is neither plain nor an action this build knows is
 * refused here rather than reported and declined later. That direction matters:
 * an action consumes the message instead of sending it, so an unrecognised one
 * that still counted as a finding would swallow what you typed on the way to a
 * destination that does not exist. Failing back to an ordinary send is the safe
 * miss.
 *
 * The old shape needed this check to reconcile two fields that could disagree -
 * a `redirect` naming no action, an action sitting beside a `warn`. One outcome
 * makes that state unrepresentable, so what is left is the honest question:
 * can this build do the thing the rule asked for.
 */
function readOutcomeDisposition(kind: string): PreSendFinding["disposition"] | null {
  if (kind === "warn" || kind === "block") {
    return kind;
  }
  return isPreSendActionKind(kind) ? "redirect" : null;
}

function evaluateRule(
  rule: NormalizedPreSendCheckRule,
  context: PreSendMeasurementContext,
): PreSendFinding | null {
  if (!rule.enabled) {
    return null;
  }
  const disposition = readOutcomeDisposition(rule.outcome.kind);
  if (!disposition) {
    return null;
  }
  const tripped = tripRule(rule, context);
  if (!tripped) {
    return null;
  }
  return {
    ruleId: rule.id,
    trigger: rule.trigger,
    disposition,
    value: tripped.value,
    operand: tripped.operand,
    message: rule.message ?? null,
    outcome: isPlainOutcomeKind(rule.outcome.kind) ? null : rule.outcome,
  };
}

interface TrippedComparison {
  value: number | string;
  operand: number | string;
}

/**
 * Whether a rule's condition holds, with no opinion about what that means.
 *
 * Split out because the two sides want different things from the same answer:
 * the composer turns it into a disposition it can hold a send with, the daemon
 * into an outcome it carries out. Sharing the comparison and not the conclusion
 * is what keeps a rule meaning the same thing at either seam.
 */
function tripRule(
  rule: NormalizedPreSendCheckRule,
  context: PreSendMeasurementContext,
): TrippedComparison | null {
  // The trigger with no comparison in it: the event was the condition, so there
  // is nothing to read and nothing to compare. Reported as itself on both sides
  // rather than as an empty value, so a message interpolating {{value}} says
  // something rather than nothing.
  if (rule.trigger === PRE_SEND_ALWAYS_TRIGGER) {
    return { value: PRE_SEND_ALWAYS_TRIGGER, operand: PRE_SEND_ALWAYS_TRIGGER };
  }
  return isTextTrigger(rule.trigger)
    ? evaluateTextRule(rule, context)
    : evaluateNumericRule(rule, context);
}

function evaluateNumericRule(
  rule: NormalizedPreSendCheckRule,
  context: PreSendMeasurementContext,
): TrippedComparison | null {
  const compare = COMPARATORS_BY_NAME[rule.operator];
  if (!compare) {
    return null;
  }
  const operand = rule.value;
  if (typeof operand !== "number" || !Number.isFinite(operand)) {
    return null;
  }
  const value = readNumericTrigger(rule.trigger, context);
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return null;
  }
  return compare(value, operand) ? { value, operand } : null;
}

function evaluateTextRule(
  rule: NormalizedPreSendCheckRule,
  context: PreSendMeasurementContext,
): TrippedComparison | null {
  const compare = TEXT_COMPARATORS_BY_NAME[rule.operator];
  if (!compare) {
    return null;
  }
  // An empty operand would match every message, which for an action means every
  // send disappearing into an aside. A rule that says nothing matches nothing.
  const operand = rule.value;
  if (typeof operand !== "string" || operand.length === 0) {
    return null;
  }
  const value = readTextTrigger(rule.trigger, context);
  if (value === undefined) {
    return null;
  }
  return compare(value, operand) ? { value, operand } : null;
}

function readTextTrigger(trigger: string, context: PreSendMeasurementContext): string | undefined {
  return trigger === "message" ? context.message : undefined;
}

/**
 * Evaluates every rule and reports what tripped.
 *
 * Skips rather than throws on anything it cannot read — an unrecognised trigger,
 * operator or outcome kind, a non-finite operand, or a value the caller could
 * not measure. A rule list is hand-edited JSON that also arrives
 * from daemons of other versions, so one unreadable entry must cost that entry
 * and nothing else. Failing open is the deliberate direction: a gate that
 * blocks because it could not read its own config is worse than one that
 * occasionally misses.
 */
export function evaluatePreSendChecks(
  rules: readonly PreSendCheckRule[],
  context: PreSendMeasurementContext,
): PreSendEvaluation {
  const unordered: PreSendFinding[] = [];

  // Only the seam this function is named after. A `turn.failed` rule evaluated
  // here would hold a send over a condition about a turn that already failed.
  for (const rule of rulesForPreSendEvent(rules, DEFAULT_PRE_SEND_EVENT)) {
    const finding = evaluateRule(normalizePreSendCheckRule(rule), context);
    if (finding) {
      unordered.push(finding);
    }
  }

  // A redirect consumes the message, so two of them matching is one message and
  // two destinations. The list is already in the order someone arranged, and
  // ordering has meant nothing but tidiness until now — this is where it earns
  // its keep, because "the first one you put in the list" is an answer a person
  // can predict and act on, where "whichever the loop reached first" is not.
  const findings = evaluatePreSendEventOrder(unordered, rules);

  const disposition = findings.reduce<PreSendDisposition>(
    (worst, finding) =>
      SEVERITY[finding.disposition] > SEVERITY[worst] ? finding.disposition : worst,
    "allow",
  );

  return { disposition, findings };
}

/**
 * What one rule asked for at a daemon-side seam.
 *
 * Deliberately not a `PreSendFinding`: that carries a `disposition`, which is
 * the composer's three-way severity and means nothing where there is no send to
 * warn about or hold. What a daemon-side rule produces is the outcome itself.
 */
export interface PreSendEventFinding {
  ruleId: string;
  trigger: string;
  value: number | string;
  operand: number | string;
  /** The rule's own message, raw and uninterpolated. */
  message: string | null;
  outcome: PreSendOutcome;
}

/**
 * Evaluates the rules belonging to one daemon-side seam.
 *
 * Skips a rule whose outcome the seam cannot carry out, rather than carrying it
 * out anyway. That check duplicates what the editor already prevents, and it is
 * worth repeating: rules are hand-editable files that also arrive from newer
 * apps, so the only way a `block` reaches `turn.failed` is a route the editor
 * never travelled.
 */
export function evaluatePreSendEvent(
  rules: readonly PreSendCheckRule[],
  event: string,
  context: PreSendMeasurementContext,
): PreSendEventFinding[] {
  const findings: PreSendEventFinding[] = [];

  for (const rule of rulesForPreSendEvent(rules, event)) {
    const normalized = normalizePreSendCheckRule(rule);
    if (!normalized.enabled || !isOutcomeValidForEvent(event, normalized.outcome.kind)) {
      continue;
    }
    const tripped = tripRule(normalized, context);
    if (!tripped) {
      continue;
    }
    findings.push({
      ruleId: normalized.id,
      trigger: normalized.trigger,
      value: tripped.value,
      operand: tripped.operand,
      message: normalized.message ?? null,
      outcome: normalized.outcome,
    });
  }

  return findings;
}

/**
 * Puts findings in the arrangement someone chose.
 *
 * Only the winner of a tie needs this, and only one outcome can win: a redirect
 * takes the message somewhere, and a message goes one place. Ordering a rule
 * list has been tidiness up to now; this is the moment it decides something, so
 * a person who wants one redirect to beat another moves it up.
 *
 * A rule with no `order` sorts after every ordered one, matching how the store
 * lists them, so adding the field to some rules and not others stays
 * predictable.
 */
function evaluatePreSendEventOrder(
  findings: readonly PreSendFinding[],
  rules: readonly PreSendCheckRule[],
): PreSendFinding[] {
  const orderById = new Map(
    rules.map((rule) => [rule.id, rule.order ?? Number.POSITIVE_INFINITY] as const),
  );
  return [...findings].sort((left, right) => {
    const leftOrder = orderById.get(left.ruleId) ?? Number.POSITIVE_INFINITY;
    const rightOrder = orderById.get(right.ruleId) ?? Number.POSITIVE_INFINITY;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.ruleId.localeCompare(right.ruleId);
  });
}
