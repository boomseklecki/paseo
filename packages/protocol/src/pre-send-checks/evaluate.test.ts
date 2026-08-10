import { describe, expect, it } from "vitest";

import { evaluatePreSendChecks } from "./evaluate.js";
import type { PreSendCheckRule, PreSendMeasurementContext } from "./types.js";

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    idleSeconds: null,
    contextUsedPercent: null,
    sessionCostUsd: null,
    message: "",
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
        action: null,
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

// The three cases that pinned the shipped cold-prompt-cache rule moved to the
// server's seeder test, where they now assert against the file the daemon actually
// writes rather than a constant this package no longer owns.

function trigger(overrides: Partial<PreSendCheckRule> = {}): PreSendCheckRule {
  return {
    id: "aside",
    measurement: "message",
    operator: "startsWith",
    text: "/btw",
    disposition: "redirect",
    action: { kind: "aside" },
    ...overrides,
  };
}

describe("text triggers", () => {
  it("fires on a message that starts with the trigger", () => {
    const evaluation = evaluatePreSendChecks(
      [trigger()],
      context({ message: "/btw what is this" }),
    );
    expect(evaluation.disposition).toBe("redirect");
    expect(evaluation.findings[0]?.action).toEqual({ kind: "aside" });
    expect(evaluation.findings[0]?.value).toBe("/btw what is this");
  });

  it("ignores leading whitespace and case", () => {
    expect(
      evaluatePreSendChecks([trigger()], context({ message: "  /BTW quick one" })).disposition,
    ).toBe("redirect");
  });

  // Anchored on purpose: a message merely mentioning the trigger is a message
  // about asides, not an aside.
  it("does not fire when the trigger appears mid-message", () => {
    expect(
      evaluatePreSendChecks([trigger()], context({ message: "explain how /btw works" }))
        .disposition,
    ).toBe("allow");
  });

  it("matches anywhere for contains", () => {
    const rules = [trigger({ operator: "contains" })];
    expect(
      evaluatePreSendChecks(rules, context({ message: "explain how /btw works" })).disposition,
    ).toBe("redirect");
  });

  // A redirect consumes the message rather than sending it, so anything that
  // makes the redirect unperformable has to fall back to an ordinary send. Each
  // of these would otherwise swallow what was typed.
  it("declines a redirect whose action kind is unknown", () => {
    const rules = [trigger({ action: { kind: "teleport" } })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  it("declines a redirect carrying no action at all", () => {
    const rules = [trigger({ action: undefined })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  it("declines a trigger with empty text rather than matching everything", () => {
    const rules = [trigger({ text: "" })];
    expect(evaluatePreSendChecks(rules, context({ message: "anything" })).disposition).toBe(
      "allow",
    );
  });

  it("skips a text measurement compared with a numeric operator", () => {
    const rules = [trigger({ operator: "gte" })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  // A redirect takes the message somewhere else, so the reasons to hold a send
  // back have nothing left to act on.
  it("outranks a block that also matched", () => {
    const rules = [trigger(), rule({ id: "cold", disposition: "block" })];
    const evaluation = evaluatePreSendChecks(
      rules,
      context({ message: "/btw hi", idleSeconds: 999 }),
    );
    expect(evaluation.disposition).toBe("redirect");
    expect(evaluation.findings).toHaveLength(2);
  });
});
