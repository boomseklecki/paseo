import { describe, expect, it } from "vitest";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { describeRuleOutcomes, groupRules, planRuleSave, type RuleHostRules } from "./rule-groups";

const RULE: Rule = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

function rule(overrides: Partial<Rule> & { id: string }): Rule {
  return { ...RULE, ...overrides };
}

function host(serverId: string, rules: readonly Rule[] | null): RuleHostRules {
  return { serverId, serverName: serverId.toUpperCase(), rules };
}

const t = ((key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${Object.values(options).join("|")})` : key) as never;

describe("groupRules", () => {
  it("collects one rule carried by two hosts into a single group", () => {
    const groups = groupRules([host("a", [RULE]), host("b", [RULE])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.serverIds).toEqual(["a", "b"]);
    expect(groups[0]?.serverNames).toEqual(["A", "B"]);
    expect(groups[0]?.differs).toBe(false);
  });

  it("keeps the first host's arrangement and appends what only later hosts have", () => {
    const groups = groupRules([
      host("a", [rule({ id: "x" }), rule({ id: "y" })]),
      host("b", [rule({ id: "y" }), rule({ id: "z" })]),
    ]);
    expect(groups.map((group) => group.id)).toEqual(["x", "y", "z"]);
  });

  // A host that has not answered must not be able to make a rule look absent
  // from it, which is what would let a save quietly delete the rule there.
  it("ignores a host whose rules are not loaded", () => {
    const groups = groupRules([host("a", [RULE]), host("b", null)]);
    expect(groups[0]?.serverIds).toEqual(["a"]);
  });

  it("marks a group whose hosts disagree on the content", () => {
    const groups = groupRules([
      host("a", [RULE]),
      host("b", [rule({ id: RULE.id, threshold: 60 })]),
    ]);
    expect(groups[0]?.differs).toBe(true);
  });

  // `order` is assigned per host over that host's own subset, so identical rules
  // routinely hold different numbers. Counting it would drift every group.
  it("does not count a differing position as disagreement", () => {
    const groups = groupRules([
      host("a", [{ ...RULE, order: 0 }]),
      host("b", [{ ...RULE, order: 3 }]),
    ]);
    expect(groups[0]?.differs).toBe(false);
  });

  it("does not count a differing key order as disagreement", () => {
    const reversed = Object.fromEntries(Object.entries(RULE).toReversed()) as unknown as Rule;
    expect(groupRules([host("a", [RULE]), host("b", [reversed])])[0]?.differs).toBe(false);
  });

  it("counts an unknown field a newer daemon added as disagreement", () => {
    const groups = groupRules([
      host("a", [RULE]),
      host("b", [{ ...RULE, severity: "high" } as Rule]),
    ]);
    expect(groups[0]?.differs).toBe(true);
  });
});

describe("planRuleSave", () => {
  it("writes to every target, not only the newly selected ones", () => {
    expect(planRuleSave({ currentServerIds: ["a"], targetServerIds: ["a", "b"] })).toEqual({
      write: ["a", "b"],
      remove: [],
    });
  });

  it("removes the rule from a deselected host", () => {
    expect(planRuleSave({ currentServerIds: ["a", "b"], targetServerIds: ["b"] })).toEqual({
      write: ["b"],
      remove: ["a"],
    });
  });

  it("has nothing to write for a rule taken off every host", () => {
    expect(planRuleSave({ currentServerIds: ["a"], targetServerIds: [] })).toEqual({
      write: [],
      remove: ["a"],
    });
  });
});

describe("describeRuleOutcomes", () => {
  it("has nothing to report when every host succeeded", () => {
    expect(describeRuleOutcomes([{ serverId: "a", serverName: "A", error: null }], t)).toBe(null);
  });

  // The successes are named because they are not rolled back: the rule really is
  // live on one host and not the other, and a message listing only the failure
  // would read as though the save had not happened at all.
  it("names the hosts that succeeded alongside the one that failed", () => {
    const message = describeRuleOutcomes(
      [
        { serverId: "a", serverName: "A", error: null },
        { serverId: "b", serverName: "B", error: "offline" },
      ],
      t,
    );
    expect(message).toContain("A");
    expect(message).toContain("B|offline");
  });

  it("reports a total failure without claiming a success", () => {
    const message = describeRuleOutcomes([{ serverId: "b", serverName: "B", error: "offline" }], t);
    expect(message).toBe("settings.rules.hostFailed(B|offline)");
  });
});
