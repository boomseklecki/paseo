import type {
  PreSendCheckRule,
  PreSendDisposition,
  PreSendEvaluation,
  PreSendFinding,
  PreSendMeasurementContext,
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
