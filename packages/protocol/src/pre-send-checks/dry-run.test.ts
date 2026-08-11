import { describe, expect, it } from "vitest";
import { dryRunPreSendCheck, dryRunPreSendCheckSample, dryRunPreSendChecks } from "./dry-run.js";
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

  // Only when the seam refuses every one of them. Badging a rule that still
  // fires as broken would send someone looking for a fault that is not there.
  it("does not call a rule broken for one outcome its seam refuses", () => {
    const partly: PreSendCheckRule = {
      ...IDLE,
      event: "turn.failed",
      outcomes: [{ kind: "block" }, { kind: "notify" }],
    };

    expect(dryRunPreSendCheck(partly, context({ idleSeconds: 250 })).verdict).toEqual({
      fires: true,
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

describe("dryRunPreSendCheckSample", () => {
  // The question someone actually has while writing a rule: would this match?
  it("answers a text rule against typed text", () => {
    const btw: PreSendCheckRule = {
      id: "btw",
      measurement: "message",
      trigger: "message",
      operator: "startsWith",
      text: "/btw",
      value: "/btw",
      disposition: "redirect",
      outcome: { kind: "aside" },
    };

    expect(dryRunPreSendCheckSample(btw, "/btw what is this").verdict).toEqual({ fires: true });
    expect(dryRunPreSendCheckSample(btw, "hello").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  it("answers a numeric rule against a typed number", () => {
    expect(dryRunPreSendCheckSample(IDLE, "250").verdict).toEqual({ fires: true });
    expect(dryRunPreSendCheckSample(IDLE, "5").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // Nothing to compare, so nothing to type.
  it("fires an always rule whatever the sample", () => {
    const always: PreSendCheckRule = { ...IDLE, measurement: "always", trigger: "always" };

    expect(dryRunPreSendCheckSample(always, "").verdict).toEqual({ fires: true });
  });

  it("does not fire a numeric rule on text that is not a number", () => {
    expect(dryRunPreSendCheckSample(IDLE, "soon").verdict).toEqual({
      fires: false,
      because: "condition-false",
    });
  });

  // Structural still wins: no sample makes an impossible rule possible.
  it("still reports a rule that can never fire", () => {
    expect(dryRunPreSendCheckSample({ ...IDLE, event: "turn.failed" }, "250").verdict).toEqual({
      fires: false,
      because: "outcome-not-at-this-event",
    });
  });
});
