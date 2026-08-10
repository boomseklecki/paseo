/**
 * SCRATCH PROTOTYPE — not for merge.
 *
 * Measures path A of the /btw fork: answer an aside with a hidden Paseo agent and
 * mirror its work into the parent conversation's subagent panel, without the
 * parent taking a turn.
 *
 * Everything the runner below does is a real API the daemon already has. The
 * only thing it reaches through is `providerSubagents`, which is private with
 * public readers and no public writer — the one bit of production surface the
 * feature would need to add.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { shutdownProviders } from "./provider-registry.js";
import type { AgentSessionConfig, AgentTimelineItem } from "./agent-sdk-types.js";
import type { ProviderSubagentStore } from "./provider-subagents/store.js";
import { ClaudeAgentClient } from "./providers/claude/agent.js";
import { isCommandAvailable } from "../../executable-resolution/executable-resolution.js";
import { getRealProviderConfig } from "../daemon-e2e/real-provider-test-config.js";

// Opt-in rather than availability-gated. These spend real provider tokens every
// run, and the claude binary is present on any machine that develops this, so
// gating on the binary alone means a plain `vitest run` quietly bills you. The
// repo's other real-provider tests are effectively gated by needing an
// OpenRouter key; these need an explicit PASEO_ASIDE_PROBES=1.
const probesEnabled = process.env["PASEO_ASIDE_PROBES"] === "1";
const claudeAvailable = probesEnabled && (await isCommandAvailable("claude"));

const logger = pino({ level: "silent" });

/** The whole of path A. Everything else in this file is harness. */
async function answerAside(input: {
  manager: AgentManager;
  store: ProviderSubagentStore;
  emit: (event: AgentManagerEvent) => void;
  parentAgentId: string;
  cwd: string;
  question: string;
  asideId: string;
}): Promise<string> {
  const { manager, store, emit, parentAgentId, cwd, question, asideId } = input;
  const provider = "claude" as const;

  const config: AgentSessionConfig = {
    ...getRealProviderConfig(provider),
    cwd,
    // Read-only: an aside is a question. This is what the btw skill gets by
    // dispatching to Explore, expressed as a provider mode instead.
    modeId: process.env.ASIDE_MODE || undefined,
    // Hidden from listings and from notifications, the same flag the branch-name
    // generator and the loop service already use.
    internal: true,
    title: "Aside",
  };

  emit({
    type: "provider_subagent",
    event: store.apply(parentAgentId, provider, {
      type: "upsert",
      id: asideId,
      title: "Aside",
      description: question,
      status: "running",
      // No originating tool call: nothing in the parent's transcript asked for
      // this. The field is nullable and the app never reads it.
      toolCallId: null,
      cwd,
    }),
  });

  const agent = await manager.createAgent(config, undefined, {
    persistSession: false,
    workspaceId: undefined,
  });

  let finalText = "";
  try {
    for await (const event of manager.streamAgent(agent.id, question)) {
      if (event.type !== "timeline") {
        continue;
      }
      const item = event.item as AgentTimelineItem;
      emit({
        type: "provider_subagent",
        event: store.apply(parentAgentId, provider, { type: "timeline", id: asideId, item }),
      });
      if (item.type === "assistant_message" && typeof item.text === "string") {
        finalText = item.text;
      }
    }
    emit({
      type: "provider_subagent",
      event: store.apply(parentAgentId, provider, {
        type: "upsert",
        id: asideId,
        status: "completed",
      }),
    });
  } catch (error) {
    emit({
      type: "provider_subagent",
      event: store.apply(parentAgentId, provider, {
        type: "upsert",
        id: asideId,
        status: "failed",
        subtitle: error instanceof Error ? error.message : String(error),
      }),
    });
    throw error;
  } finally {
    await manager.closeAgent(agent.id).catch(() => undefined);
    await manager.deleteAgentState(agent.id).catch(() => undefined);
  }

  return finalText;
}

describe.runIf(claudeAvailable)("aside runner prototype", () => {
  test(
    "answers an aside in a hidden agent and leaves it in the parent's subagent panel",
    { timeout: 180_000 },
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "aside-proto-"));
      const storage = new AgentStorage(path.join(dir, "agents"), logger);
      const manager = new AgentManager({
        clients: { claude: new ClaudeAgentClient({ logger }) },
        registry: storage,
        logger,
      });

      const events: AgentManagerEvent[] = [];
      const parent = await manager.createAgent(
        { ...getRealProviderConfig("claude"), cwd: dir, title: "Parent" },
        undefined,
        { persistSession: false, workspaceId: undefined },
      );

      try {
        const started = Date.now();
        const answer = await answerAside({
          manager,
          store: (manager as unknown as { providerSubagents: ProviderSubagentStore })
            .providerSubagents,
          emit: (event) => events.push(event),
          parentAgentId: parent.id,
          cwd: dir,
          question: "In one sentence, what does the word 'idempotent' mean?",
          asideId: "aside-1",
        });
        const elapsedMs = Date.now() - started;

        const subagents = manager.listProviderSubagents(parent.id);
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              elapsedMs,
              answerChars: answer.length,
              answer: answer.slice(0, 200),
              events: events.length,
              descriptors: subagents.length,
              descriptor: subagents[0],
            },
            null,
            2,
          ),
        );

        expect(answer.length).toBeGreaterThan(0);
        expect(subagents).toHaveLength(1);
        expect(subagents[0]?.status).toBe("completed");
        expect(subagents[0]?.toolCallId).toBeNull();
        expect(events.length).toBeGreaterThan(2);
      } finally {
        await manager.closeAgent(parent.id).catch(() => undefined);
        await shutdownProviders().catch(() => undefined);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
