import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { evaluatePreSendChecks } from "@getpaseo/protocol/pre-send-checks/evaluate";
import type { PreSendMeasurementContext } from "@getpaseo/protocol/pre-send-checks/types";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DEFAULT_PRE_SEND_CHECKS, ensureSeeded } from "./seed.js";
import { PreSendCheckStore } from "./store.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pre-send-checks-seed-test-"));
  dir = join(root, "pre-send-checks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    idleSeconds: null,
    contextUsedPercent: null,
    sessionCostUsd: null,
    message: "",
    ...overrides,
  };
}

describe("ensureSeeded", () => {
  test("writes the shipped rules and a README when the directory is absent", async () => {
    await ensureSeeded(dir, createTestLogger());

    expect((await readdir(dir)).sort()).toEqual([
      "README.md",
      ...DEFAULT_PRE_SEND_CHECKS.map((rule) => `${rule.id}.json`).sort(),
    ]);
    expect(await new PreSendCheckStore(dir, createTestLogger()).list()).toEqual([
      ...DEFAULT_PRE_SEND_CHECKS,
    ]);
  });

  // The distinction the whole design rests on. An empty directory is somebody who
  // deleted every rule, and re-seeding would silently undo them; it is also what
  // lets a client read an empty list as "no checks" instead of "not loaded yet".
  test("leaves an existing empty directory alone", async () => {
    await mkdir(dir, { recursive: true });

    await ensureSeeded(dir, createTestLogger());

    expect(await readdir(dir)).toEqual([]);
  });

  test("does not overwrite an edited rule on a later start", async () => {
    await ensureSeeded(dir, createTestLogger());
    await writeFile(
      join(dir, "cold-prompt-cache.json"),
      JSON.stringify({ ...DEFAULT_PRE_SEND_CHECKS[0], threshold: 60 }),
      "utf-8",
    );

    await ensureSeeded(dir, createTestLogger());

    const rules = await new PreSendCheckStore(dir, createTestLogger()).list();
    expect(rules.find((rule) => rule.id === "cold-prompt-cache")?.threshold).toBe(60);
  });

  test("does not create the directory it declined to seed", async () => {
    expect(existsSync(dir)).toBe(false);
  });
});

// These three moved here from the protocol package's evaluator tests when the
// constant did. They now pin the rule the daemon actually writes to disk, rather
// than a default the client could have synthesised.
describe("the seeded cold-prompt-cache rule", () => {
  test("allows a send one second short of an hour idle", () => {
    const evaluation = evaluatePreSendChecks(
      DEFAULT_PRE_SEND_CHECKS,
      context({ idleSeconds: 3599 }),
    );
    expect(evaluation.disposition).toBe("allow");
  });

  test("blocks a send at exactly an hour idle", () => {
    const evaluation = evaluatePreSendChecks(
      DEFAULT_PRE_SEND_CHECKS,
      context({ idleSeconds: 3600 }),
    );
    expect(evaluation.disposition).toBe("block");
    expect(evaluation.findings[0]?.ruleId).toBe("cold-prompt-cache");
  });

  test("does not fire on an agent whose idle time is unknown", () => {
    expect(evaluatePreSendChecks(DEFAULT_PRE_SEND_CHECKS, context()).disposition).toBe("allow");
  });
});
