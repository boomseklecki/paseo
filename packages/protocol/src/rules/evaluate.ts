import {
  isNumericTrigger,
  isRuleRunnableOutcomeKind,
  isTextTrigger,
  ruleOutcomeWording,
  RULE_ALWAYS_TRIGGER,
} from "./types.js";
import type {
  Rule,
  RuleDisposition,
  RuleEvaluation,
  RuleFinding,
  RuleMeasurementContext,
  RuleNumericOperator,
  RuleTextOperator,
} from "./types.js";
import { DEFAULT_RULE_EVENT, normalizeRule, type NormalizedRule } from "./vocabulary.js";
import { isOutcomeValidForEvent, rulesForRuleEvent } from "./events.js";
import type { RuleOutcome } from "./types.js";

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
const COMPARATORS: Record<RuleNumericOperator, Comparator> = {
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
const TEXT_COMPARATORS: Record<RuleTextOperator, TextComparator> = {
  startsWith: (value, operand) => value.trimStart().toLowerCase().startsWith(operand.toLowerCase()),
  contains: (value, operand) => value.toLowerCase().includes(operand.toLowerCase()),
};

const TEXT_COMPARATORS_BY_NAME = TEXT_COMPARATORS as Record<string, TextComparator | undefined>;

// An action outranks a block because it does not send the message at all: it
// takes the text somewhere else, so the reasons to hold a send back have nothing
// left to act on. An aside is also the one thing that should still work when the
// agent is in the state the other rules are complaining about.
const SEVERITY: Record<RuleDisposition, number> = {
  allow: 0,
  warn: 1,
  block: 2,
  redirect: 3,
};

/**
 * The measured value for a trigger, if the caller could measure it.
 *
 * A lookup where there was a switch. The switch's `default` was the only thing
 * making an unknown trigger skip rather than throw, and it was invisible: a
 * trigger added to `RULE_TRIGGERS` fell into it silently. A missing key does
 * the same job now, and `RULE_TRIGGER_UNITS` is what makes forgetting one a
 * type error instead.
 *
 * Type-guarded rather than cast: the map holds `number | string | null` because
 * one of the triggers is text, so a numeric rule has to check what it got. A
 * string here is a rule comparing a message with `gte`, which is a rule that
 * should not fire rather than one that should throw.
 */
function readNumericTrigger(
  trigger: string,
  context: RuleMeasurementContext,
): number | null | undefined {
  // Gated on the unit table, not merely on the key being absent. A bare lookup
  // would read whatever a caller happened to put under an unknown name, which
  // quietly turns "this build does not know that trigger" into "it works if
  // someone supplies it". The switch this replaced refused outright, and that is
  // the behaviour worth keeping: a rule from a newer daemon should cost that
  // rule, not act on a value nothing here understands.
  if (!isNumericTrigger(trigger)) {
    return undefined;
  }
  const value = (context as Record<string, number | string | null | undefined>)[trigger];
  if (value === undefined || value === null) {
    return value;
  }
  return typeof value === "number" ? value : undefined;
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
function readOutcomeDisposition(kind: string): RuleFinding["disposition"] | null {
  if (kind === "warn" || kind === "block") {
    return kind;
  }
  return isRuleRunnableOutcomeKind(kind) ? "redirect" : null;
}

/**
 * The rule's outcomes that this seam can carry out, each with its severity.
 *
 * Filtered one at a time rather than all-or-nothing. A rule asking for `warn`
 * beside a kind this build has never heard of should still warn — dropping the
 * whole rule would mean an app one version ahead silently disarms a rule on
 * every older host it is assigned to, and the half it understands was the half
 * a person could see in their own editor.
 */
function readableOutcomes(
  rule: NormalizedRule,
): { outcome: RuleOutcome; disposition: RuleFinding["disposition"] }[] {
  const readable: { outcome: RuleOutcome; disposition: RuleFinding["disposition"] }[] = [];
  for (const outcome of rule.outcomes) {
    const disposition = readOutcomeDisposition(outcome.kind);
    if (disposition) {
      readable.push({ outcome, disposition });
    }
  }
  return readable;
}

function evaluateRule(rule: NormalizedRule, context: RuleMeasurementContext): RuleFinding | null {
  if (!rule.enabled) {
    return null;
  }
  const readable = readableOutcomes(rule);
  if (readable.length === 0) {
    return null;
  }
  const tripped = tripRule(rule, context);
  if (!tripped) {
    return null;
  }
  // One rule, one disposition: the composer holds or releases a send once, so
  // what a rule asking for both a `warn` and an `aside` means for the send is
  // whichever of them decides the most. The list below keeps both, so the toast
  // can still say what the warning said.
  const disposition = readable.reduce(
    (worst, candidate) =>
      SEVERITY[candidate.disposition] > SEVERITY[worst] ? candidate.disposition : worst,
    readable[0]?.disposition ?? "warn",
  );
  // The sentence belongs to the outcome that decided the disposition, because
  // that is the outcome the person will see the result of. `rule.message` behind
  // it is the retiring rule-level field, kept readable so a rule written before
  // wording moved still says what its author wrote.
  const deciding = readable.find((candidate) => candidate.disposition === disposition);
  return {
    ruleId: rule.id,
    trigger: rule.trigger,
    disposition,
    value: tripped.value,
    operand: tripped.operand,
    message: (deciding && ruleOutcomeWording(deciding.outcome)) ?? rule.message ?? null,
    outcomes: readable.map((candidate) => candidate.outcome),
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
function tripRule(rule: NormalizedRule, context: RuleMeasurementContext): TrippedComparison | null {
  // The trigger with no comparison in it: the event was the condition, so there
  // is nothing to read and nothing to compare. Reported as itself on both sides
  // rather than as an empty value, so a message interpolating {{value}} says
  // something rather than nothing.
  if (rule.trigger === RULE_ALWAYS_TRIGGER) {
    return { value: RULE_ALWAYS_TRIGGER, operand: RULE_ALWAYS_TRIGGER };
  }
  return isTextTrigger(rule.trigger)
    ? evaluateTextRule(rule, context)
    : evaluateNumericRule(rule, context);
}

function evaluateNumericRule(
  rule: NormalizedRule,
  context: RuleMeasurementContext,
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
  rule: NormalizedRule,
  context: RuleMeasurementContext,
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

/** The measured text for a trigger. Same gate as the numeric read, other type. */
function readTextTrigger(trigger: string, context: RuleMeasurementContext): string | undefined {
  if (!isTextTrigger(trigger)) {
    return undefined;
  }
  const value = (context as Record<string, number | string | null | undefined>)[trigger];
  return typeof value === "string" ? value : undefined;
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
export function evaluateRules(
  rules: readonly Rule[],
  context: RuleMeasurementContext,
): RuleEvaluation {
  const unordered: RuleFinding[] = [];

  // Only the seam this function is named after. A `turn.failed` rule evaluated
  // here would hold a send over a condition about a turn that already failed.
  for (const rule of rulesForRuleEvent(rules, DEFAULT_RULE_EVENT)) {
    const finding = evaluateRule(normalizeRule(rule), context);
    if (finding) {
      unordered.push(finding);
    }
  }

  // A redirect consumes the message, so two of them matching is one message and
  // two destinations. The list is already in the order someone arranged, and
  // ordering has meant nothing but tidiness until now — this is where it earns
  // its keep, because "the first one you put in the list" is an answer a person
  // can predict and act on, where "whichever the loop reached first" is not.
  const findings = evaluateRuleEventOrder(unordered, rules);

  const disposition = findings.reduce<RuleDisposition>(
    (worst, finding) =>
      SEVERITY[finding.disposition] > SEVERITY[worst] ? finding.disposition : worst,
    "allow",
  );

  return { disposition, findings };
}

/**
 * The one outcome that gets the message, across every rule that tripped.
 *
 * A send goes one place, so somewhere this has to be decided, and the findings
 * arrive already in the arrangement someone chose — so "the first one you put in
 * the list" is the answer, which is one a person can predict and act on. Within
 * a rule it is the first outcome for the same reason.
 *
 * `null` when nothing tripped asked for a runner, which is every `warn`-only
 * evaluation and is not a failure.
 */
export function firstRunnableRuleOutcome(findings: readonly RuleFinding[]): RuleOutcome | null {
  for (const finding of findings) {
    for (const outcome of finding.outcomes) {
      if (isRuleRunnableOutcomeKind(outcome.kind)) {
        return outcome;
      }
    }
  }
  return null;
}

/**
 * What one rule asked for at a daemon-side seam.
 *
 * Deliberately not a `RuleFinding`: that carries a `disposition`, which is
 * the composer's three-way severity and means nothing where there is no send to
 * warn about or hold. What a daemon-side rule produces is the outcome itself.
 */
export interface RuleEventFinding {
  ruleId: string;
  trigger: string;
  value: number | string;
  operand: number | string;
  /** The rule's own message, raw and uninterpolated. */
  message: string | null;
  /**
   * Every outcome this seam accepts, in the order the rule listed them.
   *
   * All of them run, and none of them competes: nothing is being held back at a
   * daemon seam, so a rule that says notify me and write the handoff means both,
   * and the caller does both in order. That is the difference from the composer,
   * where one message can only go one place.
   */
  outcomes: readonly RuleOutcome[];
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
export function evaluateRuleEvent(
  rules: readonly Rule[],
  event: string,
  context: RuleMeasurementContext,
): RuleEventFinding[] {
  const findings: RuleEventFinding[] = [];

  for (const rule of rulesForRuleEvent(rules, event)) {
    const normalized = normalizeRule(rule);
    if (!normalized.enabled) {
      continue;
    }
    // Per outcome, not per rule: a rule asking to notify and to block at
    // `turn.failed` notifies, because the half the seam refuses is no reason to
    // drop the half it accepts.
    const outcomes = normalized.outcomes.filter((outcome) =>
      isOutcomeValidForEvent(event, outcome.kind),
    );
    if (outcomes.length === 0) {
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
      outcomes,
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
function evaluateRuleEventOrder(
  findings: readonly RuleFinding[],
  rules: readonly Rule[],
): RuleFinding[] {
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
