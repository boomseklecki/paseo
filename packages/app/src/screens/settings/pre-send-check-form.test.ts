import { describe, expect, it } from "vitest";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import {
  applyPreSendCheckDraft,
  describePreSendCheck,
  movePreSendCheck,
  previewPreSendCheckMessage,
  preSendCheckOptions,
  PRE_SEND_OPERATOR_OPTIONS,
  toPreSendCheckDraft,
  validatePreSendCheckDraft,
  type PreSendCheckDraft,
} from "./pre-send-check-form";

const RULE: PreSendCheckRule = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

function draft(overrides: Partial<PreSendCheckDraft> = {}): PreSendCheckDraft {
  return { ...toPreSendCheckDraft(RULE), ...overrides };
}

const t = (key: string) => key;

describe("toPreSendCheckDraft", () => {
  it("renders the threshold as a string and a missing message as empty", () => {
    expect(toPreSendCheckDraft(RULE)).toEqual({
      measurement: "agent.idleSeconds",
      operator: "gte",
      threshold: "3600",
      disposition: "block",
      message: "",
    });
  });
});

describe("applyPreSendCheckDraft", () => {
  it("parses the threshold back to a number", () => {
    const saved = applyPreSendCheckDraft({
      existing: RULE,
      draft: draft({ threshold: " 60 " }),
      id: RULE.id,
    });
    expect(saved.threshold).toBe(60);
  });

  it("drops an emptied message rather than storing a blank one", () => {
    const withMessage = { ...RULE, message: "old" };
    const saved = applyPreSendCheckDraft({
      existing: withMessage,
      draft: draft({ message: "   " }),
      id: RULE.id,
    });
    expect(saved).not.toHaveProperty("message");
  });

  // A rule written by a newer daemon must survive an edit made by this one. The
  // wire schema passes unknown fields through; this is the other half of that.
  it("keeps a field it does not recognise", () => {
    const saved = applyPreSendCheckDraft({
      existing: { ...RULE, severity: "high" } as PreSendCheckRule,
      draft: draft({ threshold: "60" }),
      id: RULE.id,
    });
    expect(saved).toMatchObject({ severity: "high", threshold: 60 });
  });

  // The regression pin for the note on the wire schema: an editor that only knows
  // four operators must not be able to launder a fifth into one on save.
  it("round-trips an operator it does not recognise", () => {
    const odd = { ...RULE, operator: "approaches" };
    const saved = applyPreSendCheckDraft({
      existing: odd,
      draft: toPreSendCheckDraft(odd),
      id: odd.id,
    });
    expect(saved.operator).toBe("approaches");
  });

  it("builds a rule with no existing record", () => {
    const saved = applyPreSendCheckDraft({ existing: null, draft: draft(), id: "new-one" });
    expect(saved).toEqual({ ...RULE, id: "new-one" });
  });
});

describe("validatePreSendCheckDraft", () => {
  it("accepts a complete draft", () => {
    expect(validatePreSendCheckDraft(draft())).toEqual({});
  });

  it("rejects a threshold that is empty or not a number", () => {
    expect(validatePreSendCheckDraft(draft({ threshold: "" })).threshold).toBeDefined();
    expect(validatePreSendCheckDraft(draft({ threshold: "soon" })).threshold).toBeDefined();
  });

  it("accepts a negative or fractional threshold", () => {
    expect(validatePreSendCheckDraft(draft({ threshold: "0.5" }))).toEqual({});
    expect(validatePreSendCheckDraft(draft({ threshold: "-1" }))).toEqual({});
  });

  it("rejects an empty picker value", () => {
    expect(validatePreSendCheckDraft(draft({ measurement: "" })).measurement).toBeDefined();
    expect(validatePreSendCheckDraft(draft({ disposition: "" })).disposition).toBeDefined();
  });
});

describe("preSendCheckOptions", () => {
  it("offers the known values unchanged when the current one is among them", () => {
    expect(preSendCheckOptions(PRE_SEND_OPERATOR_OPTIONS, "gte")).toEqual([
      ...PRE_SEND_OPERATOR_OPTIONS,
    ]);
  });

  // Without this the picker cannot represent the rule it was opened on, so saving
  // would silently replace the value with whichever option happened to be first.
  it("adds an unrecognised current value so it stays selectable", () => {
    expect(preSendCheckOptions(PRE_SEND_OPERATOR_OPTIONS, "approaches")).toContain("approaches");
  });

  it("does not add an empty current value", () => {
    expect(preSendCheckOptions(PRE_SEND_OPERATOR_OPTIONS, "")).toEqual([
      ...PRE_SEND_OPERATOR_OPTIONS,
    ]);
  });
});

describe("movePreSendCheck", () => {
  const rules = [
    { ...RULE, id: "a" },
    { ...RULE, id: "b" },
    { ...RULE, id: "c" },
  ];

  it("moves a rule up one place", () => {
    expect(movePreSendCheck(rules, "c", "up")).toEqual(["a", "c", "b"]);
  });

  it("moves a rule down one place", () => {
    expect(movePreSendCheck(rules, "a", "down")).toEqual(["b", "a", "c"]);
  });

  // Returned unchanged rather than throwing, so the caller can compare and skip
  // a write that would broadcast a reorder nobody asked for.
  it("leaves the order alone at either end", () => {
    expect(movePreSendCheck(rules, "a", "up")).toEqual(["a", "b", "c"]);
    expect(movePreSendCheck(rules, "c", "down")).toEqual(["a", "b", "c"]);
  });

  it("leaves the order alone for a rule that is not there", () => {
    expect(movePreSendCheck(rules, "missing", "up")).toEqual(["a", "b", "c"]);
  });
});

describe("applyPreSendCheckDraft ordering", () => {
  // The form has no ordering control, so an edit must not quietly send the rule
  // back to the bottom of the list.
  it("keeps the rule's position through an edit", () => {
    const saved = applyPreSendCheckDraft({
      existing: { ...RULE, order: 2 },
      draft: draft({ threshold: "60" }),
      id: RULE.id,
    });
    expect(saved.order).toBe(2);
  });
});

describe("previewPreSendCheckMessage", () => {
  // A raw {{value}} on a settings row reads as broken. The threshold stands in
  // because it is the point at which the message actually appears.
  it("fills the tokens with the threshold in the measurement's units", () => {
    expect(
      previewPreSendCheckMessage(
        { ...RULE, measurement: "agent.sessionCostUsd", threshold: 25, message: "Cost {{value}}." },
        (_key, options) => `Cost ${String(options?.value)}.`,
      ),
    ).toBe("Cost $25.00.");
  });

  it("has nothing to preview for a rule with no message", () => {
    expect(previewPreSendCheckMessage(RULE, t)).toBeNull();
  });
});

describe("describePreSendCheck", () => {
  it("reads as a sentence in the same units the toast uses", () => {
    expect(describePreSendCheck(RULE, t)).toBe(
      "settings.preSendChecks.measurements.idleSeconds ≥ 1h",
    );
  });

  it("formats a percentage and a cost", () => {
    expect(
      describePreSendCheck({ ...RULE, measurement: "agent.contextUsedPercent", threshold: 80 }, t),
    ).toContain("80%");
    expect(
      describePreSendCheck({ ...RULE, measurement: "agent.sessionCostUsd", threshold: 10 }, t),
    ).toContain("$10.00");
  });

  it("falls back to the raw values for anything unrecognised", () => {
    const described = describePreSendCheck(
      { ...RULE, measurement: "agent.somethingNew", operator: "approaches" },
      t,
    );
    expect(described).toBe("agent.somethingNew approaches 3600");
  });
});
