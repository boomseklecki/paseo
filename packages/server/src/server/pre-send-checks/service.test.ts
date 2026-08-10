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

  // A write goes through refresh() rather than notifying directly, so it both
  // fires once and moves the baseline the tick compares against. Notifying
  // directly would leave that baseline stale and have the next tick repeat it.
  test("an upsert broadcasts once and the next tick stays silent", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await service.upsert({
      id: "pricey-session",
      measurement: "agent.sessionCostUsd",
      operator: "gt",
      threshold: 10,
      disposition: "warn",
    });
    expect(listener).toHaveBeenCalledTimes(1);

    await service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("a delete broadcasts once and the next tick stays silent", async () => {
    await service.start();
    const listener = vi.fn();
    service.onChange(listener);

    await service.delete("cold-prompt-cache");
    expect(listener).toHaveBeenCalledTimes(1);

    await service.refresh();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("an upsert replaces by id and returns the resulting list", async () => {
    await service.start();

    const after = await service.upsert({
      id: "cold-prompt-cache",
      measurement: "agent.idleSeconds",
      operator: "gte",
      threshold: 60,
      disposition: "block",
    });

    expect(after).toHaveLength(1);
    expect(after[0]?.threshold).toBe(60);
  });

  // The wire accepts any string for these fields on purpose, so an editor that
  // knows four operators must not be able to launder a fifth into one on save.
  test("an upsert round-trips an operator it does not recognise", async () => {
    await service.start();

    const after = await service.upsert({
      id: "odd-one",
      measurement: "agent.idleSeconds",
      operator: "approaches",
      threshold: 10,
      disposition: "warn",
    });

    expect(after.find((rule) => rule.id === "odd-one")?.operator).toBe("approaches");
  });

  test("reorder assigns positions in the order given and broadcasts once", async () => {
    await service.start();
    await writeRule("b");
    await writeRule("a");
    await service.refresh();
    const listener = vi.fn();
    service.onChange(listener);

    const after = await service.reorder(["b", "a", "cold-prompt-cache"]);

    expect(after.map((rule) => rule.id)).toEqual(["b", "a", "cold-prompt-cache"]);
    expect(after.map((rule) => rule.order)).toEqual([0, 1, 2]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // Whatever readdir yields, two reads of an unchanged directory must be equal or
  // the service would broadcast on every tick.
  test("the order survives a re-read", async () => {
    await service.start();
    await writeRule("b");
    await service.reorder(["b", "cold-prompt-cache"]);

    expect((await service.list()).map((rule) => rule.id)).toEqual(["b", "cold-prompt-cache"]);
  });

  test("a rule left out of the reorder sorts after the arranged ones", async () => {
    await service.start();
    await writeRule("zzz-unordered");

    const after = await service.reorder(["cold-prompt-cache"]);

    expect(after.map((rule) => rule.id)).toEqual(["cold-prompt-cache", "zzz-unordered"]);
  });

  test("reorder ignores an id the store does not have", async () => {
    await service.start();

    const after = await service.reorder(["nope", "cold-prompt-cache"]);

    expect(after.map((rule) => rule.id)).toEqual(["cold-prompt-cache"]);
    expect(after[0]?.order).toBe(0);
  });

  test("deleting a rule that is not there still reports the current list", async () => {
    await service.start();

    expect(await service.delete("never-existed")).toHaveLength(1);
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
