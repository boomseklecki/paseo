import { describe, expect, test } from "vitest";
import { isPreSendCheckRuleId, PreSendCheckRuleSchema } from "./types.js";

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
    expect(isPreSendCheckRuleId("a3f19c02b4e77d51")).toBe(true);
    expect(isPreSendCheckRuleId("cold-prompt-cache")).toBe(true);
    expect(isPreSendCheckRuleId("Rule_1.v2")).toBe(true);
  });

  test("refuses an id that is not one path segment", () => {
    expect(isPreSendCheckRuleId("../escaped")).toBe(false);
    expect(isPreSendCheckRuleId("nested/rule")).toBe(false);
    expect(isPreSendCheckRuleId("")).toBe(false);
    // Both pass the character set and neither is a name.
    expect(isPreSendCheckRuleId(".")).toBe(false);
    expect(isPreSendCheckRuleId("..")).toBe(false);
  });

  test("refuses what a filesystem would take but nobody meant", () => {
    expect(isPreSendCheckRuleId("two words")).toBe(false);
    expect(isPreSendCheckRuleId("line\nbreak")).toBe(false);
    expect(isPreSendCheckRuleId("café")).toBe(false);
    expect(isPreSendCheckRuleId("x".repeat(121))).toBe(false);
  });

  // The point of moving the constraint here: the client mints the id, so the
  // wire is where being wrong about one should be answered. The daemon's store
  // checks again at the point it builds a path, and that check is the one that
  // has to hold even when nothing parsed the rule first.
  test("rejects a rule carrying one at parse", () => {
    expect(PreSendCheckRuleSchema.safeParse(RULE).success).toBe(true);
    expect(PreSendCheckRuleSchema.safeParse({ ...RULE, id: "../escaped" }).success).toBe(false);
  });
});
