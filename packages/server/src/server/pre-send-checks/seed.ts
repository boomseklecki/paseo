import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * The rules a fresh install starts with.
 *
 * This constant lives in the daemon rather than the protocol package on purpose.
 * It is only ever a seed — nothing evaluates it, nothing falls back to it — and
 * keeping it out of the shared package is what makes a client incapable of
 * inventing a rule the daemon did not serve. Exported from protocol it would sit
 * one `?? DEFAULT_PRE_SEND_CHECKS` away from a client turning "I have not loaded
 * the rules yet" into "block this send", which is the failure the whole
 * seed-to-disk arrangement exists to make unreachable.
 *
 * One hour because it is the longest TTL the Anthropic prompt-caching API offers
 * (`{"type":"ephemeral","ttl":"1h"}`), so past it the cache is cold under any
 * configuration and the next turn reprocesses the whole prefix. A shorter
 * threshold would be right only under the default 5-minute TTL and would fire
 * during ordinary think-time — noise that teaches people to ignore a block.
 *
 * No `message`, so it renders through the app's translated fallback while a
 * hand-written rule keeps its author's own wording.
 */
export const DEFAULT_PRE_SEND_CHECKS: readonly PreSendCheckRule[] = [
  {
    id: "cold-prompt-cache",
    measurement: "agent.idleSeconds",
    operator: "gte",
    threshold: 3600,
    disposition: "block",
  },
];

const README = `# Pre-send checks

Each \`*.json\` file here is one rule, evaluated against the current agent just
before a message leaves the composer. The daemon re-reads this directory rather
than caching it, so an edit takes effect without a restart — within about 30
seconds, or immediately on reconnect.

This file is not a rule. Only \`*.json\` is read.

## A rule

\`\`\`json
{
  "id": "cold-prompt-cache",
  "measurement": "agent.idleSeconds",
  "operator": "gte",
  "threshold": 3600,
  "disposition": "block",
  "message": "Optional. Overrides the built-in wording."
}
\`\`\`

\`id\` must match the filename. \`message\` may use \`{{value}}\`, \`{{threshold}}\`
and — for a duration measurement — \`{{duration}}\`.

## Measurements

| name | unit |
| --- | --- |
| \`agent.idleSeconds\` | seconds since the end of the agent's last turn |
| \`agent.contextUsedPercent\` | 0-100 |
| \`agent.sessionCostUsd\` | US dollars |

## Operators

\`gt\`, \`gte\`, \`lt\`, \`lte\`. There is no \`eq\`: exact equality on a duration or a
dollar amount never fires.

## Dispositions

\`warn\` shows a toast and sends anyway. \`block\` shows a toast and holds the send
with your typed text still in the box; pressing send again within a minute goes
through.

## Turning them off

Delete the rule files. An empty directory means no checks, and stays that way —
the defaults are only written when this directory does not exist at all.

Anything unreadable is skipped with a warning in the daemon log, and costs only
that rule. A malformed file cannot stop the daemon or disable the others.
`;

/**
 * Writes the shipped rules on a genuinely fresh install, and never again.
 *
 * The test is whether the directory exists, not whether it is empty, and that
 * distinction is the whole point: an empty directory is a user who deleted every
 * rule, and re-seeding it would silently undo them. It also means the client can
 * read an empty list as "no checks" rather than "not loaded", which is what keeps
 * the gate failing open.
 */
export async function ensureSeeded(dir: string, logger: Logger): Promise<void> {
  if (existsSync(dir)) {
    return;
  }

  await mkdir(dir, { recursive: true });
  await Promise.all([
    ...DEFAULT_PRE_SEND_CHECKS.map((rule) =>
      writeJsonFileAtomic(join(dir, `${rule.id}.json`), rule),
    ),
    writeFile(join(dir, "README.md"), README, "utf-8"),
  ]);
  logger.info({ dir, count: DEFAULT_PRE_SEND_CHECKS.length }, "Seeded default pre-send checks");
}
