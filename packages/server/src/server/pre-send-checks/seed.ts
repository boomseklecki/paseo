import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import {
  DEFAULT_PRE_SEND_EVENT,
  projectPreSendCheckRule,
} from "@getpaseo/protocol/pre-send-checks/vocabulary";
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
  // Through the projector, so the file on disk carries both vocabularies: this
  // is the one rule a fresh install has, and a client older than the rename
  // still has to be able to read it.
  projectPreSendCheckRule({
    id: "cold-prompt-cache",
    event: DEFAULT_PRE_SEND_EVENT,
    trigger: "agent.idleSeconds",
    operator: "gte",
    value: 3600,
    outcome: { kind: "block" },
    message: undefined,
    order: undefined,
    enabled: true,
  }),
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
  "trigger": "agent.idleSeconds",
  "operator": "gte",
  "value": 3600,
  "outcome": { "kind": "block" },
  "message": "Optional. Overrides the built-in wording."
}
\`\`\`

The filename is the id — a rule needs no \`id\` field, and one that disagrees is
read under its filename anyway. \`message\` may use \`{{value}}\` and, for a
duration trigger, \`{{duration}}\`.

The seeded files also carry \`measurement\`, \`threshold\` and \`disposition\`,
which are the older names for \`trigger\`, \`value\` and \`outcome.kind\`. They are
written so a Paseo older than 0.3.2 can still read these rules, and either name
works if you write one by hand. The newer name wins where both appear.

## Triggers

| name | unit |
| --- | --- |
| \`agent.idleSeconds\` | seconds since the end of the agent's last turn |
| \`agent.contextUsedPercent\` | 0-100 |
| \`agent.sessionCostUsd\` | US dollars |
| \`message\` | the text about to be sent, compared as a string |

## Operators

\`gt\`, \`gte\`, \`lt\`, \`lte\` for numbers. There is no \`eq\`: exact equality on a
duration or a dollar amount never fires. \`startsWith\` and \`contains\` for
\`message\`, both ignoring case.

## Outcomes

\`{"kind": "warn"}\` shows a toast and sends anyway. \`{"kind": "block"}\` shows a
toast and holds the send with your typed text still in the box; pressing send
again within a minute goes through. Any other kind names an action that takes
the message instead of sending it — \`{"kind": "aside"}\` answers it in a hidden
agent and shows the reply under subagents. A kind this Paseo cannot perform is
skipped, and the message sends normally.

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
