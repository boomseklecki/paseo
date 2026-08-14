import { describe, expect, it } from "vitest";
import { dryRunRule, dryRunRuleSample, dryRunRules } from "./dry-run.js";
import type { Rule, RuleMeasurementContext } from "./types.js";

function context(overrides: Partial<RuleMeasurementContext> = {}): RuleMeasurementContext {
  return {
    "agent.idleSeconds": 0,
    "agent.contextUsedPercent": null,
    "agent.sessionCostUsd": null,
    message: "",
    ...overrides,
  };
}

const IDLE: Rule = {
  id: "cold",
  measurement: "agent.idleSeconds",
  trigger: "agent.idleSeconds",
  operator: "gte",
  threshold: 100,
  value: 100,
  disposition: "block",
  outcome: { kind: "block" },
};

describe("dryRunRule", () => {
  it("says a rule fires when its condition holds", () => {
    expect(dryRunRule(IDLE, context({ "agent.idleSeconds": 250 }))).toEqual({
      ruleId: "cold",
      event: "message.send",
      verdict: { fires: true },
    });
  });

  it("separates not tripping from not able to trip", () => {
    expect(dryRunRule(IDLE, context({ "agent.idleSeconds": 5 })).verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // The two worth having. Both look identical from outside - the rule sits
  // there doing nothing - and both are always a mistake, where a false
  // condition usually is not.
  it("names a trigger its seam cannot read", () => {
    const wrong: Rule = {
      ...IDLE,
      event: "turn.failed",
      measurement: "message",
      trigger: "message",
      text: "/x",
      value: "/x",
    };

    expect(dryRunRule(wrong, context()).verdict).toEqual({
      fires: false,
      because: "trigger-not-at-this-event",
    });
  });

  it("names an outcome its seam refuses", () => {
    const wrong: Rule = { ...IDLE, event: "turn.failed" };

    expect(dryRunRule(wrong, context({ "agent.idleSeconds": 250 })).verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });

  // Only when the seam refuses every one of them. Badging a rule that still
  // fires as broken would send someone looking for a fault that is not there.
  it("does not call a rule broken for one outcome its seam refuses", () => {
    const partly: Rule = {
      ...IDLE,
      event: "turn.failed",
      outcomes: [{ kind: "block" }, { kind: "notify" }],
    };

    expect(dryRunRule(partly, context({ "agent.idleSeconds": 250 })).verdict).toEqual({
      fires: true,
    });
  });

  it("names a seam it has never heard of", () => {
    expect(dryRunRule({ ...IDLE, event: "moon.rose" }, context()).verdict).toEqual({
      fires: false,
      because: "unknown-event",
    });
  });

  it("says when a rule is simply off", () => {
    expect(
      dryRunRule({ ...IDLE, enabled: false }, context({ "agent.idleSeconds": 250 })).verdict,
    ).toEqual({ fires: false, because: "disabled" });
  });

  // Structural first: a rule that can never fire is broken whether or not its
  // condition happens to hold today, and reporting the condition would send
  // someone adjusting a threshold that was never the problem.
  it("reports the structural reason ahead of the condition", () => {
    const wrong: Rule = { ...IDLE, event: "turn.failed" };

    expect(dryRunRule(wrong, context({ "agent.idleSeconds": 0 })).verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });

  it("answers for a daemon seam too", () => {
    const notify: Rule = {
      ...IDLE,
      event: "turn.failed",
      disposition: "redirect",
      outcome: { kind: "notify" },
    };

    expect(dryRunRule(notify, context({ "agent.idleSeconds": 250 })).verdict).toEqual({
      fires: true,
    });
  });
});

describe("dryRunRules", () => {
  it("answers for every rule in the order given", () => {
    const results = dryRunRules(
      [IDLE, { ...IDLE, id: "off", enabled: false }],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(results.map((result) => [result.ruleId, result.verdict.fires])).toEqual([
      ["cold", true],
      ["off", false],
    ]);
  });
});

describe("dryRunRuleSample", () => {
  // The question someone actually has while writing a rule: would this match?
  it("answers a text rule against typed text", () => {
    const btw: Rule = {
      id: "btw",
      measurement: "message",
      trigger: "message",
      operator: "startsWith",
      text: "/btw",
      value: "/btw",
      disposition: "redirect",
      outcome: { kind: "aside" },
    };

    expect(dryRunRuleSample(btw, "/btw what is this").verdict).toEqual({ fires: true });
    expect(dryRunRuleSample(btw, "hello").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  it("answers a numeric rule against a typed number", () => {
    expect(dryRunRuleSample(IDLE, "250").verdict).toEqual({ fires: true });
    expect(dryRunRuleSample(IDLE, "5").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // Nothing to compare, so nothing to type.
  it("fires an always rule whatever the sample", () => {
    const always: Rule = { ...IDLE, measurement: "always", trigger: "always" };

    expect(dryRunRuleSample(always, "").verdict).toEqual({ fires: true });
  });

  it("does not fire a numeric rule on text that is not a number", () => {
    expect(dryRunRuleSample(IDLE, "soon").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // Structural still wins: no sample makes an impossible rule possible.
  it("still reports a rule that can never fire", () => {
    expect(dryRunRuleSample({ ...IDLE, event: "turn.failed" }, "250").verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });
});
