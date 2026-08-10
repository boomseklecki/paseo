import { describe, expect, it } from "vitest";

import type { PreSendFinding } from "@getpaseo/protocol/pre-send-checks/types";
import type { StreamItem } from "@/types/stream";
import {
  buildPreSendMeasurementContext,
  formatPreSendFinding,
  isPreSendOverrideValid,
  resolveLastTurnEndAt,
} from "./pre-send-checks";

function item(isoTimestamp: string): StreamItem {
  return {
    kind: "assistant_message",
    id: `item-${isoTimestamp}`,
    text: "hi",
    timestamp: new Date(isoTimestamp),
  } as StreamItem;
}

// The translator is the identity on the key plus its interpolation values, so a
// test asserts which key was chosen and what was passed to it rather than
// depending on the English copy.
const t = (key: string, options?: Record<string, unknown>) => {
  const { defaultValue, ...values } = options ?? {};
  const base = typeof defaultValue === "string" ? defaultValue : key;
  return Object.entries(values).reduce<string>(
    (text, [name, value]) => text.split(`{{${name}}}`).join(String(value)),
    base,
  );
};

describe("resolveLastTurnEndAt", () => {
  const lastUserMessageAt = new Date("2026-08-09T10:00:00.000Z");

  it("prefers the newest head item", () => {
    expect(
      resolveLastTurnEndAt({
        head: [item("2026-08-09T12:00:00.000Z"), item("2026-08-09T13:00:00.000Z")],
        tail: [item("2026-08-09T11:00:00.000Z")],
        lastUserMessageAt,
      }),
    ).toEqual(new Date("2026-08-09T13:00:00.000Z"));
  });

  it("falls back to the newest tail item when head is empty", () => {
    expect(
      resolveLastTurnEndAt({
        head: [],
        tail: [item("2026-08-09T11:00:00.000Z"), item("2026-08-09T11:30:00.000Z")],
        lastUserMessageAt,
      }),
    ).toEqual(new Date("2026-08-09T11:30:00.000Z"));
  });

  it("falls back to the last user message when the timeline is empty", () => {
    expect(resolveLastTurnEndAt({ head: [], tail: [], lastUserMessageAt })).toEqual(
      lastUserMessageAt,
    );
  });

  it("returns null when nothing is known", () => {
    expect(resolveLastTurnEndAt({ head: [], tail: [], lastUserMessageAt: null })).toBeNull();
  });
});

describe("buildPreSendMeasurementContext", () => {
  const base = {
    head: [],
    tail: [],
    lastUserMessageAt: null,
    contextWindowUsedTokens: null,
    contextWindowMaxTokens: null,
    totalCostUsd: null,
    nowMs: Date.parse("2026-08-09T13:00:00.000Z"),
  };

  it("measures idle seconds from the newest timeline item", () => {
    const context = buildPreSendMeasurementContext({
      ...base,
      head: [item("2026-08-09T12:00:00.000Z")],
    });
    expect(context.idleSeconds).toBe(3600);
  });

  it("reports unknown idle when there is no timestamp at all", () => {
    expect(buildPreSendMeasurementContext(base).idleSeconds).toBeNull();
  });

  // The daemon's clock and this client's are never reconciled, so a client
  // running behind must not produce negative idle.
  it("clamps idle to zero when the client clock is behind the daemon", () => {
    const context = buildPreSendMeasurementContext({
      ...base,
      head: [item("2026-08-09T14:00:00.000Z")],
    });
    expect(context.idleSeconds).toBe(0);
  });

  it("computes context used as a percentage", () => {
    const context = buildPreSendMeasurementContext({
      ...base,
      contextWindowUsedTokens: 50_000,
      contextWindowMaxTokens: 200_000,
    });
    expect(context.contextUsedPercent).toBe(25);
  });

  it("reports unknown context percent rather than dividing by zero", () => {
    const context = buildPreSendMeasurementContext({
      ...base,
      contextWindowUsedTokens: 50_000,
      contextWindowMaxTokens: 0,
    });
    expect(context.contextUsedPercent).toBeNull();
  });

  it("passes session cost through", () => {
    expect(buildPreSendMeasurementContext({ ...base, totalCostUsd: 4.2 }).sessionCostUsd).toBe(4.2);
  });
});

describe("formatPreSendFinding", () => {
  function finding(overrides: Partial<PreSendFinding> = {}): PreSendFinding {
    return {
      ruleId: "cold-prompt-cache",
      measurement: "agent.idleSeconds",
      disposition: "block",
      value: 7200,
      threshold: 3600,
      message: null,
      action: null,
      ...overrides,
    };
  }

  it("uses the translated default for a rule with no message", () => {
    expect(formatPreSendFinding(finding(), t)).toBe(
      "composer.preSendChecks.idleSeconds composer.preSendChecks.overrideHint",
    );
  });

  it("prefers the rule's own message and interpolates the duration", () => {
    expect(formatPreSendFinding(finding({ message: "Idle for {{duration}}" }), t)).toBe(
      "Idle for 2h composer.preSendChecks.overrideHint",
    );
  });

  it("omits the override hint for a warning, which sends anyway", () => {
    expect(formatPreSendFinding(finding({ disposition: "warn", message: "Careful" }), t)).toBe(
      "Careful",
    );
  });

  it("formats a percentage measurement as a percentage", () => {
    const text = formatPreSendFinding(
      finding({
        measurement: "agent.contextUsedPercent",
        message: "{{value}} of {{threshold}}",
        value: 82.4,
        threshold: 80,
        disposition: "warn",
      }),
      t,
    );
    expect(text).toBe("82% of 80%");
  });

  it("formats a cost measurement as currency", () => {
    const text = formatPreSendFinding(
      finding({
        measurement: "agent.sessionCostUsd",
        message: "{{value}} of {{threshold}}",
        value: 12.5,
        threshold: 10,
        disposition: "warn",
      }),
      t,
    );
    expect(text).toBe("$12.50 of $10.00");
  });
});

describe("isPreSendOverrideValid", () => {
  const nowMs = Date.parse("2026-08-09T13:00:00.000Z");
  const override = { agentId: "agent-1", message: "hello", atMs: nowMs - 30_000 };

  it("accepts the same text on the same agent inside the window", () => {
    expect(isPreSendOverrideValid(override, { agentId: "agent-1", message: "hello", nowMs })).toBe(
      true,
    );
  });

  it("rejects when there is no override", () => {
    expect(isPreSendOverrideValid(null, { agentId: "agent-1", message: "hello", nowMs })).toBe(
      false,
    );
  });

  // A tab can be retargeted at another agent without the composer remounting, so
  // an override earned against one agent must not carry to the next.
  it("rejects an override earned against a different agent", () => {
    expect(isPreSendOverrideValid(override, { agentId: "agent-2", message: "hello", nowMs })).toBe(
      false,
    );
  });

  it("rejects edited text, which is new intent", () => {
    expect(isPreSendOverrideValid(override, { agentId: "agent-1", message: "hello!", nowMs })).toBe(
      false,
    );
  });

  it("rejects an override older than the window", () => {
    expect(
      isPreSendOverrideValid(override, {
        agentId: "agent-1",
        message: "hello",
        nowMs: nowMs + 60_000,
      }),
    ).toBe(false);
  });
});
