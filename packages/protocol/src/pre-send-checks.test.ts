import { describe, expect, it } from "vitest";

import type { PreSendCheckRule } from "./messages.js";
import {
  DEFAULT_PRE_SEND_CHECKS,
  evaluatePreSendChecks,
  resolvePreSendChecks,
  type PreSendMeasurementContext,
} from "./pre-send-checks.js";

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    idleSeconds: null,
    contextUsedPercent: null,
    sessionCostUsd: null,
    ...overrides,
  };
}

function rule(overrides: Partial<PreSendCheckRule> = {}): PreSendCheckRule {
  return {
    id: "test-rule",
    measurement: "agent.idleSeconds",
    operator: "gte",
    threshold: 100,
    disposition: "block",
    ...overrides,
  };
}

describe("resolvePreSendChecks", () => {
  it("returns the defaults when no rules are configured", () => {
    expect(resolvePreSendChecks(undefined)).toEqual(DEFAULT_PRE_SEND_CHECKS);
  });

  it("treats an empty array as explicitly no rules", () => {
    expect(resolvePreSendChecks([])).toEqual([]);
  });

  it("returns configured rules as given", () => {
    const configured = [rule({ id: "mine" })];
    expect(resolvePreSendChecks(configured)).toEqual(configured);
  });
});

describe("evaluatePreSendChecks operators", () => {
  const cases: Array<{
    operator: string;
    below: boolean;
    at: boolean;
    above: boolean;
  }> = [
    { operator: "gt", below: false, at: false, above: true },
    { operator: "gte", below: false, at: true, above: true },
    { operator: "lt", below: true, at: false, above: false },
    { operator: "lte", below: true, at: true, above: false },
  ];

  for (const { operator, below, at, above } of cases) {
    it(`${operator} fires below/at/above threshold as ${below}/${at}/${above}`, () => {
      const rules = [rule({ operator })];
      const fired = (idleSeconds: number) =>
        evaluatePreSendChecks(rules, context({ idleSeconds })).disposition === "block";

      expect(fired(99)).toBe(below);
      expect(fired(100)).toBe(at);
      expect(fired(101)).toBe(above);
    });
  }
});

describe("evaluatePreSendChecks measurements", () => {
  it("reads contextUsedPercent", () => {
    const rules = [rule({ measurement: "agent.contextUsedPercent", threshold: 80 })];
    expect(evaluatePreSendChecks(rules, context({ contextUsedPercent: 81 })).disposition).toBe(
      "block",
    );
    expect(evaluatePreSendChecks(rules, context({ contextUsedPercent: 79 })).disposition).toBe(
      "allow",
    );
  });

  it("reads sessionCostUsd", () => {
    const rules = [rule({ measurement: "agent.sessionCostUsd", threshold: 5 })];
    expect(evaluatePreSendChecks(rules, context({ sessionCostUsd: 5.01 })).disposition).toBe(
      "block",
    );
    expect(evaluatePreSendChecks(rules, context({ sessionCostUsd: 4.99 })).disposition).toBe(
      "allow",
    );
  });
});

describe("evaluatePreSendChecks findings", () => {
  it("reports the tripped rule with the value that tripped it", () => {
    const evaluation = evaluatePreSendChecks(
      [
        rule({
          id: "cold",
          disposition: "warn",
          message: "Idle for {{duration}}.",
        }),
      ],
      context({ idleSeconds: 250 }),
    );

    expect(evaluation.findings).toEqual([
      {
        ruleId: "cold",
        measurement: "agent.idleSeconds",
        disposition: "warn",
        value: 250,
        threshold: 100,
        message: "Idle for {{duration}}.",
      },
    ]);
  });

  it("reports a null message when the rule carries none", () => {
    const evaluation = evaluatePreSendChecks([rule()], context({ idleSeconds: 250 }));
    expect(evaluation.findings[0]?.message).toBeNull();
  });

  it("keeps findings in rule order", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "first", disposition: "warn" }), rule({ id: "second" })],
      context({ idleSeconds: 250 }),
    );
    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["first", "second"]);
  });
});

describe("evaluatePreSendChecks aggregation", () => {
  it("allows with no findings when nothing trips", () => {
    const evaluation = evaluatePreSendChecks([rule()], context({ idleSeconds: 1 }));
    expect(evaluation).toEqual({ disposition: "allow", findings: [] });
  });

  it("warns when only warn rules trip", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ disposition: "warn" })],
      context({ idleSeconds: 250 }),
    );
    expect(evaluation.disposition).toBe("warn");
  });

  it("blocks when a block rule trips after a warn rule", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "a", disposition: "warn" }), rule({ id: "b", disposition: "block" })],
      context({ idleSeconds: 250 }),
    );
    expect(evaluation.disposition).toBe("block");
  });

  it("blocks when a block rule trips before a warn rule", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "a", disposition: "block" }), rule({ id: "b", disposition: "warn" })],
      context({ idleSeconds: 250 }),
    );
    expect(evaluation.disposition).toBe("block");
  });
});

// Every one of these is a rule the evaluator cannot read. It must cost that rule
// and let the send through, rather than blocking on a config it does not
// understand.
describe("evaluatePreSendChecks fails open", () => {
  const tripping = context({ idleSeconds: 250 });

  const unreadable: Array<[string, PreSendCheckRule, PreSendMeasurementContext]> = [
    ["unknown measurement", rule({ measurement: "agent.phaseOfMoon" }), tripping],
    ["unknown operator", rule({ operator: "grt" }), tripping],
    ["unknown disposition", rule({ disposition: "explode" }), tripping],
    ["non-finite threshold", rule({ threshold: Number.NaN }), tripping],
    ["non-numeric threshold", rule({ threshold: "100" as unknown as number }), tripping],
    ["unmeasured value", rule(), context()],
    ["non-finite value", rule(), context({ idleSeconds: Number.NaN })],
  ];

  for (const [name, unreadableRule, measurements] of unreadable) {
    it(`skips a rule with an ${name}`, () => {
      expect(evaluatePreSendChecks([unreadableRule], measurements)).toEqual({
        disposition: "allow",
        findings: [],
      });
    });
  }

  it("does not let an unreadable rule suppress a later valid one", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "bad", measurement: "agent.phaseOfMoon" }), rule({ id: "good" })],
      tripping,
    );
    expect(evaluation.disposition).toBe("block");
    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["good"]);
  });

  it("allows an empty rule list", () => {
    expect(evaluatePreSendChecks([], tripping)).toEqual({
      disposition: "allow",
      findings: [],
    });
  });
});

describe("the seeded cold-prompt-cache rule", () => {
  it("allows a send one second short of an hour idle", () => {
    const evaluation = evaluatePreSendChecks(
      DEFAULT_PRE_SEND_CHECKS,
      context({ idleSeconds: 3599 }),
    );
    expect(evaluation.disposition).toBe("allow");
  });

  it("blocks a send at exactly an hour idle", () => {
    const evaluation = evaluatePreSendChecks(
      DEFAULT_PRE_SEND_CHECKS,
      context({ idleSeconds: 3600 }),
    );
    expect(evaluation.disposition).toBe("block");
    expect(evaluation.findings[0]?.ruleId).toBe("cold-prompt-cache");
  });

  it("does not fire on an agent whose idle time is unknown", () => {
    expect(evaluatePreSendChecks(DEFAULT_PRE_SEND_CHECKS, context()).disposition).toBe("allow");
  });
});
