import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "pino";
import { isRuleId, RuleSchema, type Rule } from "@getpaseo/protocol/rules/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

export type RuleUpdater = (rule: Rule) => Rule | Promise<Rule>;

/**
 * One rule per file under a directory, read from disk on every access.
 *
 * Modelled on `ScheduleStore`: no in-memory copy means there is nothing to go
 * stale and nothing to overwrite an edit with. Rules were an array in
 * `config.json` first, and that arrangement did both.
 *
 * The fresh read is an implementation detail, not a promise. It came from hand
 * editing, which is no longer a goal — see "How this lands in SQL" in
 * `docs/data-model.md`. At the migration this becomes a table read and the
 * 30-second poll in the service goes with it; neither needs preserving.
 *
 * Two deliberate divergences from `ScheduleStore`. It parses its files through
 * `Promise.all`, so a single malformed record rejects the whole list. Here that
 * would be doubly wrong: rules gate sends, so losing all of them silently turns
 * the gate off, and a rejected list parks the app's query in an error state it
 * never retries out of. A bad file costs that rule and nothing else. And its
 * mutation queue is per id, where this one is store-wide — see `mutate`.
 *
 * There is no `create`, and its absence is deliberate. Ids arrive from the
 * client, because one rule can live on several hosts and the app groups those
 * copies by id — a store minting its own would give the same rule a different id
 * on every daemon. So `write` is the creation path as well as the update one,
 * which is what `rules.upsert.request` is named after.
 */
export class RuleStore {
  private readonly logger: Logger;
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dir: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "rules", component: "store" });
  }

  /**
   * An id is a filename, so it has to be one path segment and nothing clever.
   *
   * The client mints these and sends them over the wire, which makes this the
   * daemon's own boundary rather than a formality: `../../..` in an id would put
   * a write outside the rules directory entirely.
   */
  private filePath(id: string): string {
    if (!isRuleId(id)) {
      throw new Error(`Rule id is not a usable filename: ${JSON.stringify(id)}`);
    }
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Every readable rule, in the order they should be shown.
   *
   * Sorted by `order` and then by id, so the result is stable however `readdir`
   * happened to enumerate the directory — which is what lets the service compare
   * two lists for equality to decide whether anything changed. A rule with no
   * `order` sorts after every ordered one rather than at an arbitrary point, so
   * adding the field to some rules and not others has a predictable result.
   *
   * Only `*.json` is considered, which is what lets the seeded `README.md` sit
   * beside the rules and be ignored by construction rather than by convention.
   */
  async list(): Promise<Rule[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const rules: Rule[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      // A name the id rules would reject cannot be written back, so listing it
      // would hand out a rule that fails the moment anyone edits it.
      if (!isRuleId(basename(entry.name, ".json"))) {
        this.logger.warn(
          { fileName: entry.name },
          "Skipping a rule whose filename cannot be a rule id",
        );
        continue;
      }
      const rule = await this.readRuleFile(join(this.dir, entry.name));
      if (rule) {
        rules.push(rule);
      }
    }

    return rules.sort(compareRules);
  }

  async get(id: string): Promise<Rule | null> {
    await this.ensureDir();
    return this.readRuleFile(this.filePath(id));
  }

  async delete(id: string): Promise<void> {
    await this.mutate(async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  async write(rule: Rule): Promise<void> {
    await this.mutate(() => this.writeRuleFile(rule));
  }

  /**
   * Applies `updater` to one rule and writes the result.
   *
   * The only path for a partial edit. `write` takes a whole record, so without
   * this every caller changing one field has to read, spread and write back —
   * a read-merge-write loop on the wrong side of the store surface
   * (`docs/data-model.md`), and one a SQL store would have to undo. Returns null
   * when the rule is gone, so an edit racing a delete does not resurrect it.
   */
  async update(id: string, updater: RuleUpdater): Promise<Rule | null> {
    return this.mutate(async () => {
      const current = await this.readRuleFile(this.filePath(id));
      if (!current) {
        return null;
      }
      const next = RuleSchema.parse(await updater(current));
      if (next.id !== id) {
        throw new Error(`Rule update cannot change id: ${id}`);
      }
      await this.writeRuleFile(next);
      return next;
    });
  }

  /**
   * Rewrites every rule's position in one pass.
   *
   * Here rather than in the service because it is a read-merge-write spanning
   * records. The service's version listed and then wrote each rule back in a
   * loop, so a write failing partway left the list visibly rearranged rather
   * than untouched — unordered rules sort last, so the half that had not been
   * reached jumped to the end — and a concurrent edit of a rule the loop had yet
   * to reach was overwritten with the pre-edit copy the list had captured.
   *
   * Assigns `order` by index, so the arrangement is explicit on disk rather than
   * implied by whatever was there before. Ids the store does not have are
   * skipped; rules the caller omitted keep the order they had, which puts them
   * after the arranged ones. A rule already sitting at its position is not
   * rewritten, so reordering to the order that is already there touches nothing
   * and the service broadcasts nothing.
   *
   * Runs inside the mutation queue and puts back what it had already written if
   * a later write fails, so the list ends up wholly rearranged or wholly as it
   * was. Files, not rows: that is a compensating write and not a rollback, and
   * it is the closest a directory gets to the transaction SQL will give this.
   */
  async reorder(ruleIds: readonly string[]): Promise<void> {
    await this.mutate(async () => {
      const byId = new Map((await this.list()).map((rule) => [rule.id, rule]));

      const pending: Rule[] = [];
      let position = 0;
      for (const id of ruleIds) {
        const rule = byId.get(id);
        if (!rule) {
          continue;
        }
        if (rule.order !== position) {
          pending.push({ ...rule, order: position });
        }
        position += 1;
      }

      const written: Rule[] = [];
      try {
        for (const rule of pending) {
          await this.writeRuleFile(rule);
          written.push(rule);
        }
      } catch (error) {
        await this.restoreRules(written.map((rule) => byId.get(rule.id)));
        throw error;
      }
    });
  }

  /**
   * Runs a mutation once every mutation queued before it has settled.
   *
   * Store-wide, where `ScheduleStore` keys its chains by id. `reorder` spans
   * records, and taking several per-id locks in sequence is where deadlock
   * lives; this store holds a handful of small files, so the contention that
   * would pay for the finer grain does not exist. A failed mutation must not
   * poison the queue for the next one, hence the swallowed catch.
   */
  private async mutate<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => undefined).then(mutation);
    this.mutations = next;
    return next;
  }

  private async writeRuleFile(rule: Rule): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(rule.id), rule);
  }

  /**
   * Best effort, and loud when it fails: the caller is already throwing, so a
   * failure here would otherwise vanish behind the error that caused it.
   */
  private async restoreRules(rules: readonly (Rule | undefined)[]): Promise<void> {
    for (const rule of rules) {
      if (!rule) {
        continue;
      }
      try {
        await this.writeRuleFile(rule);
      } catch (error) {
        this.logger.error(
          { err: error, id: rule.id },
          "Failed to restore a rule after an incomplete reorder",
        );
      }
    }
  }

  /**
   * Reads one file, and takes the rule's id from its name rather than from
   * inside it.
   *
   * `get` looked a rule up by filename while `list` trusted the id in the body,
   * so the two could disagree: copying a rule file to a new name left two files
   * claiming one id, and `get` would answer with whichever one the name pointed
   * at. That is a duplicate primary key waiting for a store that has one.
   *
   * The filename wins because it is the half a person edits — renaming a file is
   * how you copy a rule, and having to remember to change a field inside it is
   * the kind of bookkeeping a hand-editable directory should not ask for. It
   * also means a rule file needs no `id` at all. Logged at debug rather than
   * warn: the list is re-read every 30 seconds, so anything louder is a
   * permanent stream about a file that works.
   */
  private async readRuleFile(filePath: string): Promise<Rule | null> {
    const id = basename(filePath, ".json");
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      const body = parsed !== null && typeof parsed === "object" ? parsed : {};
      const declared = (body as { id?: unknown }).id;
      if (typeof declared === "string" && declared !== id) {
        this.logger.debug(
          { filePath, declaredId: declared, id },
          "Rule id does not match its filename; the filename wins",
        );
      }
      return RuleSchema.parse({ ...body, id });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      this.logger.warn({ err: error, filePath }, "Skipping invalid rule");
      return null;
    }
  }
}

// Unordered rules go last rather than first, so a rule saved by a client that
// does not know about ordering never displaces the arrangement someone chose.
function compareRules(left: Rule, right: Rule): number {
  const leftOrder = typeof left.order === "number" ? left.order : Number.POSITIVE_INFINITY;
  const rightOrder = typeof right.order === "number" ? right.order : Number.POSITIVE_INFINITY;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}
