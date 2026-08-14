import { describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { RuleIdleWatcher, type IdleAgentSnapshot } from "./idle-watcher.js";

const MINUTE = 60_000;

function agent(overrides: Partial<IdleAgentSnapshot> = {}): IdleAgentSnapshot {
  return {
    agentId: "agent-1",
    provider: "claude",
    workspaceId: "ws-1",
    lifecycle: "idle",
    lastActivityAtMs: 0,
    ...overrides,
  };
}

function makeWatcher(agents: readonly IdleAgentSnapshot[], nowMs: number) {
  const seen: Array<{ agentId: string; idleSeconds: number }> = [];
  const watcher = new RuleIdleWatcher({
    listAgents: () => agents,
    onIdle: async (snapshot, idleSeconds) => {
      seen.push({ agentId: snapshot.agentId, idleSeconds });
    },
    now: () => nowMs,
    logger: createTestLogger(),
  });
  return { watcher, seen };
}

describe("RuleIdleWatcher", () => {
  test("asks the rules about an agent that has been sitting still", async () => {
    const { watcher, seen } = makeWatcher([agent()], 90 * MINUTE);

    await watcher.sweep();

    expect(seen).toEqual([{ agentId: "agent-1", idleSeconds: 5400 }]);
  });

  // Busy is not idle, however long ago it last said anything.
  test("skips an agent that is running", async () => {
    const { watcher, seen } = makeWatcher([agent({ lifecycle: "running" })], 90 * MINUTE);

    await watcher.sweep();

    expect(seen).toEqual([]);
  });

  // The same rule the built-in attention follows: no workspace, nowhere to
  // attribute a notification, so nothing to say.
  test("skips an agent with no workspace", async () => {
    const { watcher, seen } = makeWatcher([agent({ workspaceId: undefined })], 90 * MINUTE);

    await watcher.sweep();

    expect(seen).toEqual([]);
  });

  test("reports each agent separately", async () => {
    const { watcher, seen } = makeWatcher(
      [
        agent({ agentId: "a", lastActivityAtMs: 0 }),
        agent({ agentId: "b", lastActivityAtMs: 30 * MINUTE }),
        agent({ agentId: "c", lifecycle: "error" }),
      ],
      60 * MINUTE,
    );

    await watcher.sweep();

    expect(seen).toEqual([
      { agentId: "a", idleSeconds: 3600 },
      { agentId: "b", idleSeconds: 1800 },
    ]);
  });

  // `updatedAt` comes from the daemon's own clock and a sweep can land in the
  // same millisecond, so this must never report a negative age.
  test("never reports negative idle time", async () => {
    const { watcher, seen } = makeWatcher([agent({ lastActivityAtMs: 10 * MINUTE })], 5 * MINUTE);

    await watcher.sweep();

    expect(seen).toEqual([{ agentId: "agent-1", idleSeconds: 0 }]);
  });

  // One agent's rules failing must not cost the rest of the sweep.
  test("carries on past an agent whose rules threw", async () => {
    const seen: string[] = [];
    const watcher = new RuleIdleWatcher({
      listAgents: () => [agent({ agentId: "bad" }), agent({ agentId: "good" })],
      onIdle: async (snapshot) => {
        if (snapshot.agentId === "bad") {
          throw new Error("rules unreadable");
        }
        seen.push(snapshot.agentId);
      },
      now: () => 90 * MINUTE,
      logger: createTestLogger(),
    });

    await watcher.sweep();

    expect(seen).toEqual(["good"]);
  });

  // Each sweep reads the rules once per agent, so a daemon slow enough to
  // overlap should be doing less rather than queueing more.
  test("does not start a second sweep while one is running", async () => {
    let started = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const watcher = new RuleIdleWatcher({
      listAgents: () => [agent()],
      onIdle: async () => {
        started += 1;
        await blocked;
      },
      now: () => 90 * MINUTE,
      logger: createTestLogger(),
    });

    const first = watcher.sweep();
    await watcher.sweep();
    expect(started).toBe(1);

    release?.();
    await first;
    await watcher.sweep();
    expect(started).toBe(2);
  });

  test("stops sweeping once told to stop", async () => {
    const { watcher, seen } = makeWatcher([agent()], 90 * MINUTE);

    watcher.start();
    watcher.stop();
    // Nothing has elapsed, so the interval has not fired; what this pins is that
    // stop() leaves the object usable rather than throwing.
    await watcher.sweep();

    expect(seen).toHaveLength(1);
  });
});
