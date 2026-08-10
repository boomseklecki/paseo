import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { PreSendCheckStore } from "./store.js";

let dir: string;
let store: PreSendCheckStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pre-send-checks-store-test-"));
  store = new PreSendCheckStore(dir, createTestLogger());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRule(name: string, body: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(body), "utf-8");
}

const RULE = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

describe("PreSendCheckStore", () => {
  test("reads rules back from disk", async () => {
    await writeRule("cold-prompt-cache.json", RULE);

    expect(await store.list()).toEqual([RULE]);
  });

  test("returns an empty list for a directory with no rules", async () => {
    expect(await store.list()).toEqual([]);
  });

  // The whole reason this store does not copy ScheduleStore's Promise.all: rules
  // gate sends, so one unparseable file must not take the others down with it.
  // Losing every rule at once turns the gate off silently, which is worse than
  // any single bad rule.
  test("skips a malformed rule and still returns the others", async () => {
    await writeRule("cold-prompt-cache.json", RULE);
    await writeFile(join(dir, "broken.json"), "{ not json", "utf-8");
    await writeRule("wrong-shape.json", { id: "wrong-shape", threshold: "soon" });

    expect(await store.list()).toEqual([RULE]);
  });

  // The seeded README lives in this directory and must never be mistaken for a rule.
  test("ignores files that are not .json", async () => {
    await writeRule("cold-prompt-cache.json", RULE);
    await writeFile(join(dir, "README.md"), "# not a rule", "utf-8");

    expect(await store.list()).toEqual([RULE]);
  });

  test("sorts by id so two reads can be compared for equality", async () => {
    await writeRule("b.json", { ...RULE, id: "b" });
    await writeRule("a.json", { ...RULE, id: "a" });

    expect((await store.list()).map((rule) => rule.id)).toEqual(["a", "b"]);
  });

  // Passthrough on the element schema is what lets a rule written by a newer
  // daemon survive an older one rather than being dropped on read.
  test("keeps a field it does not recognise", async () => {
    await writeRule("cold-prompt-cache.json", { ...RULE, severity: "high" });

    expect(await store.list()).toEqual([{ ...RULE, severity: "high" }]);
  });

  test("round-trips a written rule and deletes it again", async () => {
    await store.write({ ...RULE, id: "mine" });
    expect(await store.get("mine")).toEqual({ ...RULE, id: "mine" });

    await store.delete("mine");
    expect(await store.get("mine")).toBeNull();
  });

  test("deleting a rule that is not there is not an error", async () => {
    await expect(store.delete("never-existed")).resolves.toBeUndefined();
  });
});
