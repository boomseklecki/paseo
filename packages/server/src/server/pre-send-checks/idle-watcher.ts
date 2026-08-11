import type { Logger } from "pino";

/**
 * One agent, as much of it as deciding "has this been sitting long enough"
 * needs.
 *
 * A snapshot rather than the agent, so the sweep can be tested without an
 * AgentManager — which is the difference between a test that describes the rule
 * and one that stands up half the daemon to ask it.
 */
export interface IdleAgentSnapshot {
  agentId: string;
  provider: string;
  /** Absent means the agent belongs to no workspace, and nothing can be attributed to it. */
  workspaceId: string | undefined;
  /** Anything but `idle` means it is busy, and busy is not idle however long ago it last spoke. */
  lifecycle: string;
  lastActivityAtMs: number;
}

export interface PreSendRuleIdleWatcherOptions {
  listAgents: () => readonly IdleAgentSnapshot[];
  /** Runs the rules for one agent at the `agent.idle` seam. */
  onIdle: (agent: IdleAgentSnapshot, idleSeconds: number) => Promise<void>;
  logger: Logger;
  intervalMs?: number;
  now?: () => number;
}

/**
 * How often the idle sweep runs.
 *
 * A minute, because what it is looking for is measured in them — the rule a
 * fresh install ships with is an hour, and nobody writes an idle rule in
 * seconds. Sweeping faster would cost a rules read per agent per tick to notice
 * something up to a minute sooner than it matters.
 */
const IDLE_SWEEP_INTERVAL_MS = 60_000;

/**
 * The one seam with nothing to ride.
 *
 * Every other seam is a transition the daemon already detects — a turn ended, a
 * turn failed — so a rule can hang off something that was going to happen
 * anyway. Nothing happens when an agent goes on not being touched, which is
 * exactly the thing worth being told about, so this is the one place a timer
 * earns its keep.
 *
 * `sweep()` is public and does the whole job; the interval only calls it. That
 * is what lets the behaviour be tested by calling it, with an injected clock,
 * rather than by waiting or by faking timers — which `docs/testing.md` would
 * have something to say about.
 */
export class PreSendRuleIdleWatcher {
  private readonly options: PreSendRuleIdleWatcherOptions;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(options: PreSendRuleIdleWatcherOptions) {
    this.options = options;
    this.intervalMs = options.intervalMs ?? IDLE_SWEEP_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    // Never hold the process open on account of a poll for agents nobody touched.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Asks the rules about every agent that is sitting still.
   *
   * Skips a sweep that is still running rather than queueing another: each one
   * reads the rules directory per agent, and a daemon slow enough to overlap is
   * one that should be doing less, not more.
   */
  async sweep(): Promise<void> {
    if (this.sweeping) {
      return;
    }
    this.sweeping = true;
    try {
      const nowMs = this.now();
      for (const agent of this.options.listAgents()) {
        // Busy is not idle, and an agent with no workspace has nowhere to send a
        // notification — the same rule the built-in attention follows.
        if (agent.lifecycle !== "idle" || !agent.workspaceId) {
          continue;
        }
        // Clamped, because `lastActivityAt` is set from the daemon's own clock
        // and a sweep can land in the same millisecond.
        const idleSeconds = Math.max(0, (nowMs - agent.lastActivityAtMs) / 1000);
        try {
          await this.options.onIdle(agent, idleSeconds);
        } catch (error) {
          // One agent's rules failing must not end the sweep for the rest.
          this.options.logger.warn(
            { err: error, agentId: agent.agentId },
            "Failed to evaluate idle rules for an agent",
          );
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
