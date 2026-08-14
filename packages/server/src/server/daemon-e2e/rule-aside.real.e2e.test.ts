import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { getRealProviderConfig } from "./real-provider-test-config.js";

/**
 * The whole path, over the wire, against a real provider: a rule's action is
 * carried out instead of the message being sent, and its work turns up as a
 * subagent of the conversation the message was typed into.
 *
 * Everything below the wire is covered by unit tests; what only an end-to-end
 * run can show is that the verb reaches the action, the action reaches a
 * provider, and the result reaches the conversation.
 */
describe("daemon E2E (rule aside)", () => {
  test("answers an aside as a subagent without the conversation taking a turn", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-aside-e2e-"));
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "aside-e2e" } });

      const agent = await client.createAgent({
        ...getRealProviderConfig("claude"),
        cwd,
        title: "Parent",
      });

      const before = await client.listProviderSubagents(agent.id);
      expect(before.subagents).toHaveLength(0);

      const started = await client.rulesRunAction({
        agentId: agent.id,
        message: "/btw in one word, what language is this project written in?",
        action: { kind: "aside", title: "Aside" },
      });

      expect(started.status).toBe("started");
      expect(started.subagentId).toBeTruthy();

      // The action is deliberately not awaited by the daemon, so the descriptor
      // appears at once and its status settles later.
      const readSettled = async () => {
        const listed = await client.listProviderSubagents(agent.id);
        const subagent = findById(listed.subagents, started.subagentId);
        return subagent && subagent.status !== "running" ? subagent : null;
      };
      const settled = await waitFor(readSettled, 120_000);

      expect(settled.status).toBe("completed");
      // Nothing asked for this, so there is no originating tool call.
      expect(settled.toolCallId).toBeNull();

      // The answer itself: at least one timeline row was mirrored into the
      // subagent, which is what makes the panel show work rather than a label.
      const timeline = await client.fetchProviderSubagentTimeline(agent.id, settled.id);
      expect(timeline.rows.length).toBeGreaterThan(0);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 180_000);
});

function findById<T extends { id: string }>(items: readonly T[], id: string | null): T | undefined {
  return items.find((item) => item.id === id);
}

async function waitFor<T>(
  read: () => Promise<T | null | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the aside to settle");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
