import { describe, expect, it } from "vitest";
import { PreSendCheckRuleSchema } from "./types.js";
import {
  DEFAULT_PRE_SEND_EVENT,
  normalizePreSendCheckRule,
  projectPreSendCheckRule,
  type NormalizedPreSendCheckRule,
} from "./vocabulary.js";

// What a rule written before the rename looks like on disk and on the wire.
const OLD_NUMERIC = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

const OLD_REDIRECT = {
  id: "btw",
  measurement: "message",
  operator: "startsWith",
  text: "/btw",
  disposition: "redirect",
  action: { kind: "aside", title: "Aside" },
};

describe("normalizePreSendCheckRule", () => {
  it("reads a numeric rule written in the old vocabulary", () => {
    expect(normalizePreSendCheckRule(OLD_NUMERIC)).toEqual({
      id: "cold-prompt-cache",
      event: DEFAULT_PRE_SEND_EVENT,
      trigger: "agent.idleSeconds",
      operator: "gte",
      value: 3600,
      outcome: { kind: "block" },
      message: undefined,
      order: undefined,
      enabled: true,
    });
  });

  // The one old word with no counterpart: `redirect` meant "the action field
  // says where", so it resolves to that action's kind.
  it("resolves an old redirect to the kind its action named", () => {
    const normalized = normalizePreSendCheckRule(OLD_REDIRECT);

    expect(normalized.trigger).toBe("message");
    expect(normalized.value).toBe("/btw");
    expect(normalized.outcome).toEqual({ kind: "aside", title: "Aside" });
  });

  // Neither build can perform a kind of "redirect", so the evaluator skips it -
  // which is the refusal the old two-field consistency check made by hand.
  it("leaves an old redirect that named no action unperformable", () => {
    const { action: _action, ...withoutAction } = OLD_REDIRECT;

    expect(normalizePreSendCheckRule(withoutAction).outcome).toEqual({ kind: "redirect" });
  });

  it("prefers the new fields when a rule carries both", () => {
    const normalized = normalizePreSendCheckRule({
      ...OLD_NUMERIC,
      trigger: "agent.contextUsedPercent",
      value: 80,
      outcome: { kind: "warn" },
    });

    expect(normalized.trigger).toBe("agent.contextUsedPercent");
    expect(normalized.value).toBe(80);
    expect(normalized.outcome).toEqual({ kind: "warn" });
  });

  it("defaults the event, since every rule predating it meant the send", () => {
    expect(normalizePreSendCheckRule(OLD_NUMERIC).event).toBe("message.send");
    expect(normalizePreSendCheckRule({ ...OLD_NUMERIC, event: "turn.failed" }).event).toBe(
      "turn.failed",
    );
  });

  // Absent means on, so a hand-written rule needs no boilerplate to be live.
  it("treats only an explicit false as off", () => {
    expect(normalizePreSendCheckRule(OLD_NUMERIC).enabled).toBe(true);
    expect(normalizePreSendCheckRule({ ...OLD_NUMERIC, enabled: false }).enabled).toBe(false);
    expect(normalizePreSendCheckRule({ ...OLD_NUMERIC, enabled: true }).enabled).toBe(true);
  });
});

describe("projectPreSendCheckRule", () => {
  const numeric: NormalizedPreSendCheckRule = {
    id: "cold-prompt-cache",
    event: DEFAULT_PRE_SEND_EVENT,
    trigger: "agent.idleSeconds",
    operator: "gte",
    value: 3600,
    outcome: { kind: "block" },
    message: undefined,
    order: undefined,
    enabled: true,
  };

  // The whole point of the projection: a rule written now is readable by a build
  // that has never heard of the new names.
  it("writes both vocabularies for a numeric rule", () => {
    expect(projectPreSendCheckRule(numeric)).toEqual({
      id: "cold-prompt-cache",
      event: "message.send",
      trigger: "agent.idleSeconds",
      measurement: "agent.idleSeconds",
      operator: "gte",
      value: 3600,
      threshold: 3600,
      outcome: { kind: "block" },
      disposition: "block",
    });
  });

  // By type rather than by looking the trigger up: a text operand is a string.
  it("writes a text operand to text and a numeric one to threshold", () => {
    const projected = projectPreSendCheckRule({ ...numeric, trigger: "message", value: "/btw" });

    expect(projected.text).toBe("/btw");
    expect(projected).not.toHaveProperty("threshold");
  });

  it("writes an action outcome as a redirect with the action beside it", () => {
    const projected = projectPreSendCheckRule({
      ...numeric,
      outcome: { kind: "aside", title: "Aside" },
    });

    expect(projected.disposition).toBe("redirect");
    expect(projected.action).toEqual({ kind: "aside", title: "Aside" });
  });

  it("writes no action for a plain outcome", () => {
    expect(projectPreSendCheckRule({ ...numeric, outcome: { kind: "warn" } })).not.toHaveProperty(
      "action",
    );
  });

  // A rule that always wrote enabled: true would be noise in every hand-edited
  // file, and absent already means on.
  it("writes enabled only when the rule is off", () => {
    expect(projectPreSendCheckRule(numeric)).not.toHaveProperty("enabled");
    expect(projectPreSendCheckRule({ ...numeric, enabled: false }).enabled).toBe(false);
  });

  it("omits an absent message and order rather than writing undefined", () => {
    const projected = projectPreSendCheckRule(numeric);

    expect(projected).not.toHaveProperty("message");
    expect(projected).not.toHaveProperty("order");
  });

  it("produces something the rule schema accepts", () => {
    for (const outcome of [{ kind: "warn" }, { kind: "block" }, { kind: "aside" }]) {
      expect(() =>
        PreSendCheckRuleSchema.parse(projectPreSendCheckRule({ ...numeric, outcome })),
      ).not.toThrow();
    }
  });
});

describe("the two together", () => {
  // The property that makes the migration safe: whichever vocabulary a rule
  // arrives in, reading it and writing it back means the same rule.
  it("round-trips a rule written in the old vocabulary", () => {
    for (const rule of [OLD_NUMERIC, OLD_REDIRECT]) {
      const once = normalizePreSendCheckRule(rule);
      const twice = normalizePreSendCheckRule(projectPreSendCheckRule(once));

      expect(twice).toEqual(once);
    }
  });

  it("round-trips a rule that only ever had the new names", () => {
    const newOnly = {
      id: "context",
      event: "turn.failed",
      measurement: "agent.contextUsedPercent",
      trigger: "agent.contextUsedPercent",
      operator: "gte",
      value: 80,
      disposition: "warn",
      outcome: { kind: "warn" },
      message: "Nearly full.",
      order: 2,
    };

    expect(
      normalizePreSendCheckRule(projectPreSendCheckRule(normalizePreSendCheckRule(newOnly))),
    ).toEqual(normalizePreSendCheckRule(newOnly));
  });
});
