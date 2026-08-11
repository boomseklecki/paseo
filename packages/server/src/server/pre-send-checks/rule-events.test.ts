import { describe, expect, test } from "vitest";
import type {
  PreSendCheckRule,
  PreSendMeasurementContext,
} from "@getpaseo/protocol/pre-send-checks/types";
import { PreSendRuleEventTracker, firePreSendRuleEvent } from "./rule-events.js";

const COSTLY: PreSendCheckRule = {
  id: "costly",
  event: "turn.failed",
  measurement: "agent.sessionCostUsd",
  trigger: "agent.sessionCostUsd",
  operator: "gte",
  value: 10,
  disposition: "redirect",
  outcome: { kind: "notify" },
};

const ALWAYS: PreSendCheckRule = {
  id: "any-failure",
  event: "turn.failed",
  measurement: "always",
  trigger: "always",
  operator: "gte",
  disposition: "redirect",
  outcome: { kind: "notify" },
};

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    idleSeconds: 0,
    contextUsedPercent: null,
    sessionCostUsd: null,
    message: "",
    ...overrides,
  };
}

function fire(
  tracker: PreSendRuleEventTracker,
  rules: readonly PreSendCheckRule[],
  ctx: PreSendMeasurementContext,
  agentId = "agent-1",
  event = "turn.failed",
) {
  return firePreSendRuleEvent(tracker, {
    agentId,
    event,
    rules,
    context: ctx,
  }).map((finding) => finding.ruleId);
}

describe("firePreSendRuleEvent", () => {
  test("fires a rule whose condition holds", () => {
    const tracker = new PreSendRuleEventTracker();

    expect(fire(tracker, [COSTLY], context({ sessionCostUsd: 25 }))).toEqual(["costly"]);
  });

  // The whole reason the tracker exists: "cost is over $10" stays true for every
  // turn after the first, and notifying each time is how a feature gets muted.
  test("stays quiet while the same condition keeps holding", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
  });

  // Two separate occasions deserve two notifications.
  test("re-arms once the condition goes away", () => {
    const tracker = new PreSendRuleEventTracker();

    expect(fire(tracker, [COSTLY], context({ sessionCostUsd: 25 }))).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], context({ sessionCostUsd: 0 }))).toEqual([]);
    expect(fire(tracker, [COSTLY], context({ sessionCostUsd: 25 }))).toEqual(["costly"]);
  });

  // An `always` rule is unconditional per seam, not once per lifetime: every
  // failed turn is its own event, and the condition never "goes away" in between.
  // Documented here because it is the one case the edge trigger reads oddly for.
  test("an always rule fires once and then stays quiet until it stops matching", () => {
    const tracker = new PreSendRuleEventTracker();

    expect(fire(tracker, [ALWAYS], context())).toEqual(["any-failure"]);
    expect(fire(tracker, [ALWAYS], context())).toEqual([]);
  });

  test("tracks each agent apart", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });

    expect(fire(tracker, [COSTLY], ctx, "agent-1")).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx, "agent-2")).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY], ctx, "agent-1")).toEqual([]);
  });

  test("fires a newly added rule without re-firing the one already tripping", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [COSTLY, ALWAYS], ctx)).toEqual(["any-failure"]);
  });

  // Each call replaces the whole set for its key, so with one key per agent a
  // seam that matched nothing would wipe what another seam was remembering.
  // Before this was keyed by seam as well, a completed turn with no rules
  // matching cleared the failure seam's memory and the next failed turn
  // notified again for a condition it had already reported.
  test("one seam matching nothing does not re-arm another seam", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });
    const completed: PreSendCheckRule = { ...COSTLY, id: "done", event: "turn.completed" };

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    // Nothing matches at the other seam, which used to be the clobber.
    expect(fire(tracker, [completed], context(), "agent-1", "turn.completed")).toEqual([]);
    expect(fire(tracker, [COSTLY], ctx)).toEqual([]);
  });

  test("keeps a rule tripping at one seam from silencing another", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });
    const idle: PreSendCheckRule = { ...COSTLY, id: "stale", event: "agent.idle" };

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    expect(fire(tracker, [idle], ctx, "agent-1", "agent.idle")).toEqual(["stale"]);
  });

  test("arms again for an agent it was told to forget", () => {
    const tracker = new PreSendRuleEventTracker();
    const ctx = context({ sessionCostUsd: 25 });

    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
    tracker.forget("agent-1");
    expect(fire(tracker, [COSTLY], ctx)).toEqual(["costly"]);
  });

  // The seam cannot hold a send, so a rule asking it to is skipped rather than
  // half-performed. The editor prevents this; a hand-edited file does not.
  test("ignores a rule asking for an outcome this seam cannot carry out", () => {
    const blocking: PreSendCheckRule = { ...COSTLY, id: "blocking", outcome: { kind: "block" } };

    expect(
      fire(new PreSendRuleEventTracker(), [blocking], context({ sessionCostUsd: 25 })),
    ).toEqual([]);
  });

  test("ignores a rule belonging to another seam", () => {
    const sendRule: PreSendCheckRule = { ...COSTLY, id: "on-send", event: "message.send" };

    expect(
      fire(new PreSendRuleEventTracker(), [sendRule], context({ sessionCostUsd: 25 })),
    ).toEqual([]);
  });

  test("ignores a disabled rule", () => {
    const off: PreSendCheckRule = { ...COSTLY, enabled: false };

    expect(fire(new PreSendRuleEventTracker(), [off], context({ sessionCostUsd: 25 }))).toEqual([]);
  });

  // Failing open: an unmeasurable value is not a reason to notify.
  test("does not fire when the value could not be measured", () => {
    expect(
      fire(new PreSendRuleEventTracker(), [COSTLY], context({ sessionCostUsd: null })),
    ).toEqual([]);
  });
});
