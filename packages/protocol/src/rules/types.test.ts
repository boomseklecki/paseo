import { describe, expect, test } from "vitest";
import { isRuleId, RuleSchema } from "./types.js";

const RULE = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

describe("rule ids", () => {
  test("accepts what mints them and what a person types", () => {
    // The two real sources: the app's hex slice, and a hand-written slug.
    expect(isRuleId("a3f19c02b4e77d51")).toBe(true);
    expect(isRuleId("cold-prompt-cache")).toBe(true);
    expect(isRuleId("Rule_1.v2")).toBe(true);
  });

  test("refuses an id that is not one path segment", () => {
    expect(isRuleId("../escaped")).toBe(false);
    expect(isRuleId("nested/rule")).toBe(false);
    expect(isRuleId("")).toBe(false);
    // Both pass the character set and neither is a name.
    expect(isRuleId(".")).toBe(false);
    expect(isRuleId("..")).toBe(false);
  });

  test("refuses what a filesystem would take but nobody meant", () => {
    expect(isRuleId("two words")).toBe(false);
    expect(isRuleId("line\nbreak")).toBe(false);
    expect(isRuleId("café")).toBe(false);
    expect(isRuleId("x".repeat(121))).toBe(false);
  });

  // The point of moving the constraint here: the client mints the id, so the
  // wire is where being wrong about one should be answered. The daemon's store
  // checks again at the point it builds a path, and that check is the one that
  // has to hold even when nothing parsed the rule first.
  test("rejects a rule carrying one at parse", () => {
    expect(RuleSchema.safeParse(RULE).success).toBe(true);
    expect(RuleSchema.safeParse({ ...RULE, id: "../escaped" }).success).toBe(false);
  });
});
