import { describe, expect, it } from "vitest";
import { dryRunPreSendCheck, dryRunPreSendChecks } from "./dry-run.js";
import type { PreSendCheckRule, PreSendMeasurementContext } from "./types.js";

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    idleSeconds: 0,
    contextUsedPercent: null,
    sessionCostUsd: null,
    message: "",
    ...overrides,
  };
}

const IDLE: PreSendCheckRule = {
  id: "cold",
  measurement: "agent.idleSeconds",
  trigger: "agent.idleSeconds",
  operator: "gte",
  threshold: 100,
  value: 100,
  disposition: "block",
  outcome: { kind: "block" },
};

describe("dryRunPreSendCheck", () => {
  it("says a rule fires when its condition holds", () => {
    expect(dryRunPreSendCheck(IDLE, context({ idleSeconds: 250 }))).toEqual({
      ruleId: "cold",
      event: "message.send",
      verdict: { fires: true },
    });
  });

  it("separates not tripping from not able to trip", () => {
    expect(dryRunPreSendCheck(IDLE, context({ idleSeconds: 5 })).verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // The two worth having. Both look identical from outside - the rule sits
  // there doing nothing - and both are always a mistake, where a false
  // condition usually is not.
  it("names a trigger its seam cannot read", () => {
    const wrong: PreSendCheckRule = {
      ...IDLE,
      event: "turn.failed",
      measurement: "message",
      trigger: "message",
      text: "/x",
      value: "/x",
    };

    expect(dryRunPreSendCheck(wrong, context()).verdict).toEqual({
      fires: false,
      because: "trigger-not-at-this-event",
    });
  });

  it("names an outcome its seam refuses", () => {
    const wrong: PreSendCheckRule = { ...IDLE, event: "turn.failed" };

    expect(dryRunPreSendCheck(wrong, context({ idleSeconds: 250 })).verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });

  it("names a seam it has never heard of", () => {
    expect(dryRunPreSendCheck({ ...IDLE, event: "moon.rose" }, context()).verdict).toEqual({
      fires: false,
      because: "unknown-event",
    });
  });

  it("says when a rule is simply off", () => {
    expect(
      dryRunPreSendCheck({ ...IDLE, enabled: false }, context({ idleSeconds: 250 })).verdict,
    ).toEqual({ fires: false, because: "disabled" });
  });

  // Structural first: a rule that can never fire is broken whether or not its
  // condition happens to hold today, and reporting the condition would send
  // someone adjusting a threshold that was never the problem.
  it("reports the structural reason ahead of the condition", () => {
    const wrong: PreSendCheckRule = { ...IDLE, event: "turn.failed" };

    expect(dryRunPreSendCheck(wrong, context({ idleSeconds: 0 })).verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });

  it("answers for a daemon seam too", () => {
    const notify: PreSendCheckRule = {
      ...IDLE,
      event: "turn.failed",
      disposition: "redirect",
      outcome: { kind: "notify" },
    };

    expect(dryRunPreSendCheck(notify, context({ idleSeconds: 250 })).verdict).toEqual({
      fires: true,
    });
  });
});

describe("dryRunPreSendChecks", () => {
  it("answers for every rule in the order given", () => {
    const results = dryRunPreSendChecks(
      [IDLE, { ...IDLE, id: "off", enabled: false }],
      context({ idleSeconds: 250 }),
    );

    expect(results.map((result) => [result.ruleId, result.verdict.fires])).toEqual([
      ["cold", true],
      ["off", false],
    ]);
  });
});
