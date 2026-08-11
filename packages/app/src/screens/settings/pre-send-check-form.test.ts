import { describe, expect, it } from "vitest";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import {
  applyPreSendCheckDraft,
  describePreSendCheck,
  gatePreSendCheckSave,
  preSendCheckChoosesHosts,
  preSendCheckExampleToDraft,
  movePreSendCheck,
  previewPreSendCheckMessage,
  preSendCheckOptions,
  PRE_SEND_OPERATOR_OPTIONS,
  toPreSendCheckDraft,
  validatePreSendCheckDraft,
  type PreSendCheckDraft,
} from "./pre-send-check-form";

// Deliberately written the old way: `measurement` is still required on the wire,
// and a rule stored before the rename has to read back the same.
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
      // A rule written before `event` existed meant the send.
      event: "message.send",
      trigger: "agent.idleSeconds",
      operator: "gte",
      value: "3600",
      disposition: "block",
      message: "",
      actionKind: "",
      actionParams: {},
    });
  });

  // The text a trigger matches lives in `text`, not `threshold`, but the editor
  // has one input for whichever applies — two fields that are never both
  // meaningful would be two ways to say the same thing.
  it("reads a text rule's operand out of text rather than threshold", () => {
    expect(
      toPreSendCheckDraft({
        id: "aside",
        measurement: "message",
        operator: "startsWith",
        text: "/btw",
        disposition: "redirect",
        action: { kind: "aside", title: "Aside" },
      }),
    ).toMatchObject({
      value: "/btw",
      actionKind: "aside",
      actionParams: { title: "Aside" },
    });
  });
});

describe("applyPreSendCheckDraft", () => {
  it("parses the threshold back to a number", () => {
    const saved = applyPreSendCheckDraft({
      existing: RULE,
      draft: draft({ value: " 60 " }),
      id: RULE.id,
    });
    expect(saved.value).toBe(60);
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
      draft: draft({ value: "60" }),
      id: RULE.id,
    });
    expect(saved).toMatchObject({ severity: "high", value: 60 });
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

  // A text rule and a numeric one must never both be on the same record: a rule
  // carrying both compares against whichever the evaluator happens to read.
  it("writes text for a trigger and clears any threshold it had", () => {
    const saved = applyPreSendCheckDraft({
      existing: RULE,
      draft: draft({ trigger: "message", operator: "startsWith", value: "/btw" }),
      id: RULE.id,
    });
    expect(saved.text).toBe("/btw");
    expect(saved).not.toHaveProperty("threshold");
  });

  it("writes threshold for a numeric rule and clears any text it had", () => {
    const saved = applyPreSendCheckDraft({
      existing: { ...RULE, text: "/btw" },
      draft: draft({ value: "60" }),
      id: RULE.id,
    });
    expect(saved.value).toBe(60);
    expect(saved).not.toHaveProperty("text");
  });

  it("keeps only the parameters the chosen action declares", () => {
    const saved = applyPreSendCheckDraft({
      existing: null,
      draft: draft({
        disposition: "redirect",
        actionKind: "aside",
        actionParams: { title: "Aside", leftover: "from another kind" },
      }),
      id: "r",
      descriptors: [
        { kind: "aside", label: "Aside", parameters: [{ type: "text", id: "title", label: "T" }] },
      ],
    });
    expect(saved.action).toEqual({ kind: "aside", title: "Aside" });
  });

  it("drops the action when the disposition is not a redirect", () => {
    const saved = applyPreSendCheckDraft({
      existing: { ...RULE, action: { kind: "aside" } },
      draft: draft({ disposition: "warn" }),
      id: RULE.id,
    });
    expect(saved).not.toHaveProperty("action");
  });

  // Both vocabularies, so a daemon that predates the rename reads the same rule.
  it("builds a rule with no existing record, written in both vocabularies", () => {
    const saved = applyPreSendCheckDraft({ existing: null, draft: draft(), id: "new-one" });

    expect(saved).toEqual({
      ...RULE,
      id: "new-one",
      event: "message.send",
      trigger: "agent.idleSeconds",
      value: 3600,
      outcome: { kind: "block" },
    });
  });
});

describe("validatePreSendCheckDraft", () => {
  it("accepts a complete draft", () => {
    expect(validatePreSendCheckDraft(draft())).toEqual({});
  });

  it("rejects a threshold that is empty or not a number", () => {
    expect(validatePreSendCheckDraft(draft({ value: "" })).value).toBeDefined();
    expect(validatePreSendCheckDraft(draft({ value: "soon" })).value).toBeDefined();
  });

  it("accepts a negative or fractional threshold", () => {
    expect(validatePreSendCheckDraft(draft({ value: "0.5" }))).toEqual({});
    expect(validatePreSendCheckDraft(draft({ value: "-1" }))).toEqual({});
  });

  it("rejects an empty picker value", () => {
    expect(validatePreSendCheckDraft(draft({ trigger: "" })).trigger).toBeDefined();
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
      draft: draft({ value: "60" }),
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
        { ...RULE, trigger: "agent.sessionCostUsd", value: 25, message: "Cost {{value}}." },
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
    expect(describePreSendCheck(RULE, t)).toBe("settings.preSendChecks.triggers.idleSeconds ≥ 1h");
  });

  it("formats a percentage and a cost", () => {
    expect(
      describePreSendCheck({ ...RULE, trigger: "agent.contextUsedPercent", value: 80 }, t),
    ).toContain("80%");
    expect(
      describePreSendCheck({ ...RULE, trigger: "agent.sessionCostUsd", value: 10 }, t),
    ).toContain("$10.00");
  });

  it("falls back to the raw values for anything unrecognised", () => {
    const described = describePreSendCheck(
      { ...RULE, trigger: "agent.somethingNew", operator: "approaches" },
      t,
    );
    expect(described).toBe("agent.somethingNew approaches 3600");
  });
});

describe("preSendCheckChoosesHosts", () => {
  it("offers no choice when there is nowhere else for a rule to go", () => {
    expect(preSendCheckChoosesHosts(0)).toBe(false);
    expect(preSendCheckChoosesHosts(1)).toBe(false);
    expect(preSendCheckChoosesHosts(2)).toBe(true);
  });
});

describe("gatePreSendCheckSave", () => {
  it("saves a complete draft with a host chosen", () => {
    expect(gatePreSendCheckSave({ draft: draft(), hostCount: 2, serverIds: ["a"] })).toEqual({
      kind: "save",
    });
  });

  it("reports field errors and says which fields", () => {
    const gate = gatePreSendCheckSave({
      draft: draft({ value: "soon" }),
      hostCount: 2,
      serverIds: ["a"],
    });

    expect(gate).toEqual({
      kind: "fieldErrors",
      errors: { value: "settings.preSendChecks.thresholdInvalid" },
    });
  });

  // Both at once would put a complaint under a field and another at the bottom
  // of the sheet, and the eye goes to the wrong one.
  it("holds the host complaint back until the fields pass", () => {
    expect(
      gatePreSendCheckSave({ draft: draft({ value: "" }), hostCount: 2, serverIds: [] }),
    ).toMatchObject({ kind: "fieldErrors" });
  });

  // A rule on no host is a delete wearing a save's clothes.
  it("refuses a save that would leave the rule on no host", () => {
    expect(gatePreSendCheckSave({ draft: draft(), hostCount: 2, serverIds: [] })).toEqual({
      kind: "hostsRequired",
    });
  });

  // The single-host setup never showed a host field, so it must not be held to
  // one: the modal would refuse a save with nothing on screen to fix.
  it("does not ask for a host the editor never offered", () => {
    expect(gatePreSendCheckSave({ draft: draft(), hostCount: 1, serverIds: [] })).toEqual({
      kind: "save",
    });
  });
});

describe("preSendCheckExampleToDraft", () => {
  it("opens a redirect example with its action and parameters filled in", () => {
    const built = preSendCheckExampleToDraft({
      id: "aside-on-btw",
      label: "Answer /btw on the side",
      rule: {
        trigger: "message",
        operator: "startsWith",
        value: "/btw",
        outcome: { kind: "aside", title: "Aside", prompt: "Answer this.\n\n{{message}}" },
      },
    });

    expect(built).toEqual({
      event: "message.send",
      trigger: "message",
      operator: "startsWith",
      // The one input holds whichever operand applies, and a text trigger's is
      // `text` rather than `threshold`.
      value: "/btw",
      disposition: "redirect",
      message: "",
      actionKind: "aside",
      actionParams: { title: "Aside", prompt: "Answer this.\n\n{{message}}" },
    });
  });

  it("opens a numeric example with the threshold as text", () => {
    const built = preSendCheckExampleToDraft({
      id: "warn-context-nearly-full",
      label: "Warn when the context is nearly full",
      rule: {
        trigger: "agent.contextUsedPercent",
        operator: "gte",
        value: 80,
        outcome: { kind: "warn" },
        message: "Nearly full.",
      },
    });

    expect(built.value).toBe("80");
    expect(built.message).toBe("Nearly full.");
    expect(built.actionKind).toBe("");
  });

  // The template's id names the example, not the rule: a rule gets its own at
  // save, which is what lets the same example be added twice.
  it("carries no id into the draft", () => {
    const built = preSendCheckExampleToDraft({
      id: "block-cold-prompt-cache",
      label: "Block when the prompt cache has gone cold",
      rule: {
        trigger: "agent.idleSeconds",
        operator: "gte",
        value: 3600,
        outcome: { kind: "block" },
      },
    });

    expect(built).not.toHaveProperty("id");
  });
});
