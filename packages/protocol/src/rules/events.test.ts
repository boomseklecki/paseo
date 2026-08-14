import { describe, expect, it } from "vitest";
import { evaluateRules, evaluateRuleEvent } from "./evaluate.js";
import {
  isOutcomeValidForEvent,
  isTriggerValidForEvent,
  RULE_EVENT_DEFINITIONS,
  rulesForRuleEvent,
} from "./events.js";
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

const SEND_RULE: Rule = {
  id: "cold",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 100,
  disposition: "block",
};

const FAILURE_RULE: Rule = {
  id: "costly",
  event: "turn.failed",
  measurement: "agent.sessionCostUsd",
  trigger: "agent.sessionCostUsd",
  operator: "gte",
  value: 10,
  disposition: "redirect",
  outcome: { kind: "notify" },
};

describe("rulesForRuleEvent", () => {
  // A rule written before `event` existed meant the send, because that was the
  // only seam there was.
  it("treats a rule with no event as a send rule", () => {
    expect(rulesForRuleEvent([SEND_RULE], "message.send")).toEqual([SEND_RULE]);
    expect(rulesForRuleEvent([SEND_RULE], "turn.failed")).toEqual([]);
  });

  it("keeps the two seams apart", () => {
    const rules = [SEND_RULE, FAILURE_RULE];

    expect(rulesForRuleEvent(rules, "message.send").map((r) => r.id)).toEqual(["cold"]);
    expect(rulesForRuleEvent(rules, "turn.failed").map((r) => r.id)).toEqual(["costly"]);
  });

  // Failing open, the same way an unrecognised trigger does.
  it("gives a rule naming an unknown event to nobody", () => {
    const orphan: Rule = { ...SEND_RULE, event: "moon.rose" };

    expect(rulesForRuleEvent([orphan], "message.send")).toEqual([]);
    expect(rulesForRuleEvent([orphan], "turn.failed")).toEqual([]);
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
    for (const definition of RULE_EVENT_DEFINITIONS) {
      expect(definition.outcomeKinds.length).toBeGreaterThan(0);
      expect(definition.triggers.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluateRules with several seams", () => {
  // Otherwise a rule about a failed turn would hold a send.
  it("ignores rules belonging to another seam", () => {
    const always: Rule = {
      ...FAILURE_RULE,
      trigger: "always",
      measurement: "always",
      outcome: { kind: "block" },
      disposition: "block",
    };

    expect(evaluateRules([always], context()).disposition).toBe("allow");
  });
});

describe("evaluateRuleEvent", () => {
  it("reports the outcome rather than a disposition", () => {
    const findings = evaluateRuleEvent(
      [FAILURE_RULE],
      "turn.failed",
      context({ "agent.sessionCostUsd": 25 }),
    );

    expect(findings).toEqual([
      {
        ruleId: "costly",
        trigger: "agent.sessionCostUsd",
        value: 25,
        operand: 10,
        message: null,
        outcomes: [{ kind: "notify" }],
      },
    ]);
  });

  it("does not fire when the condition does not hold", () => {
    expect(
      evaluateRuleEvent([FAILURE_RULE], "turn.failed", context({ "agent.sessionCostUsd": 1 })),
    ).toEqual([]);
  });

  // The event is the condition, so there is nothing to compare and the rule
  // fires whenever the seam does.
  it("fires an always rule with nothing measured at all", () => {
    const always: Rule = {
      ...FAILURE_RULE,
      id: "any-failure",
      measurement: "always",
      trigger: "always",
      value: undefined,
    };

    const findings = evaluateRuleEvent([always], "turn.failed", context());

    expect(findings.map((finding) => finding.ruleId)).toEqual(["any-failure"]);
    expect(findings[0]?.value).toBe("always");
  });

  // The editor stops one being written from today and says nothing about the
  // ones already on disk, which is the whole reason the evaluator checks too.
  // Left to fire, this one is a sweep every minute with nothing to re-arm it.
  it("does not fire an always rule at the seam that refuses that trigger", () => {
    const always: Rule = {
      ...FAILURE_RULE,
      id: "any-idle",
      event: "agent.idle",
      measurement: "always",
      trigger: "always",
      value: undefined,
      outcomes: [{ kind: "notify" }],
    };

    expect(
      evaluateRuleEvent([always], "agent.idle", context({ "agent.idleSeconds": 9000 })),
    ).toEqual([]);
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
    const completed: Rule = { ...FAILURE_RULE, id: "full", event: "turn.completed" };

    expect(rulesForRuleEvent([completed, FAILURE_RULE], "turn.completed").map((r) => r.id)).toEqual(
      ["full"],
    );
    expect(rulesForRuleEvent([completed, FAILURE_RULE], "turn.failed").map((r) => r.id)).toEqual([
      "costly",
    ]);
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

  // The one trigger refused here and accepted at every other seam. A sweep
  // reaches an idle agent again every minute, so "the event itself is the
  // condition" asks to fire every minute for as long as it sits there — and
  // with nothing that ever stops holding, nothing re-arms it either.
  it("refuses always, which the seams that are transitions accept", () => {
    expect(isTriggerValidForEvent("agent.idle", "always")).toBe(false);
    expect(isTriggerValidForEvent("turn.completed", "always")).toBe(true);
    expect(isTriggerValidForEvent("turn.failed", "always")).toBe(true);
    expect(isTriggerValidForEvent("message.send", "always")).toBe(true);
  });

  it("is one of the seams on offer", () => {
    expect(RULE_EVENT_DEFINITIONS.map((definition) => definition.event)).toEqual([
      "message.send",
      "turn.completed",
      "agent.idle",
      "turn.failed",
    ]);
  });
});

describe("two redirects matching", () => {
  const redirect = (id: string, order: number | undefined, kind: string): Rule => ({
    id,
    measurement: "always",
    trigger: "always",
    operator: "gte",
    disposition: "redirect",
    outcome: { kind },
    ...(order === undefined ? {} : { order }),
  });

  // A redirect consumes the message and a message goes one place, so a tie has
  // to be broken by something a person can predict. Ordering the list was
  // tidiness until now; here it decides.
  it("puts the rule arranged first at the front", () => {
    const evaluation = evaluateRules(
      [redirect("second", 1, "fork"), redirect("first", 0, "aside")],
      context(),
    );

    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["first", "second"]);
    expect(evaluation.findings[0]?.outcomes).toEqual([{ kind: "aside" }]);
  });

  // Matching how the store lists them, so adding order to some rules and not
  // others stays predictable.
  it("sorts an unordered rule after every ordered one", () => {
    const evaluation = evaluateRules(
      [redirect("none", undefined, "fork"), redirect("ordered", 3, "aside")],
      context(),
    );

    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["ordered", "none"]);
  });

  it("breaks a dead heat on id rather than on argument order", () => {
    const evaluation = evaluateRules(
      [redirect("b", 0, "fork"), redirect("a", 0, "aside")],
      context(),
    );

    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["a", "b"]);
  });
});

/**
 * Nothing is being held back at a daemon seam, so the outcomes do not compete:
 * a rule that says notify me and write the handoff means both.
 */
describe("several outcomes at a daemon seam", () => {
  const rule = (outcomes: readonly { kind: string }[]): Rule => ({
    ...FAILURE_RULE,
    outcomes: [...outcomes],
  });

  it("reports every outcome, in the order the rule listed them", () => {
    const findings = evaluateRuleEvent(
      [rule([{ kind: "notify" }, { kind: "aside" }])],
      "turn.failed",
      context({ "agent.sessionCostUsd": 25 }),
    );

    expect(findings[0]?.outcomes).toEqual([{ kind: "notify" }, { kind: "aside" }]);
  });

  // Per outcome, not per rule: the half the seam refuses is no reason to drop
  // the half it accepts.
  it("drops only the outcomes the seam refuses", () => {
    const findings = evaluateRuleEvent(
      [rule([{ kind: "block" }, { kind: "notify" }])],
      "turn.failed",
      context({ "agent.sessionCostUsd": 25 }),
    );

    expect(findings[0]?.outcomes).toEqual([{ kind: "notify" }]);
  });

  it("skips a rule whose every outcome the seam refuses", () => {
    const findings = evaluateRuleEvent(
      [rule([{ kind: "block" }, { kind: "warn" }])],
      "turn.failed",
      context({ "agent.sessionCostUsd": 25 }),
    );

    expect(findings).toEqual([]);
  });
});
