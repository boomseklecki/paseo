import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

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

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
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
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);
});
