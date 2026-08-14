import type pino from "pino";
import { existsSync, readFileSync } from "node:fs";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

interface PushSubscription {
  expiresAt: number;
  /**
   * What the client that registered this token said it understands, or null for
   * one registered before the daemon recorded that — which is every token
   * already on disk when this landed.
   *
   * Kept per token rather than per connection because a push is delivered to a
   * device that has none: the whole point of the token is that it works while
   * the app is closed. So the capability has to be remembered from the last time
   * the app was open.
   */
  capabilities: readonly string[] | null;
}

function sameCapabilities(
  left: readonly string[] | null,
  right: readonly string[] | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Store for Expo push tokens.
 *
 * Tokens are persisted to disk so pushes still work after daemon restarts.
 */
export class PushTokenStore {
  private readonly logger: pino.Logger;
  private subscriptions = new Map<string, PushSubscription>();
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number,
    leaseMs: number,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "token-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  /**
   * @param capabilities what the client holding this token understands, or
   * omitted where the caller has no connection to ask - which leaves whatever
   * was recorded before rather than erasing it.
   */
  renewToken(token: string, capabilities?: readonly string[]): void {
    const normalized = token.trim();
    if (!normalized) return;
    const now = this.now();
    const current = this.subscriptions.get(normalized);
    const nextCapabilities =
      capabilities === undefined
        ? (current?.capabilities ?? null)
        : Array.from(capabilities).sort();
    // The lease check alone would hold a token at its old capabilities for up to
    // a day after the client upgraded, which is the window where a newly capable
    // device is still treated as the old one.
    if (
      current !== undefined &&
      current.expiresAt - now > this.leaseMs / 2 &&
      sameCapabilities(current.capabilities, nextCapabilities)
    ) {
      return;
    }
    const next = new Map(this.subscriptions);
    next.set(normalized, { expiresAt: now + this.leaseMs, capabilities: nextCapabilities });
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Renewed token");
  }

  revokeToken(token: string): void {
    const normalized = token.trim();
    if (!normalized) return;
    if (!this.subscriptions.has(normalized)) return;
    const next = new Map(this.subscriptions);
    next.delete(normalized);
    this.persist(next);
    this.subscriptions = next;
    this.logger.debug({ total: this.subscriptions.size }, "Revoked token");
  }

  /**
   * @param requiredCapability withhold every token whose client did not
   * advertise it. A token recorded before the daemon kept capabilities counts as
   * not advertising: the same reading the websocket leg takes, and it costs at
   * most one push, since the next time that client connects it says what it is.
   */
  getActiveTokens(requiredCapability?: string): string[] {
    const now = this.now();
    const active = new Map(this.subscriptions);
    for (const [token, subscription] of this.subscriptions) {
      if (subscription.expiresAt <= now) {
        active.delete(token);
      }
    }
    if (active.size !== this.subscriptions.size) {
      try {
        this.persist(active);
        this.subscriptions = active;
      } catch {
        // Keep the previous state so a later send retries pruning. Expired tokens
        // are still excluded from this delivery.
      }
    }
    if (requiredCapability === undefined) {
      return Array.from(active.keys());
    }
    return Array.from(active)
      .filter(([, subscription]) => subscription.capabilities?.includes(requiredCapability))
      .map(([token]) => token);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as { subscriptions?: unknown; tokens?: unknown };
      const loaded = new Map<string, PushSubscription>();
      const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const value of subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as { token?: unknown; expiresAt?: unknown; capabilities?: unknown };
        if (typeof candidate.token !== "string" || typeof candidate.expiresAt !== "string")
          continue;
        const token = candidate.token.trim();
        const expiresAt = Date.parse(candidate.expiresAt);
        if (token && Number.isFinite(expiresAt)) {
          loaded.set(token, {
            expiresAt,
            capabilities: Array.isArray(candidate.capabilities)
              ? candidate.capabilities.filter((entry): entry is string => typeof entry === "string")
              : null,
          });
        }
      }
      this.subscriptions = loaded;

      const legacyTokens = Array.isArray(parsed.tokens)
        ? parsed.tokens.filter((token): token is string => typeof token === "string")
        : [];
      if (legacyTokens.length > 0) {
        const migrated = new Map(loaded);
        const expiresAt = this.now() + this.leaseMs;
        for (const token of legacyTokens) {
          const normalized = token.trim();
          if (normalized) migrated.set(normalized, { expiresAt, capabilities: null });
        }
        this.persist(migrated);
        this.subscriptions = migrated;
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded push tokens");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load push tokens");
    }
  }

  private persist(subscriptions: ReadonlyMap<string, PushSubscription>): void {
    try {
      const payload =
        JSON.stringify(
          {
            subscriptions: Array.from(subscriptions, ([token, subscription]) => ({
              token,
              expiresAt: new Date(subscription.expiresAt).toISOString(),
              // Omitted rather than written as null, so a token nobody has asked
              // about keeps the shape it was written with.
              ...(subscription.capabilities ? { capabilities: subscription.capabilities } : {}),
            })),
          },
          null,
          2,
        ) + "\n";
      this.write(this.filePath, payload);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist push tokens");
      throw err;
    }
  }
}
