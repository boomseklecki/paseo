import { describe, expect, it } from "vitest";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import {
  applyPreSendCheckDraft,
  describePreSendCheck,
  gatePreSendCheckSave,
  preSendCheckChoosesHosts,
  preSendCheckExampleToDraft,
  applyPreSendEventChange,
  addPreSendOutcome,
  nextPreSendOutcomeKind,
  preSendOutcomeKindOptions,
  preSendOutcomeKindsForRow,
  preSendOutcomeOptions,
  removePreSendOutcome,
  setPreSendOutcomeKind,
  setPreSendOutcomeParam,
  preSendTriggerOptions,
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

// One descriptor, because what matters is that a runnable kind appears only when
// the daemon described it — not which kind it happens to be.
const ASIDE_DESCRIPTORS = [{ kind: "aside", label: "Ask on the side", parameters: [] }];

describe("toPreSendCheckDraft", () => {
  it("renders the threshold as a string and a missing message as empty", () => {
    expect(toPreSendCheckDraft(RULE)).toEqual({
      // A rule written before `event` existed meant the send.
      event: "message.send",
      trigger: "agent.idleSeconds",
      operator: "gte",
      value: "3600",
      outcomes: [{ kind: "block", params: {} }],
      message: "",
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
      outcomes: [{ kind: "aside", params: { title: "Aside" } }],
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

  it("keeps only the parameters the chosen outcome declares", () => {
    const saved = applyPreSendCheckDraft({
      existing: null,
      draft: draft({
        outcomes: [{ kind: "aside", params: { title: "Aside", leftover: "from another kind" } }],
      }),
      id: "r",
      descriptors: [
        { kind: "aside", label: "Aside", parameters: [{ type: "text", id: "title", label: "T" }] },
      ],
    });
    expect(saved.outcomes).toEqual([{ kind: "aside", title: "Aside" }]);
  });

  // The whole point of the list, and the combination it was asked for by name.
  it("writes every outcome, in the order the editor holds them", () => {
    const saved = applyPreSendCheckDraft({
      existing: null,
      draft: draft({
        outcomes: [
          { kind: "block", params: {} },
          { kind: "aside", params: { title: "Aside" } },
        ],
      }),
      id: "r",
      descriptors: [
        { kind: "aside", label: "Aside", parameters: [{ type: "text", id: "title", label: "T" }] },
      ],
    });

    expect(saved.outcomes).toEqual([{ kind: "block" }, { kind: "aside", title: "Aside" }]);
    // An older reader gets the one that decides what happens to the message.
    expect(saved.disposition).toBe("redirect");
    expect(saved.action).toEqual({ kind: "aside", title: "Aside" });
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
      outcomes: [{ kind: "block" }],
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
    expect(validatePreSendCheckDraft(draft({ outcomes: [] })).outcomes).toBeDefined();
  });

  // Both are states the wire would accept and nobody meant: a rule with no
  // outcome is stored, evaluated, and does nothing, and two asides on one
  // condition is two identical subagents rather than two questions.
  it("rejects an outcome listed twice", () => {
    expect(
      validatePreSendCheckDraft(
        draft({
          outcomes: [
            { kind: "warn", params: {} },
            { kind: "warn", params: {} },
          ],
        }),
      ).outcomes,
    ).toBe("settings.preSendChecks.outcomeDuplicate");
  });

  it("accepts two different outcomes", () => {
    expect(
      validatePreSendCheckDraft(
        draft({
          outcomes: [
            { kind: "block", params: {} },
            { kind: "aside", params: {} },
          ],
        }),
      ),
    ).toEqual({});
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
  it("opens a redirect example with its outcome and parameters filled in", () => {
    const built = preSendCheckExampleToDraft({
      id: "aside-on-btw",
      label: "Answer /btw on the side",
      rule: {
        trigger: "message",
        operator: "startsWith",
        value: "/btw",
        outcomes: [{ kind: "aside", title: "Aside", prompt: "Answer this.\n\n{{message}}" }],
      },
    });

    expect(built).toEqual({
      event: "message.send",
      trigger: "message",
      operator: "startsWith",
      // The one input holds whichever operand applies, and a text trigger's is
      // `text` rather than `threshold`.
      value: "/btw",
      outcomes: [
        { kind: "aside", params: { title: "Aside", prompt: "Answer this.\n\n{{message}}" } },
      ],
      message: "",
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
        outcomes: [{ kind: "warn" }],
        message: "Nearly full.",
      },
    });

    expect(built.value).toBe("80");
    expect(built.message).toBe("Nearly full.");
    expect(built.outcomes).toEqual([{ kind: "warn", params: {} }]);
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
        outcomes: [{ kind: "block" }],
      },
    });

    expect(built).not.toHaveProperty("id");
  });
});

describe("describePreSendCheck for a text rule", () => {
  // This read "message startsWith /btw" - two raw wire values, in the row a
  // person is most likely to be looking at, because both label tables predated
  // text triggers.
  it("names the message trigger and spells the operator as a phrase", () => {
    const described = describePreSendCheck(
      {
        id: "aside",
        measurement: "message",
        operator: "startsWith",
        text: "/btw",
        disposition: "redirect",
        action: { kind: "aside" },
      },
      t,
    );

    expect(described).toBe(
      "settings.preSendChecks.triggers.message settings.preSendChecks.operatorPhrases.startsWith /btw",
    );
  });
});

describe("what a seam offers the editor", () => {
  it("offers the message trigger only where a message is being sent", () => {
    expect(preSendTriggerOptions("message.send")).toContain("message");
    expect(preSendTriggerOptions("turn.failed")).not.toContain("message");
  });

  // A rule from a newer daemon must stay editable rather than showing a picker
  // with nothing in it.
  it("offers the composer's set for a seam it has never heard of", () => {
    expect(preSendOutcomeKindOptions("moon.rose", ASIDE_DESCRIPTORS)).toEqual(["warn", "block"]);
    expect(preSendTriggerOptions("moon.rose").length).toBeGreaterThan(0);
  });

  it("offers only the outcomes a seam will carry out", () => {
    const descriptors = [
      { kind: "aside", label: "Aside", parameters: [] },
      { kind: "teleport", label: "Teleport", parameters: [] },
    ];

    expect(preSendOutcomeOptions("message.send", descriptors).map((d) => d.kind)).toEqual([
      "aside",
    ]);
  });
});

describe("applyPreSendEventChange", () => {
  // Leaving a picker showing something its new seam rejects is how someone
  // saves a rule that is stored, evaluated, and silently does nothing.
  it("drops a trigger the new seam cannot use", () => {
    const moved = applyPreSendEventChange(draft({ trigger: "message" }), "turn.failed");

    expect(moved.event).toBe("turn.failed");
    expect(moved.trigger).not.toBe("message");
    expect(preSendTriggerOptions("turn.failed")).toContain(moved.trigger);
  });

  // Emptying the list would be saving a rule that does nothing, so a draft left
  // with none falls back to a row of whatever the new seam offers first.
  it("drops an outcome the new seam cannot carry out", () => {
    const moved = applyPreSendEventChange(
      draft({ outcomes: [{ kind: "block", params: {} }] }),
      "turn.failed",
    );

    expect(moved.outcomes).toEqual([{ kind: "notify", params: {} }]);
  });

  it("keeps what the new seam still accepts", () => {
    const moved = applyPreSendEventChange(
      draft({
        trigger: "agent.sessionCostUsd",
        outcomes: [{ kind: "aside", params: { title: "Aside" } }],
      }),
      "turn.failed",
      ASIDE_DESCRIPTORS,
    );

    expect(moved.trigger).toBe("agent.sessionCostUsd");
    expect(moved.outcomes).toEqual([{ kind: "aside", params: { title: "Aside" } }]);
  });

  // Filtered rather than reset, so a rule that says notify and fork keeps both
  // when it moves between two daemon seams.
  it("keeps the outcomes the new seam accepts and drops only the rest", () => {
    const moved = applyPreSendEventChange(
      draft({
        outcomes: [
          { kind: "block", params: {} },
          { kind: "aside", params: {} },
        ],
      }),
      "turn.failed",
      ASIDE_DESCRIPTORS,
    );

    expect(moved.outcomes).toEqual([{ kind: "aside", params: {} }]);
  });
});

describe("preSendOutcomeKindOptions", () => {
  // One list where there were two. `redirect` was a word in the interface that
  // named nothing in the rule - it existed only to introduce a second picker.
  it("offers the plain kinds and every runnable one the daemon described", () => {
    expect(preSendOutcomeKindOptions("message.send", ASIDE_DESCRIPTORS)).toEqual([
      "warn",
      "block",
      "aside",
    ]);
    expect(preSendOutcomeKindOptions("message.send", [])).not.toContain("redirect");
  });

  // This build can name `fork` all it likes; a daemon that cannot perform one
  // would take the message and decline.
  it("leaves out a runnable kind the daemon did not describe", () => {
    expect(preSendOutcomeKindOptions("message.send", [])).toEqual(["warn", "block"]);
  });

  it("offers only what a daemon seam accepts", () => {
    const kinds = preSendOutcomeKindOptions("turn.failed", ASIDE_DESCRIPTORS);

    expect(kinds).toContain("notify");
    expect(kinds).not.toContain("block");
  });
});

describe("preSendOutcomeKindsForRow", () => {
  // Removing the error state rather than reporting it, and what makes a row's
  // kind a sound React key.
  it("leaves out what a sibling row already holds", () => {
    const two = draft({
      outcomes: [
        { kind: "warn", params: {} },
        { kind: "block", params: {} },
      ],
    });

    expect(preSendOutcomeKindsForRow(two, 0, ASIDE_DESCRIPTORS)).toEqual(["warn", "aside"]);
    expect(preSendOutcomeKindsForRow(two, 1, ASIDE_DESCRIPTORS)).toEqual(["block", "aside"]);
  });

  it("always keeps the row's own kind, or the picker would show nothing", () => {
    const one = draft({ outcomes: [{ kind: "warn", params: {} }] });

    expect(preSendOutcomeKindsForRow(one, 0, [])).toContain("warn");
  });
});

describe("editing the outcome list", () => {
  it("adds the first kind the seam accepts that is not already listed", () => {
    const one = draft({ outcomes: [{ kind: "warn", params: {} }] });

    expect(nextPreSendOutcomeKind(one, ASIDE_DESCRIPTORS)).toBe("block");
    expect(addPreSendOutcome(one, "block").outcomes).toEqual([
      { kind: "warn", params: {} },
      { kind: "block", params: {} },
    ]);
  });

  // What hides the button rather than showing one that does nothing.
  it("has nothing left to add once every kind is listed", () => {
    const full = draft({
      outcomes: [
        { kind: "warn", params: {} },
        { kind: "block", params: {} },
      ],
    });

    expect(nextPreSendOutcomeKind(full, [])).toBeNull();
    expect(addPreSendOutcome(full, null)).toBe(full);
  });

  // A rule with no outcomes fires and does nothing, so the last `-` is refused
  // rather than allowed and then complained about.
  it("refuses to empty the list", () => {
    const one = draft({ outcomes: [{ kind: "warn", params: {} }] });

    expect(removePreSendOutcome(one, 0)).toBe(one);
  });

  it("removes by position", () => {
    const two = draft({
      outcomes: [
        { kind: "warn", params: {} },
        { kind: "block", params: {} },
      ],
    });

    expect(removePreSendOutcome(two, 0).outcomes).toEqual([{ kind: "block", params: {} }]);
  });

  // Switching kind and back should not lose the prompt; only the parameters the
  // saved kind declares are written anyway.
  it("keeps what was typed when the kind changes", () => {
    const one = draft({ outcomes: [{ kind: "aside", params: { title: "Aside" } }] });

    expect(setPreSendOutcomeKind(one, 0, "start").outcomes).toEqual([
      { kind: "start", params: { title: "Aside" } },
    ]);
  });

  it("sets one parameter on one row", () => {
    const two = draft({
      outcomes: [
        { kind: "aside", params: {} },
        { kind: "start", params: {} },
      ],
    });

    expect(setPreSendOutcomeParam(two, 1, "title", "Continued").outcomes).toEqual([
      { kind: "aside", params: {} },
      { kind: "start", params: { title: "Continued" } },
    ]);
  });
});
