/**
 * SCRATCH PROBE — not for merge.
 *
 * The question the whole notification thread started from: can work that happens
 * inside a hidden aside reach the user, given that internal agents are silent by
 * design?
 *
 * The proposed answer is to attribute the notification to the parent
 * conversation, which has a workspace, rather than to the aside, which does not.
 * `emitProviderSubagentWorkspaceUpdate` already resolves a subagent's workspace
 * exactly that way, so the pattern is established — but nobody has watched a
 * notification actually arrive.
 *
 * This captures `agent_attention_required` off the wire while a normal agent
 * finishes a turn, and reports what a client would have to work with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { getRealProviderConfig } from "./real-provider-test-config.js";

// Opt-in rather than availability-gated. These spend real provider tokens every
// run, and the claude binary is present on any machine that develops this, so
// gating on the binary alone means a plain `vitest run` quietly bills you. The
// repo's other real-provider tests are effectively gated by needing an
// OpenRouter key; these need an explicit PASEO_ASIDE_PROBES=1.
const probesEnabled = process.env["PASEO_ASIDE_PROBES"] === "1";
const claudeAvailable = probesEnabled && (await isCommandAvailable("claude"));

describe.runIf(claudeAvailable)("aside notification probe", () => {
  test("reports what an attention notification carries", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "aside-notify-"));
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    const seen: unknown[] = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "notify-probe" } });
      client.onAgentAttentionRequired((payload) => {
        seen.push(payload);
      });

      const agent = await client.createAgent({
        ...getRealProviderConfig("claude"),
        cwd,
        title: "Parent",
      });

      await client.sendMessage(agent.id, "Reply with just the word OK.");
      await new Promise((resolve) => setTimeout(resolve, 25_000));

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          { workspaceId: agent.workspaceId ?? null, count: seen.length, payloads: seen },
          null,
          2,
        ),
      );

      expect(agent.workspaceId).toBeTruthy();
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
