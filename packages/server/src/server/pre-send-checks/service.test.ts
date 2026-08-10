import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PreSendChecksService } from "./service.js";

let paseoHome: string;
let dir: string;
let service: PreSendChecksService;

beforeEach(async () => {
  paseoHome = await mkdtemp(join(tmpdir(), "pre-send-checks-service-test-"));
  dir = join(paseoHome, "pre-send-checks");
  service = new PreSendChecksService({ paseoHome, logger: createTestLogger() });
});

afterEach(async () => {
  service.stop();
  await rm(paseoHome, { recursive: true, force: true });
});

async function writeRule(id: string, overrides: Partial<PreSendCheckRule> = {}): Promise<void> {
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      id,
      measurement: "agent.idleSeconds",
      operator: "gte",
      threshold: 3600,
      disposition: "block",
      ...overrides,
    }),
    "utf-8",
  );
}

describe("PreSendChecksService", () => {
  test("seeds on first start and serves the shipped rule", async () => {
    await service.start();

    expect((await service.list()).map((rule) => rule.id)).toEqual(["cold-prompt-cache"]);
  });

  test("notifies listeners when a rule changes on disk", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await writeRule("cold-prompt-cache", { threshold: 60 });
    await service.refresh();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ threshold: 60 })]);
  });

  test("notifies when a rule is added and when one is removed", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await writeRule("pricey-session", { measurement: "agent.sessionCostUsd", disposition: "warn" });
    await service.refresh();
    await unlink(join(dir, "pricey-session.json"));
    await service.refresh();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[1]?.[0]).toHaveLength(1);
  });

  // Listeners fan out to every connected client, so a tick that fired
  // unconditionally would push to every app every 30 seconds to say nothing.
  test("stays silent when nothing changed", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await service.refresh();
    await service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  test("stays silent when a rewrite leaves the rules identical", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await writeRule("cold-prompt-cache");
    await service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  test("an unsubscribed listener stops hearing about changes", async () => {
    await service.start();
    const listener = vi.fn();
    const unsubscribe = service.onChange(listener);
    unsubscribe();

    await writeRule("cold-prompt-cache", { threshold: 60 });
    await service.refresh();

    expect(listener).not.toHaveBeenCalled();
  });

  // One listener throwing must not deny the others their notification, and must
  // not take down the timer that would deliver the next one.
  test("survives a listener that throws", async () => {
    await service.start();
    const healthy = vi.fn();
    service.onChange(() => {
      throw new Error("listener blew up");
    });
    service.onChange(healthy);

    await writeRule("cold-prompt-cache", { threshold: 60 });
    await expect(service.refresh()).resolves.toBeUndefined();

    expect(healthy).toHaveBeenCalledTimes(1);
  });
});
