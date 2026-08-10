/**
 * Guards the economic premise of an aside: that resuming the parent's provider
 * session is materially cheaper than replaying its transcript.
 *
 * An aside answers a side question with the parent conversation in view. There
 * are two ways to put it there:
 *
 *   D1  resume the parent's provider session, so the provider still holds the
 *       conversation and its prompt cache is warm.
 *   D2  replay Paseo's own record of the conversation as prompt text, which
 *       works on every provider but pays for the whole transcript again.
 *
 * `planAside` picks D1 wherever `supportsSessionPersistence` allows it and warns
 * before falling back to D2, and that choice is only worth making if the gap is
 * real. Measured once at ~$0.007 against ~$0.027 on a 50k-token conversation.
 * If a provider change ever closed that gap, nothing else in the codebase would
 * notice: asides would keep working and quietly cost four times as much.
 *
 * The third assertion is the one that would make D1 unusable at any price —
 * whether the aside ends up in the parent's own conversation.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { shutdownProviders } from "./provider-registry.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import type { AgentSessionConfig, AgentTimelineItem } from "./agent-sdk-types.js";
import { getRealProviderConfig } from "../daemon-e2e/real-provider-test-config.js";

const logger = pino({ level: "silent" });

const ASIDE = "In one sentence: what is the id field on a pre-send check rule for?";

/**
 * Enough real text that the provider has something worth caching.
 *
 * Resolved from this file rather than the working directory: the same run from
 * the repo root and from `packages/server` has to read the same module.
 */
async function buildSeedPrompt(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(
    path.join(here, "../../../../protocol/src/pre-send-checks/types.ts"),
    "utf-8",
  );
  return `Here is a TypeScript module. Read it and reply with just the word OK.\n\n${source}`;
}

function renderTimeline(items: readonly AgentTimelineItem[]): string {
  return items
    .map((item) => {
      if (item.type === "user_message" || item.type === "assistant_message") {
        return `${item.type === "user_message" ? "User" : "Assistant"}: ${item.text ?? ""}`;
      }
      return null;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

describe("aside context cost", () => {
  test(
    "resuming the parent session costs less than replaying its transcript",
    { timeout: 600_000 },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "aside-ctx-"));
      const storage = new AgentStorage(path.join(dir, "agents"), logger);
      const manager = new AgentManager({
        clients: { claude: new ClaudeAgentClient({ logger }) },
        registry: storage,
        logger,
      });

      const base: AgentSessionConfig = { ...getRealProviderConfig("claude"), cwd: dir };

      try {
        // A parent with a conversation worth inheriting.
        const parent = await manager.createAgent({ ...base, title: "Parent" }, undefined, {
          persistSession: true,
          workspaceId: undefined,
        });
        const seeded = await manager.runAgent(parent.id, await buildSeedPrompt());
        const parentTurns = [...seeded.timeline];

        // ---- D1: resume the parent's provider session ------------------------
        const parentHandle = manager.getAgent(parent.id)?.persistence;
        expect(parentHandle).not.toBeUndefined();

        const resumed = await manager.resumeAgentFromPersistence(
          parentHandle!,
          {
            ...base,
            internal: true,
            title: "Aside (resumed)",
            // The resumed config otherwise inherits the parent's provider options,
            // and the claude client refuses any at all.
            providerOptions: undefined,
          },
          undefined,
          { workspaceId: undefined },
        );
        const runD1 = await manager.runAgent(resumed.id, ASIDE);
        await manager.closeAgent(resumed.id).catch(() => undefined);
        await manager.deleteAgentState(resumed.id).catch(() => undefined);

        // Did the aside end up in the parent's own conversation? Asking the
        // parent for one more turn is what makes its timeline speak for itself.
        const after = await manager.runAgent(parent.id, "Reply with just the word PING.");
        const leaked = after.timeline.filter(
          (item) =>
            item.type === "user_message" && (item.text ?? "").includes("pre-send check rule"),
        );

        // ---- D2: replay Paseo's transcript to a fresh agent -------------------
        const replay = await manager.createAgent(
          { ...base, internal: true, title: "Aside (replayed)" },
          undefined,
          { persistSession: false, workspaceId: undefined },
        );
        const runD2 = await manager.runAgent(
          replay.id,
          `Here is a conversation so far.\n\n${renderTimeline(parentTurns)}\n\n---\n\n${ASIDE}`,
        );
        await manager.closeAgent(replay.id).catch(() => undefined);
        await manager.deleteAgentState(replay.id).catch(() => undefined);
        await manager.closeAgent(parent.id).catch(() => undefined);

        expect(leaked).toEqual([]);

        const costD1 = runD1.usage?.totalCostUsd;
        const costD2 = runD2.usage?.totalCostUsd;
        expect(typeof costD1).toBe("number");
        expect(typeof costD2).toBe("number");
        expect(costD1!).toBeLessThan(costD2!);

        // The gap is supposed to come from a cache hit rather than from the
        // resumed prompt happening to be shorter, so say which one it is.
        expect(runD1.usage?.cachedInputTokens ?? 0).toBeGreaterThan(0);
      } finally {
        await shutdownProviders().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
