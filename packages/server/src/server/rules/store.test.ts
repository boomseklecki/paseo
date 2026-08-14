import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { RuleStore } from "./store.js";

let dir: string;
let store: RuleStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rules-store-test-"));
  store = new RuleStore(dir, createTestLogger());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeRule(name: string, body: unknown): Promise<void> {
  await writeFile(join(dir, name), JSON.stringify(body), "utf-8");
}

// These four are hoisted because a callback written inline inside describe >
// describe > test is already four deep and trips the nesting limit. The table
// helper reads better out here anyway.
function positions(rules: readonly Rule[]): Array<[string, number | undefined]> {
  return rules.map((rule) => [rule.id, rule.order]);
}

function unchanged(rule: Rule): Rule {
  return rule;
}

function withDifferentId(rule: Rule): Rule {
  return { ...rule, id: "somewhere-else" };
}

function bumpThreshold(rule: Rule): Rule {
  return { ...rule, threshold: (rule.threshold ?? 0) + 1 };
}

const RULE = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

describe("RuleStore", () => {
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

  describe("ids and filenames", () => {
    // Renaming the file is how a rule gets copied by hand, so the name has to be
    // what counts. Trusting the id inside instead let two files claim one id,
    // with list reporting one of them and get answering with the other.
    test("takes the id from the filename when the file disagrees", async () => {
      await writeRule("renamed-by-hand.json", RULE);

      expect(await store.list()).toEqual([{ ...RULE, id: "renamed-by-hand" }]);
      expect(await store.get("renamed-by-hand")).toEqual({ ...RULE, id: "renamed-by-hand" });
    });

    test("reads a rule file that carries no id at all", async () => {
      const { id: _id, ...withoutId } = RULE;
      await writeRule("no-id-inside.json", withoutId);

      expect(await store.list()).toEqual([{ ...RULE, id: "no-id-inside" }]);
    });

    // The client mints ids and sends them over the wire, so this is the daemon's
    // boundary: without it an upsert could write outside the rules directory.
    test("refuses an id that would leave the rules directory", async () => {
      await expect(store.write({ ...RULE, id: "../escaped" })).rejects.toThrow(/usable filename/);
      await expect(store.get("../escaped")).rejects.toThrow(/usable filename/);
      await expect(store.delete("../escaped")).rejects.toThrow(/usable filename/);
    });

    test("refuses an id that is empty or a bare dot", async () => {
      await expect(store.write({ ...RULE, id: "" })).rejects.toThrow(/usable filename/);
      await expect(store.write({ ...RULE, id: "." })).rejects.toThrow(/usable filename/);
    });

    // Listing it would hand out a rule that throws the moment anyone saves it.
    test("skips a file whose name cannot be an id", async () => {
      await writeRule("cold-prompt-cache.json", RULE);
      await writeRule("..json", RULE);

      expect(await store.list()).toEqual([RULE]);
    });
  });

  describe("update", () => {
    test("applies the updater and persists the result", async () => {
      await writeRule("cold-prompt-cache.json", RULE);

      const updated = await store.update("cold-prompt-cache", bumpThreshold);

      expect(updated).toEqual({ ...RULE, threshold: 3601 });
      expect(await store.get("cold-prompt-cache")).toEqual({ ...RULE, threshold: 3601 });
    });

    // An edit racing a delete must not put the rule back.
    test("returns null for a rule that is not there", async () => {
      expect(await store.update("never-existed", unchanged)).toBeNull();
    });

    test("refuses an updater that changes the id", async () => {
      await writeRule("cold-prompt-cache.json", RULE);

      await expect(store.update("cold-prompt-cache", withDifferentId)).rejects.toThrow(
        /cannot change id/,
      );
      expect(await store.get("cold-prompt-cache")).toEqual(RULE);
    });

    // The reason update exists rather than each caller spreading a record into
    // write: two edits in flight at once both land. Read-merge-write outside the
    // store loses the first one, because both reads finish before either write.
    test("serialises concurrent updates so neither is lost", async () => {
      await writeRule("cold-prompt-cache.json", RULE);
      await Promise.all([
        store.update("cold-prompt-cache", bumpThreshold),
        store.update("cold-prompt-cache", bumpThreshold),
      ]);

      expect((await store.get("cold-prompt-cache"))?.threshold).toBe(3602);
    });
  });

  describe("reorder", () => {
    test("assigns order by position in the requested list", async () => {
      await writeRule("a.json", { ...RULE, id: "a" });
      await writeRule("b.json", { ...RULE, id: "b" });
      await writeRule("c.json", { ...RULE, id: "c" });

      await store.reorder(["c", "a", "b"]);

      expect(positions(await store.list())).toEqual([
        ["c", 0],
        ["a", 1],
        ["b", 2],
      ]);
    });

    test("skips an id it does not have without consuming a position", async () => {
      await writeRule("a.json", { ...RULE, id: "a" });
      await writeRule("b.json", { ...RULE, id: "b" });

      await store.reorder(["a", "deleted-elsewhere", "b"]);

      expect(positions(await store.list())).toEqual([
        ["a", 0],
        ["b", 1],
      ]);
    });

    // An omitted rule keeps whatever order it had, and unordered sorts last, so
    // a caller that arranges a subset never scatters the rest through it.
    test("leaves a rule the caller omitted alone", async () => {
      await writeRule("a.json", { ...RULE, id: "a" });
      await writeRule("b.json", { ...RULE, id: "b" });

      await store.reorder(["b"]);

      expect(await store.list()).toEqual([
        { ...RULE, id: "b", order: 0 },
        { ...RULE, id: "a" },
      ]);
    });

    // Reordering to the arrangement that is already there writes nothing, which
    // is what keeps the service from broadcasting a change nobody made.
    test("is a no-op when every rule already sits at its position", async () => {
      await writeRule("a.json", { ...RULE, id: "a", order: 0 });
      await writeRule("b.json", { ...RULE, id: "b", order: 1 });
      const before = await store.list();

      await store.reorder(["a", "b"]);

      expect(await store.list()).toEqual(before);
    });
  });
});
