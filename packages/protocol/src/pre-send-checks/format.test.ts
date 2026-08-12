import { describe, expect, it } from "vitest";

import { formatPreSendTriggerValue, renderPreSendWording } from "./format.js";
import { PRE_SEND_TRIGGERS, PRE_SEND_TRIGGER_UNITS } from "./types.js";

/**
 * Units are shared by the editor, the toast and the prompt a daemon-side outcome
 * receives. The failure worth guarding is not a wrong unit but a *missing* one:
 * a trigger whose value renders as a bare number reads "3600" where the rule
 * said "1h", and nothing anywhere reports it.
 */
describe("formatPreSendTriggerValue", () => {
  it("renders each unit in the terms its trigger is about", () => {
    expect(formatPreSendTriggerValue("agent.idleSeconds", 3600)).toBe("1h");
    expect(formatPreSendTriggerValue("agent.secondsSinceUserMessage", 90)).toBe("1m 30s");
    expect(formatPreSendTriggerValue("agent.contextUsedPercent", 80.4)).toBe("80%");
    expect(formatPreSendTriggerValue("agent.sessionCostUsd", 25)).toBe("$25.00");
    expect(formatPreSendTriggerValue("agent.contextRemainingTokens", 20_000)).toBe("20k");
  });

  // Below a thousand the exact number is the useful one.
  it("does not round a small token count into nothing", () => {
    expect(formatPreSendTriggerValue("agent.contextRemainingTokens", 400)).toBe("400");
  });

  // A text trigger's value is the text; `always` carries none.
  it("passes a non-number through as itself", () => {
    expect(formatPreSendTriggerValue("message", "/btw hello")).toBe("/btw hello");
    expect(formatPreSendTriggerValue("agent.lastError", "rate limit")).toBe("rate limit");
    expect(formatPreSendTriggerValue("agent.idleSeconds", undefined)).toBe("");
  });

  // Fail open, the same as everywhere else: a rule from a newer daemon shows a
  // number rather than throwing.
  it("shows a trigger it has never heard of as a plain number", () => {
    expect(formatPreSendTriggerValue("agent.phaseOfMoon", 42)).toBe("42");
  });

  // The guarantee the unit table buys, checked rather than assumed: every
  // declared trigger renders as something other than the raw number, except the
  // two that have no unit to apply.
  it("gives every numeric trigger a rendering of its own", () => {
    for (const trigger of PRE_SEND_TRIGGERS) {
      const unit = PRE_SEND_TRIGGER_UNITS[trigger];
      if (unit === "text" || unit === "none") {
        continue;
      }
      expect(formatPreSendTriggerValue(trigger, 3600)).not.toBe("3600");
    }
  });
});

describe("renderPreSendWording", () => {
  // The composer gets interpolation free from i18next; the daemon has no
  // translator and was sending `{{value}}` to a phone verbatim.
  it("fills value, threshold and duration", () => {
    expect(
      renderPreSendWording("{{value}} of {{threshold}}, after {{duration}}", {
        trigger: "agent.idleSeconds",
        value: 7200,
        operand: 3600,
      }),
    ).toBe("2h of 1h, after 2h");
  });

  // A text rule's value is the message, so a formatted zero would be a lie.
  it("leaves duration empty for a trigger with no duration in it", () => {
    expect(
      renderPreSendWording("[{{duration}}]", {
        trigger: "message",
        value: "/btw",
        operand: "/btw",
      }),
    ).toBe("[]");
  });
});
