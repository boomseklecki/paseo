import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { PushNotificationSender } from "../push/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/**
 * The whole daemon-side path over the wire: a rule on `turn.failed` fires when a
 * turn fails, and the notification carries the rule's own wording.
 *
 * No real provider — the fake one fails a turn on request, which is the point.
 * What only an end-to-end run can show is that the seam reaches the rules at
 * all: the evaluation and the edge trigger are unit-tested, and everything
 * between them and a client is wiring that either connects or does not.
 */
async function seedRule(paseoHomeRoot: string, rule: Record<string, unknown>): Promise<void> {
  const dir = path.join(paseoHomeRoot, ".paseo", "pre-send-checks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${String(rule.id)}.json`), JSON.stringify(rule), "utf-8");
}

describe("daemon E2E (rule on turn.failed)", () => {
  test("notifies with the rule's message when a turn fails", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-e2e-"));
    // Seeded before the daemon starts, because ensureSeeded only writes the
    // defaults when the directory does not exist at all.
    await seedRule(paseoHomeRoot, {
      id: "any-failure",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn failed and you asked to be told.",
    });

    // Captured rather than sent. The push leg is the one that reaches a phone
    // when nobody is at the machine, and it is worth an assertion precisely
    // because `error` is deliberately *not* push-eligible
    // (`agent-attention-policy.ts`) - so a rule is the only way a failed turn
    // reaches a device at all, and nothing else in the suite says so.
    const pushed: Array<{ title: string; body: string; reason: unknown }> = [];
    const pushNotificationSender: PushNotificationSender = {
      send: async (notification) => {
        pushed.push({
          title: notification.title,
          body: notification.body,
          reason: notification.data?.reason,
        });
      },
    };

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    const attention: Array<{ reason: string; body?: string }> = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-e2e" } });
      client.onAgentAttentionRequired((payload) => {
        attention.push({
          reason: payload.reason,
          body: payload.notification?.body,
        });
      });

      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Failing",
      });
      // The workspace is what the notification is attributed to; without one the
      // daemon withholds attention entirely, rule or not.
      expect(agent.workspaceId).not.toBeUndefined();

      await client.sendMessage(agent.id, "Please emit a turn failure");

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !attention.some((entry) => entry.reason === "rule")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const ruleAttention = attention.filter((entry) => entry.reason === "rule");
      expect(ruleAttention).toHaveLength(1);
      expect(ruleAttention[0]?.body).toBe("That turn failed and you asked to be told.");

      // The built-in error notification is still sent and is a different thing:
      // it says the agent stopped, where the rule says what its author asked to
      // be told. A rule does not replace it.
      expect(attention.some((entry) => entry.reason === "error")).toBe(true);

      // And the built-in one never leaves the machine. Only the rule pushes, so
      // the phone gets exactly one notification and it is the one somebody
      // asked for, in their own words.
      expect(pushed.map((entry) => entry.reason)).toEqual(["rule"]);
      expect(pushed[0]?.title).toBe("A rule fired");
      expect(pushed[0]?.body).toBe("That turn failed and you asked to be told.");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // The other daemon seam, and the one that answers "where has this
  // conversation got to". Both ride transitions the manager already detects, so
  // the risk worth testing is that they do not fire for each other.
  test("fires a turn.completed rule when a turn succeeds, and not the failure one", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-done-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "any-completion",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn finished.",
    });
    await seedRule(paseoHomeRoot, {
      id: "any-failure",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn failed.",
    });

    const pushed: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender: {
        send: async (notification) => {
          pushed.push(notification.body);
        },
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-done-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Finishing",
      });

      // An ordinary prompt, so the fake provider completes the turn rather than
      // failing it.
      await client.sendMessage(agent.id, "Say hello");

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !pushed.includes("That turn finished.")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Two pushes, and both belong. Unlike `error`, the built-in `finished`
      // attention *is* push-eligible, so a completed turn already reaches a
      // phone carrying the agent's last message. The rule adds a second saying
      // the thing the built-in cannot know to say - and only on the crossing,
      // which is what keeps "context is over 80%" from being every turn from
      // here to the end of the conversation.
      expect(pushed).toContain("That turn finished.");
      expect(pushed).toContain("Hello world");

      // The failure rule is seeded and must stay silent: the seams ride
      // different transitions and must not fire for each other.
      expect(pushed).not.toContain("That turn failed.");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // An action at a daemon seam: the same hidden agent /btw uses, asked without
  // anyone typing. This is the handoff case - write the summary before the
  // conversation compacts - and the whole point is that it happens with nobody
  // at the keyboard.
  test("runs an aside from a daemon seam and attaches it to the conversation", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-aside-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "handoff",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "aside", title: "Handoff", prompt: "Write the handoff." },
    });

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-aside-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Working",
      });

      await client.sendMessage(agent.id, "Say hello");

      let subagents: Awaited<ReturnType<typeof client.listProviderSubagents>>["subagents"] = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && subagents.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        subagents = (await client.listProviderSubagents(agent.id)).subagents;
      }

      // It ran, it belongs to the conversation that triggered it, and it is
      // titled by the rule rather than by the action's default.
      expect(subagents).toHaveLength(1);
      expect(subagents[0]?.parentAgentId).toBe(agent.id);
      expect(subagents[0]?.title).toBe("Handoff");

      // And the parent never took a turn for it: the aside is attached to the
      // conversation without being part of it.
      const timeline = await client.fetchAgentTimeline(agent.id);
      const asked = JSON.stringify(timeline).includes("Write the handoff.");
      expect(asked).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);
});
