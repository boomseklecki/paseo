import { describe, expect, it } from "vitest";
import { evaluatePreSendChecks, evaluatePreSendEvent } from "./evaluate.js";
import {
  isOutcomeValidForEvent,
  isTriggerValidForEvent,
  PRE_SEND_EVENT_DEFINITIONS,
  rulesForPreSendEvent,
} from "./events.js";
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

const SEND_RULE: PreSendCheckRule = {
  id: "cold",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 100,
  disposition: "block",
};

const FAILURE_RULE: PreSendCheckRule = {
  id: "costly",
  event: "turn.failed",
  measurement: "agent.sessionCostUsd",
  trigger: "agent.sessionCostUsd",
  operator: "gte",
  value: 10,
  disposition: "redirect",
  outcome: { kind: "notify" },
};

describe("rulesForPreSendEvent", () => {
  // A rule written before `event` existed meant the send, because that was the
  // only seam there was.
  it("treats a rule with no event as a send rule", () => {
    expect(rulesForPreSendEvent([SEND_RULE], "message.send")).toEqual([SEND_RULE]);
    expect(rulesForPreSendEvent([SEND_RULE], "turn.failed")).toEqual([]);
  });

  it("keeps the two seams apart", () => {
    const rules = [SEND_RULE, FAILURE_RULE];

    expect(rulesForPreSendEvent(rules, "message.send").map((r) => r.id)).toEqual(["cold"]);
    expect(rulesForPreSendEvent(rules, "turn.failed").map((r) => r.id)).toEqual(["costly"]);
  });

  // Failing open, the same way an unrecognised trigger does.
  it("gives a rule naming an unknown event to nobody", () => {
    const orphan: PreSendCheckRule = { ...SEND_RULE, event: "moon.rose" };

    expect(rulesForPreSendEvent([orphan], "message.send")).toEqual([]);
    expect(rulesForPreSendEvent([orphan], "turn.failed")).toEqual([]);
  });
});

describe("what each seam accepts", () => {
  // `block` needs a send to hold and `notify` needs nobody watching, so neither
  // belongs at both seams. Offering them everywhere would let someone save a
  // rule that is stored, evaluated, and silently does nothing.
  it("does not let a send rule notify or a failure rule block", () => {
    expect(isOutcomeValidForEvent("message.send", "block")).toBe(true);
    expect(isOutcomeValidForEvent("message.send", "notify")).toBe(false);
    expect(isOutcomeValidForEvent("turn.failed", "notify")).toBe(true);
    expect(isOutcomeValidForEvent("turn.failed", "block")).toBe(false);
  });

  it("offers actions at the send seam", () => {
    expect(isOutcomeValidForEvent("message.send", "aside")).toBe(true);
  });

  // The text was sent a turn ago, so matching on it at a failure would fire on
  // something its author is no longer looking at.
  it("does not offer the message trigger to a daemon seam", () => {
    expect(isTriggerValidForEvent("message.send", "message")).toBe(true);
    expect(isTriggerValidForEvent("turn.failed", "message")).toBe(false);
    expect(isTriggerValidForEvent("turn.failed", "agent.sessionCostUsd")).toBe(true);
  });

  it("accepts nothing for an event it has never heard of", () => {
    expect(isOutcomeValidForEvent("moon.rose", "notify")).toBe(false);
    expect(isTriggerValidForEvent("moon.rose", "always")).toBe(false);
  });

  it("declares every seam with at least one outcome and one trigger", () => {
    for (const definition of PRE_SEND_EVENT_DEFINITIONS) {
      expect(definition.outcomeKinds.length).toBeGreaterThan(0);
      expect(definition.triggers.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluatePreSendChecks with several seams", () => {
  // Otherwise a rule about a failed turn would hold a send.
  it("ignores rules belonging to another seam", () => {
    const always: PreSendCheckRule = {
      ...FAILURE_RULE,
      trigger: "always",
      measurement: "always",
      outcome: { kind: "block" },
      disposition: "block",
    };

    expect(evaluatePreSendChecks([always], context()).disposition).toBe("allow");
  });
});

describe("evaluatePreSendEvent", () => {
  it("reports the outcome rather than a disposition", () => {
    const findings = evaluatePreSendEvent(
      [FAILURE_RULE],
      "turn.failed",
      context({ sessionCostUsd: 25 }),
    );

    expect(findings).toEqual([
      {
        ruleId: "costly",
        trigger: "agent.sessionCostUsd",
        value: 25,
        operand: 10,
        message: null,
        outcome: { kind: "notify" },
      },
    ]);
  });

  it("does not fire when the condition does not hold", () => {
    expect(
      evaluatePreSendEvent([FAILURE_RULE], "turn.failed", context({ sessionCostUsd: 1 })),
    ).toEqual([]);
  });

  // The event is the condition, so there is nothing to compare and the rule
  // fires whenever the seam does.
  it("fires an always rule with nothing measured at all", () => {
    const always: PreSendCheckRule = {
      ...FAILURE_RULE,
      id: "any-failure",
      measurement: "always",
      trigger: "always",
      value: undefined,
    };

    const findings = evaluatePreSendEvent([always], "turn.failed", context());

    expect(findings.map((finding) => finding.ruleId)).toEqual(["any-failure"]);
    expect(findings[0]?.value).toBe("always");
  });
});

describe("the turn.completed seam", () => {
  // Where a conversation has got to settles when a turn ends, so this is the
  // seam for context and cost.
  it("accepts notify and the agent triggers", () => {
    expect(isOutcomeValidForEvent("turn.completed", "notify")).toBe(true);
    expect(isTriggerValidForEvent("turn.completed", "agent.contextUsedPercent")).toBe(true);
    expect(isTriggerValidForEvent("turn.completed", "always")).toBe(true);
  });

  // There is no composer at this seam to warn in or hold anything back.
  it("accepts neither warn nor block", () => {
    expect(isOutcomeValidForEvent("turn.completed", "warn")).toBe(false);
    expect(isOutcomeValidForEvent("turn.completed", "block")).toBe(false);
  });

  it("keeps its rules apart from the failure seam", () => {
    const completed: PreSendCheckRule = { ...FAILURE_RULE, id: "full", event: "turn.completed" };

    expect(
      rulesForPreSendEvent([completed, FAILURE_RULE], "turn.completed").map((r) => r.id),
    ).toEqual(["full"]);
    expect(rulesForPreSendEvent([completed, FAILURE_RULE], "turn.failed").map((r) => r.id)).toEqual(
      ["costly"],
    );
  });
});

describe("the agent.idle seam", () => {
  // The only seam that fires because nothing happened, so nothing else can
  // carry it and the daemon runs a clock for it alone.
  it("accepts notify and asks about the agent", () => {
    expect(isOutcomeValidForEvent("agent.idle", "notify")).toBe(true);
    expect(isTriggerValidForEvent("agent.idle", "agent.idleSeconds")).toBe(true);
    expect(isOutcomeValidForEvent("agent.idle", "block")).toBe(false);
  });

  it("is one of the seams on offer", () => {
    expect(PRE_SEND_EVENT_DEFINITIONS.map((definition) => definition.event)).toEqual([
      "message.send",
      "turn.completed",
      "agent.idle",
      "turn.failed",
    ]);
  });
});
