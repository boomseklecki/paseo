import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { describe, expect, test } from "vitest";

import { PRIVATE_FILE_MODE } from "../private-files.js";
import { createPushNotifications } from "./index.js";
import { PushTokenStore } from "./token-store.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("PushTokenStore file permissions", () => {
  test("persists push tokens with private permissions", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
      });

      pushNotifications.renew("ExponentPushToken[test]");

      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing push token file permissions when loading", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      writeFileSync(tokenPath, JSON.stringify({ tokens: ["ExponentPushToken[test]"] }));
      chmodSync(tokenPath, PERMISSIVE_FILE_MODE);

      const deliveries: string[][] = [];
      const pushNotifications = createPushNotifications({
        logger: createLogger(),
        filePath: tokenPath,
        deliver: async (tokens) => deliveries.push(tokens),
      });
      await pushNotifications.send({ title: "Agent finished", body: "Done" });

      expect(deliveries).toEqual([["ExponentPushToken[test]"]]);
      expect(modeOf(tokenPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("PushTokenStore persistence", () => {
  test("does not apply a revocation until the updated subscriptions are durable", () => {
    let rejectWrites = false;
    let persisted = "";
    const store = new PushTokenStore(
      createLogger(),
      path.join(tmpdir(), `missing-push-token-store-${process.pid}`, "push-tokens.json"),
      () => Date.parse("2026-08-10T00:00:00.000Z"),
      48 * 60 * 60 * 1000,
      (_filePath, payload) => {
        if (rejectWrites) throw new Error("disk full");
        persisted = String(payload);
      },
    );

    store.renewToken("ExponentPushToken[test]");
    rejectWrites = true;

    expect(() => store.revokeToken("ExponentPushToken[test]")).toThrow("disk full");
    expect(store.getActiveTokens()).toEqual(["ExponentPushToken[test]"]);
    expect(JSON.parse(persisted)).toEqual({
      subscriptions: [
        {
          token: "ExponentPushToken[test]",
          expiresAt: "2026-08-12T00:00:00.000Z",
        },
      ],
    });

    rejectWrites = false;
    store.revokeToken("ExponentPushToken[test]");
    expect(store.getActiveTokens()).toEqual([]);
    expect(JSON.parse(persisted)).toEqual({ subscriptions: [] });
  });
});

describe("PushTokenStore capabilities", () => {
  const LEASE_MS = 48 * 60 * 60 * 1000;

  function createStore(options: { now: () => number; onPersist?: (payload: string) => void }) {
    return new PushTokenStore(
      createLogger(),
      path.join(tmpdir(), `missing-push-token-store-${process.pid}`, "push-tokens.json"),
      options.now,
      LEASE_MS,
      (_filePath, payload) => options.onPersist?.(String(payload)),
    );
  }

  test("withholds a token from a client that never said it understands the reason", () => {
    const store = createStore({ now: () => Date.parse("2026-08-10T00:00:00.000Z") });

    store.renewToken("ExponentPushToken[fork]", ["rule_attention"]);
    store.renewToken("ExponentPushToken[stock]", ["selective_agent_timeline"]);
    // What every token already on disk looks like: registered before the daemon
    // recorded any of this.
    store.renewToken("ExponentPushToken[legacy]");

    expect(store.getActiveTokens("rule_attention")).toEqual(["ExponentPushToken[fork]"]);
  });

  test("still reaches every device when the payload needs nothing in particular", () => {
    const store = createStore({ now: () => Date.parse("2026-08-10T00:00:00.000Z") });

    store.renewToken("ExponentPushToken[fork]", ["rule_attention"]);
    store.renewToken("ExponentPushToken[legacy]");

    expect(store.getActiveTokens()).toEqual([
      "ExponentPushToken[fork]",
      "ExponentPushToken[legacy]",
    ]);
  });

  // The lease check exists to keep a renewal from writing the file on every
  // heartbeat. Left alone it would also hold an upgraded client at its old
  // capabilities for up to a day.
  test("takes a client's new capability inside the half-lease window", () => {
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const persists: string[] = [];
    const store = createStore({ now: () => now, onPersist: (payload) => persists.push(payload) });

    store.renewToken("ExponentPushToken[phone]", []);
    now += 60 * 60 * 1000;

    store.renewToken("ExponentPushToken[phone]", []);
    expect(persists).toHaveLength(1);
    expect(store.getActiveTokens("rule_attention")).toEqual([]);

    store.renewToken("ExponentPushToken[phone]", ["rule_attention"]);
    expect(persists).toHaveLength(2);
    expect(store.getActiveTokens("rule_attention")).toEqual(["ExponentPushToken[phone]"]);
  });

  // A push is delivered to a closed app, so what it can render is only ever
  // known from a previous connection - across a daemon restart, that means from
  // the file.
  test("remembers what a client understands across a reload", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-tokens-"));
    const tokenPath = path.join(home, "push-tokens.json");
    try {
      const first = new PushTokenStore(
        createLogger(),
        tokenPath,
        () => Date.parse("2026-08-10T00:00:00.000Z"),
        LEASE_MS,
      );
      first.renewToken("ExponentPushToken[fork]", ["rule_attention"]);

      const reloaded = new PushTokenStore(
        createLogger(),
        tokenPath,
        () => Date.parse("2026-08-10T01:00:00.000Z"),
        LEASE_MS,
      );
      expect(reloaded.getActiveTokens("rule_attention")).toEqual(["ExponentPushToken[fork]"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
