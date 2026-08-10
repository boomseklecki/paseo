import type { PreSendCheckRule } from "./messages.js";

/**
 * Rules the composer evaluates against the current agent before a message
 * leaves the input box. Each is a measurement compared to a threshold, yielding
 * a disposition: `warn` toasts and sends anyway, `block` toasts and holds the
 * send so the typed text survives.
 *
 * This module owns what a rule means. It is deliberately pure and string-free:
 * the app supplies the measured values and renders the outcome, so nothing here
 * needs a clock, a locale, or a store.
 */

/** Measurements a rule may name. Unknown values are skipped, not rejected. */
export const PRE_SEND_MEASUREMENTS = [
  "agent.idleSeconds",
  "agent.contextUsedPercent",
  "agent.sessionCostUsd",
] as const;

export type PreSendMeasurement = (typeof PRE_SEND_MEASUREMENTS)[number];

/**
 * The measured values, assembled by the caller at send time. `null` means the
 * value is unknown right now — no usage reported yet, no timeline loaded, no
 * agent — and any rule reading a `null` is skipped rather than guessed at.
 */
export interface PreSendMeasurementContext {
  /**
   * Seconds since the agent last did anything, measured from the end of its
   * last turn. That is when a provider-side prompt cache was written, which is
   * what makes it the right clock for a staleness rule.
   */
  idleSeconds: number | null;
  /** Context window consumed, 0-100. */
  contextUsedPercent: number | null;
  /** Cumulative cost of this agent's session, in USD. */
  sessionCostUsd: number | null;
}

export type PreSendDisposition = "allow" | "warn" | "block";

export interface PreSendFinding {
  ruleId: string;
  measurement: string;
  disposition: "warn" | "block";
  /** The measured value that tripped the rule. */
  value: number;
  threshold: number;
  /** The rule's own message, raw and uninterpolated. `null` falls back to a translated default. */
  message: string | null;
}

export interface PreSendEvaluation {
  /** The most severe finding's disposition; `allow` when nothing tripped. */
  disposition: PreSendDisposition;
  /** Every rule that tripped, in rule order. */
  findings: readonly PreSendFinding[];
}

/**
 * One hour is the longest TTL the Anthropic prompt-caching API offers
 * (`{"type":"ephemeral","ttl":"1h"}`), so past it the cache is cold under any
 * configuration and the next turn reprocesses the whole prefix. A shorter
 * threshold would be right only under the default 5-minute TTL and would fire
 * during ordinary think-time — noise that teaches people to ignore a block.
 *
 * No `message`, so the shipped rule renders through the translated fallback
 * while a hand-written rule keeps its author's own wording.
 */
export const DEFAULT_PRE_SEND_CHECKS: readonly PreSendCheckRule[] = [
  {
    id: "cold-prompt-cache",
    measurement: "agent.idleSeconds",
    operator: "gte",
    threshold: 3600,
    disposition: "block",
  },
];

/**
 * Absent config means the defaults; an empty array means the user turned every
 * rule off. Those are different states and only an explicit `[]` is silence.
 *
 * Until a settings screen lands, rules are hand-written into `config.json`, and
 * that has to happen against a **stopped** daemon. `DaemonConfigStore` holds its
 * own copy and never re-reads the file, so an edit made while it runs reaches
 * nobody — and the next write of any unrelated field persists the stale copy
 * back over it, silently. The same is true of `terminalProfiles`; it bites
 * harder here only because hand-editing is currently the whole UX.
 */
export function resolvePreSendChecks(
  preSendChecks: PreSendCheckRule[] | undefined,
): readonly PreSendCheckRule[] {
  if (preSendChecks === undefined) {
    return DEFAULT_PRE_SEND_CHECKS;
  }
  return preSendChecks;
}

const COMPARATORS: Record<string, (value: number, threshold: number) => boolean> = {
  gt: (value, threshold) => value > threshold,
  gte: (value, threshold) => value >= threshold,
  lt: (value, threshold) => value < threshold,
  lte: (value, threshold) => value <= threshold,
};

const SEVERITY: Record<PreSendDisposition, number> = {
  allow: 0,
  warn: 1,
  block: 2,
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
    if (rule.disposition !== "warn" && rule.disposition !== "block") {
      continue;
    }
    const compare = COMPARATORS[rule.operator];
    if (!compare) {
      continue;
    }
    if (typeof rule.threshold !== "number" || !Number.isFinite(rule.threshold)) {
      continue;
    }
    const value = readMeasurement(rule.measurement, context);
    if (value === undefined || value === null || !Number.isFinite(value)) {
      continue;
    }
    if (!compare(value, rule.threshold)) {
      continue;
    }
    findings.push({
      ruleId: rule.id,
      measurement: rule.measurement,
      disposition: rule.disposition,
      value,
      threshold: rule.threshold,
      message: rule.message ?? null,
    });
  }

  const disposition = findings.reduce<PreSendDisposition>(
    (worst, finding) =>
      SEVERITY[finding.disposition] > SEVERITY[worst] ? finding.disposition : worst,
    "allow",
  );

  return { disposition, findings };
}
