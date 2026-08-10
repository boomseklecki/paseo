/**
 * SCRATCH PROBE — not for merge.
 *
 * Asks whether an aside could be a real, persisted agent that belongs to its
 * parent conversation, instead of the hidden in-memory one it is today.
 *
 * The shape under test: same workspace as the parent, carrying the
 * `paseo.parent-agent-id` label, and NOT `internal`. If that agent stays out of
 * the listings and out of attention while remaining resumable, the aside can be
 * something you pick up later rather than something that dies with the daemon.
 *
 * Three questions, and each is a reason to abandon the idea if it answers wrong:
 *   1. does it appear in the flat agent list, giving you a duplicate tab?
 *   2. does the workspace directory fold it into the parent?
 *   3. does it stay silent, or does dropping `internal` start notifying?
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
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

function labelFor(id: string, parentId: string, childId: string): string {
  if (id === parentId) return "parent";
  if (id === childId) return "child";
  return "other";
}

describe.runIf(claudeAvailable)("aside as a delegated agent (probe)", () => {
  test("reports how a delegated sibling shows up", async () => {
    const logger = pino({ level: "silent" });
    const cwd = mkdtempSync(path.join(tmpdir(), "aside-delegated-"));
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    const attention: string[] = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "delegated-probe" } });

      const parent = await client.createAgent({
        ...getRealProviderConfig("claude"),
        cwd,
        title: "Parent",
      });

      const child = await client.createAgent({
        ...getRealProviderConfig("claude"),
        cwd,
        title: "Aside",
        // The two things that would make it belong to the parent rather than hide.
        ...(parent.workspaceId ? { workspaceId: parent.workspaceId } : {}),
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
      });

      // A turn, so anything that notifies on completion has had its chance.
      await client.sendMessage(child.id, "Reply with just the word OK.");
      await new Promise((resolve) => setTimeout(resolve, 20_000));

      const listed = await client.fetchAgents();
      const ids = listed.entries.map((entry) => entry.agent.id);

      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          {
            parentWorkspaceId: parent.workspaceId ?? null,
            childWorkspaceId: child.workspaceId ?? null,
            childInFlatList: ids.includes(child.id),
            listedCount: ids.length,
            childLabels:
              listed.entries.find((entry) => entry.agent.id === child.id)?.agent.labels ?? null,
            attentionSeen: attention,
            placements: listed.entries.map((entry) => ({
              id: labelFor(entry.agent.id, parent.id, child.id),
              title: entry.agent.title,
              workspaceId: entry.agent.workspaceId ?? null,
              project: entry.project,
            })),
          },
          null,
          2,
        ),
      );

      expect(ids).toContain(parent.id);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
