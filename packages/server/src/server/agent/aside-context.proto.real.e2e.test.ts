/**
 * SCRATCH PROTOTYPE — not for merge.
 *
 * The real `/btw` sees the parent conversation and has no tools. Paseo can get
 * that context two ways, and they cost differently:
 *
 *   D1  resume the parent's provider session, so the provider still holds the
 *       conversation and the prompt cache is warm.
 *   D2  replay Paseo's own record of the conversation as prompt text, which
 *       works on every provider but pays for the whole transcript again.
 *
 * This measures both against a real provider and prints the usage, because the
 * entire argument for D1 is a cache hit that nobody has yet observed. It also
 * checks the thing that would make D1 unusable regardless of cost: whether the
 * aside leaks into the parent's own session.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { shutdownProviders } from "./provider-registry.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import type { AgentSessionConfig, AgentTimelineItem, AgentUsage } from "./agent-sdk-types.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { getRealProviderConfig } from "../daemon-e2e/real-provider-test-config.js";

const logger = pino({ level: "silent" });
const claudeAvailable = await isCommandAvailable("claude");

const ASIDE = "In one sentence: what is the id field on a pre-send check rule for?";

/** Enough real text that the provider has something worth caching. */
async function buildSeedPrompt(): Promise<string> {
  const source = await readFile(
    path.join(process.cwd(), "../protocol/src/pre-send-checks/types.ts"),
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

function summarise(label: string, usage: AgentUsage | undefined, elapsedMs: number) {
  return {
    path: label,
    elapsedMs,
    inputTokens: usage?.inputTokens ?? null,
    cachedInputTokens: usage?.cachedInputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    totalCostUsd: usage?.totalCostUsd ?? null,
  };
}

describe.runIf(claudeAvailable)("aside context prototype", () => {
  test(
    "compares resuming the parent session against replaying its transcript",
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
        let d1: ReturnType<typeof summarise> | { path: string; error: string };
        let leaked: number | null = null;
        if (!parentHandle) {
          d1 = { path: "D1", error: "parent exposed no persistence handle" };
        } else {
          const startedD1 = Date.now();
          const resumed = await manager.resumeAgentFromPersistence(
            parentHandle,
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
          d1 = summarise("D1 resume parent session", runD1.usage, Date.now() - startedD1);
          await manager.closeAgent(resumed.id).catch(() => undefined);
          await manager.deleteAgentState(resumed.id).catch(() => undefined);

          // Did the aside end up in the parent's own conversation?
          const after = await manager.runAgent(parent.id, "Reply with just the word PING.");
          leaked = after.timeline.filter(
            (item) =>
              item.type === "user_message" && (item.text ?? "").includes("pre-send check rule"),
          ).length;
        }

        // ---- D2: replay Paseo's transcript to a fresh agent -------------------
        const startedD2 = Date.now();
        const replay = await manager.createAgent(
          { ...base, internal: true, title: "Aside (replayed)" },
          undefined,
          { persistSession: false, workspaceId: undefined },
        );
        const runD2 = await manager.runAgent(
          replay.id,
          `Here is a conversation so far.\n\n${renderTimeline(parentTurns)}\n\n---\n\n${ASIDE}`,
        );
        const d2 = summarise("D2 replay transcript", runD2.usage, Date.now() - startedD2);
        await manager.closeAgent(replay.id).catch(() => undefined);
        await manager.deleteAgentState(replay.id).catch(() => undefined);

        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ d1, d2, asideLeakedIntoParent: leaked }, null, 2));

        await manager.closeAgent(parent.id).catch(() => undefined);
        expect(d2.elapsedMs).toBeGreaterThan(0);
      } finally {
        await shutdownProviders().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
