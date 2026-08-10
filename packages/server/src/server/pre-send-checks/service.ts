import { join } from "node:path";
import type { Logger } from "pino";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { ensureSeeded } from "./seed.js";
import { PreSendCheckStore } from "./store.js";

/**
 * How often the rules directory is re-read looking for outside edits.
 *
 * There is no `fs.watch` here, and that is deliberate rather than lazy. A watcher
 * is instant, but on a Docker bind mount from macOS it establishes successfully
 * and then never fires — which is exactly how one of this project's own instances
 * mounts PASEO_HOME. A watch that is silently dead on one host is the same shape
 * of failure this feature was reworked to remove, so a slower mechanism that works
 * everywhere wins. A readdir of a handful of small files every half minute does
 * not register.
 */
const RELIST_INTERVAL_MS = 30_000;

export type PreSendChecksListener = (checks: readonly PreSendCheckRule[]) => void;

export interface PreSendChecksServiceOptions {
  paseoHome: string;
  logger: Logger;
  intervalMs?: number;
}

export class PreSendChecksService {
  private readonly store: PreSendCheckStore;
  private readonly dir: string;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly listeners = new Set<PreSendChecksListener>();
  private timer: NodeJS.Timeout | null = null;
  /**
   * The last list handed to listeners, serialised. Comparing the rendered JSON is
   * exact and immune to the trap a mtime check walks into — two edits inside one
   * interval can leave the timestamp unchanged, and this cannot miss that.
   */
  private lastBroadcast: string | null = null;

  constructor(options: PreSendChecksServiceOptions) {
    // The service owns the directory name, the store stays path-agnostic —
    // matching ScheduleService, and what makes the store trivial to test.
    this.dir = join(options.paseoHome, "pre-send-checks");
    this.logger = options.logger.child({ module: "pre-send-checks" });
    this.store = new PreSendCheckStore(this.dir, options.logger);
    this.intervalMs = options.intervalMs ?? RELIST_INTERVAL_MS;
  }

  async start(): Promise<void> {
    await ensureSeeded(this.dir, this.logger);
    this.lastBroadcast = serialise(await this.list());

    this.timer = setInterval(() => {
      void this.refresh();
    }, this.intervalMs);
    // Never hold the process open on account of a poll for config nobody changed.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async list(): Promise<PreSendCheckRule[]> {
    return this.store.list();
  }

  /**
   * Writes a rule and returns the resulting list.
   *
   * Both writers go through `refresh()` rather than notifying directly, which is
   * what keeps one write to one broadcast: `refresh()` re-reads, compares against
   * the last broadcast and notifies only on a difference, so it both fires
   * immediately and moves the baseline the periodic tick will compare against. A
   * write that notified on its own would leave that baseline stale and have the
   * next tick repeat it.
   *
   * The store does not serialise concurrent mutations — unlike `ScheduleStore`,
   * which keeps a promise chain per id. Two people editing the same rule in the
   * same instant is last-write-wins, which is the right trade for a settings
   * screen and the wrong one if this ever grows an automated writer.
   */
  async upsert(check: PreSendCheckRule): Promise<PreSendCheckRule[]> {
    await this.store.write(check);
    await this.refresh();
    return this.list();
  }

  async delete(id: string): Promise<PreSendCheckRule[]> {
    await this.store.delete(id);
    await this.refresh();
    return this.list();
  }

  /**
   * Rewrites every rule's position in one pass.
   *
   * Assigns `order` by index, so the arrangement is explicit on disk rather than
   * implied by whatever was there before — a list that was partly ordered comes
   * out wholly ordered. Ids the store does not have are skipped; rules the caller
   * omitted keep the order they had, which puts them after the arranged ones
   * because unordered sorts last.
   *
   * Writes happen before the single refresh, so one reorder is one broadcast
   * however many files it touched.
   */
  async reorder(ruleIds: readonly string[]): Promise<PreSendCheckRule[]> {
    const byId = new Map((await this.list()).map((rule) => [rule.id, rule]));
    let position = 0;
    for (const id of ruleIds) {
      const rule = byId.get(id);
      if (!rule) {
        continue;
      }
      await this.store.write({ ...rule, order: position });
      position += 1;
    }
    await this.refresh();
    return this.list();
  }

  onChange(listener: PreSendChecksListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Re-reads the directory and notifies only when the rules actually differ.
   *
   * Silence when nothing changed is the contract: listeners broadcast to every
   * connected client, so a tick that fired unconditionally would be a push every
   * 30 seconds to every app, forever, to say nothing.
   */
  async refresh(): Promise<void> {
    let checks: PreSendCheckRule[];
    try {
      checks = await this.list();
    } catch (error) {
      // A transient readdir failure must not kill the timer; the next tick retries.
      this.logger.warn({ err: error }, "Failed to re-read pre-send checks");
      return;
    }

    const next = serialise(checks);
    if (next === this.lastBroadcast) {
      return;
    }
    this.lastBroadcast = next;

    for (const listener of this.listeners) {
      try {
        listener(checks);
      } catch (error) {
        this.logger.warn({ err: error }, "Pre-send checks listener failed");
      }
    }
  }
}

function serialise(checks: readonly PreSendCheckRule[]): string {
  return JSON.stringify(checks);
}
