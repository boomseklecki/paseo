import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  PreSendCheckRuleSchema,
  type PreSendCheckRule,
} from "@getpaseo/protocol/pre-send-checks/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * One rule per file under a directory, read from disk on every access.
 *
 * Modelled on `ScheduleStore`, which is the only user-editable record list in the
 * daemon that a person can hand-edit while it runs: no in-memory copy means there
 * is nothing to go stale and nothing to overwrite an edit with. Rules were an
 * array in `config.json` first, and that arrangement did both.
 *
 * One deliberate divergence from `ScheduleStore`. It parses its files through
 * `Promise.all`, so a single malformed record rejects the whole list. Here that
 * would be doubly wrong: rules gate sends, so losing all of them silently turns
 * the gate off, and a rejected list parks the app's query in an error state it
 * never retries out of. A bad file costs that rule and nothing else.
 */
export class PreSendCheckStore {
  private readonly logger: Logger;

  constructor(
    private readonly dir: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "pre-send-checks", component: "store" });
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Every readable rule, id-sorted so callers can compare two lists for equality
   * without worrying about directory order.
   *
   * Only `*.json` is considered, which is what lets the seeded `README.md` sit
   * beside the rules and be ignored by construction rather than by convention.
   */
  async list(): Promise<PreSendCheckRule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const rules: PreSendCheckRule[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const rule = await this.readRuleFile(join(this.dir, entry.name));
      if (rule) {
        rules.push(rule);
      }
    }

    return rules.sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<PreSendCheckRule | null> {
    await this.ensureDir();
    return this.readRuleFile(this.filePath(id));
  }

  async create(rule: Omit<PreSendCheckRule, "id">): Promise<PreSendCheckRule> {
    const created = PreSendCheckRuleSchema.parse({ ...rule, id: generateRuleId() });
    await this.write(created);
    return created;
  }

  async delete(id: string): Promise<void> {
    await this.ensureDir();
    await rm(this.filePath(id), { force: true });
  }

  async write(rule: PreSendCheckRule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(rule.id), rule);
  }

  private async readRuleFile(filePath: string): Promise<PreSendCheckRule | null> {
    try {
      const content = await readFile(filePath, "utf-8");
      return PreSendCheckRuleSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.logger.warn({ err: error, filePath }, "Skipping invalid pre-send check rule");
      return null;
    }
  }
}

function generateRuleId(): string {
  return randomBytes(4).toString("hex");
}
