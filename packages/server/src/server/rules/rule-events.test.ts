import { describe, expect, test } from "vitest";
import type { Rule, RuleMeasurementContext } from "@getpaseo/protocol/rules/types";
import { RuleEventTracker, buildAgentRuleContext, fireRuleEvent } from "./rule-events.js";

const COSTLY: Rule = {
  id: "costly",
  event: "turn.failed",
  measurement: "agent.sessionCostUsd",
  trigger: "agent.sessionCostUsd",
  operator: "gte",
  value: 10,
  disposition: "redirect",
  outcome: { kind: "notify" },
};

const ALWAYS: Rule = {
  id: "any-failure",
  event: "turn.failed",
  measurement: "always",
  trigger: "always",
  operator: "gte",
  disposition: "redirect",
  outcome: { kind: "notify" },
};

function context(overrides: Partial<RuleMeasurementContext> = {}): RuleMeasurementContext {
  return {
    "agent.idleSeconds": 0,
    "agent.contextUsedPercent": null,
    "agent.sessionCostUsd": null,
    message: "",
    ...overrides,
  };
}

function fire(
  tracker: RuleEventTracker,
  rules: readonly Rule[],
  ctx: RuleMeasurementContext,
  agentId = "agent-1",
  event = "turn.failed",
) {
  return fireRuleEvent(tracker, {
    agentId,
    event,
    rules,
    context: ctx,
  }).map((finding) => finding.ruleId);
}

describe("fireRuleEvent", () => {
  test("fires a rule whose condition holds", () => {
    const tracker = new RuleEventTracker();

    expect(fire(tracker, [COSTLY], context({ "agent.sessionCostUsd": 25 }))).toEqual(["costly"]);
  });

  // The whole reason the tracker exists: "cost is over $10" stays true for every
  // turn after the first, and notifying each time is how a feature gets muted.
  test("stays quiet while the same condition keeps holding", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
  });

  // Two separate occasions deserve two notifications.
  test("re-arms once the condition goes away", () => {
    const tracker = new RuleEventTracker();

    expect(fire(tracker, [COSTLY], context({ "agent.sessionCostUsd": 25 }))).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], context({ "agent.sessionCostUsd": 0 }))).toEqual([]);
    expect(fire(tracker, [COSTLY], context({ "agent.sessionCostUsd": 25 }))).toEqual(["costly"]);
  });

  // An `always` rule is unconditional per seam, not once per lifetime: every
  // failed turn is its own event, and the condition never "goes away" in between.
  // Documented here because it is the one case the edge trigger reads oddly for.
  test("an always rule fires once and then stays quiet until it stops matching", () => {
    const tracker = new RuleEventTracker();

    expect(fire(tracker, [ALWAYS], context())).toEqual(["any-failure"]);
    expect(fire(tracker, [ALWAYS], context())).toEqual([]);
  });

  test("tracks each agent apart", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });

    expect(fire(tracker, [COSTLY], ctx, "agent-1")).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx, "agent-2")).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx, "agent-1")).toEqual([]);
  });

  test("fires a newly added rule without re-firing the one already tripping", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY, ALWAYS], ctx)).toEqual(["any-failure"]);
  });

  // Each call replaces the whole set for its key, so with one key per agent a
  // seam that matched nothing would wipe what another seam was remembering.
  // Before this was keyed by seam as well, a completed turn with no rules
  // matching cleared the failure seam's memory and the next failed turn
  // notified again for a condition it had already reported.
  test("one seam matching nothing does not re-arm another seam", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });
    const completed: Rule = { ...COSTLY, id: "done", event: "turn.completed" };

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    // Nothing matches at the other seam, which used to be the clobber.
    expect(fire(tracker, [completed], context(), "agent-1", "turn.completed")).toEqual([]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
  });

  test("keeps a rule tripping at one seam from silencing another", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });
    const idle: Rule = { ...COSTLY, id: "stale", event: "agent.idle" };

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [idle], ctx, "agent-1", "agent.idle")).toEqual(["stale"]);
  });

  test("arms again for an agent it was told to forget", () => {
    const tracker = new RuleEventTracker();
    const ctx = context({ "agent.sessionCostUsd": 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    tracker.forget("agent-1");
    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
  });

  // The seam cannot hold a send, so a rule asking it to is skipped rather than
  // half-performed. The editor prevents this; a hand-edited file does not.
  test("ignores a rule asking for an outcome this seam cannot carry out", () => {
    const blocking: Rule = { ...COSTLY, id: "blocking", outcome: { kind: "block" } };

    expect(
      fire(new RuleEventTracker(), [blocking], context({ "agent.sessionCostUsd": 25 })),
    ).toEqual([]);
  });

  test("ignores a rule belonging to another seam", () => {
    const sendRule: Rule = { ...COSTLY, id: "on-send", event: "message.send" };

    expect(
      fire(new RuleEventTracker(), [sendRule], context({ "agent.sessionCostUsd": 25 })),
    ).toEqual([]);
  });

  test("ignores a disabled rule", () => {
    const off: Rule = { ...COSTLY, enabled: false };

    expect(fire(new RuleEventTracker(), [off], context({ "agent.sessionCostUsd": 25 }))).toEqual(
      [],
    );
  });

  // Failing open: an unmeasurable value is not a reason to notify.
  test("does not fire when the value could not be measured", () => {
    expect(
      fire(new RuleEventTracker(), [COSTLY], context({ "agent.sessionCostUsd": null })),
    ).toEqual([]);
  });
});

/**
 * The five triggers the reshape made cheap. What matters here is not the
 * arithmetic but that the daemon supplies them at all: a trigger the editor
 * offers and no builder measures is a rule that saves, evaluates, and does
 * nothing.
 */
describe("buildAgentRuleContext measures the agent triggers", () => {
  test("reports headroom as well as proportion", () => {
    const measured = buildAgentRuleContext({
      contextWindowUsedTokens: 180_000,
      contextWindowMaxTokens: 200_000,
      totalCostUsd: null,
      idleSeconds: 0,
    });

    expect(measured["agent.contextRemainingTokens"]).toBe(20_000);
    expect(measured["agent.contextUsedPercent"]).toBe(90);
  });

  // A window that shrank under what was already used would otherwise report
  // negative headroom, which no operator reads usefully.
  test("never reports negative headroom", () => {
    const measured = buildAgentRuleContext({
      contextWindowUsedTokens: 210_000,
      contextWindowMaxTokens: 200_000,
      totalCostUsd: null,
      idleSeconds: 0,
    });

    expect(measured["agent.contextRemainingTokens"]).toBe(0);
  });

  test("leaves headroom unmeasured when the window is unknown", () => {
    const measured = buildAgentRuleContext({
      contextWindowUsedTokens: 180_000,
      contextWindowMaxTokens: null,
      totalCostUsd: null,
      idleSeconds: 0,
    });

    expect(measured["agent.contextRemainingTokens"]).toBeNull();
  });

  // Absent rather than null, so a rule reading one is skipped rather than
  // compared against an empty string.
  test("omits the text triggers it has nothing to say about", () => {
    const measured = buildAgentRuleContext({
      contextWindowUsedTokens: null,
      contextWindowMaxTokens: null,
      totalCostUsd: null,
      idleSeconds: 0,
    });

    expect("agent.lastError" in measured).toBe(false);
    expect("agent.provider" in measured).toBe(false);
    expect("agent.model" in measured).toBe(false);
  });

  test("carries the provider, model and last error when it has them", () => {
    const measured = buildAgentRuleContext({
      contextWindowUsedTokens: null,
      contextWindowMaxTokens: null,
      totalCostUsd: null,
      idleSeconds: 0,
      secondsSinceUserMessage: 120,
      lastError: "rate limit exceeded",
      provider: "claude",
      model: "claude-opus-5[1m]",
    });

    expect(measured["agent.lastError"]).toBe("rate limit exceeded");
    expect(measured["agent.provider"]).toBe("claude");
    expect(measured["agent.model"]).toBe("claude-opus-5[1m]");
    expect(measured["agent.secondsSinceUserMessage"]).toBe(120);
  });
});
