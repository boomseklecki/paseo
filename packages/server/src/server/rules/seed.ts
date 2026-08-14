import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { DEFAULT_RULE_EVENT, projectRule } from "@getpaseo/protocol/rules/vocabulary";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * The rules a fresh install starts with.
 *
 * This constant lives in the daemon rather than the protocol package on purpose.
 * It is only ever a seed — nothing evaluates it, nothing falls back to it — and
 * keeping it out of the shared package is what makes a client incapable of
 * inventing a rule the daemon did not serve. Exported from protocol it would sit
 * one `?? DEFAULT_RULES` away from a client turning "I have not loaded
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
export const DEFAULT_RULES: readonly Rule[] = [
  // Through the projector, so the file on disk carries both vocabularies: this
  // is the one rule a fresh install has, and a client older than the rename
  // still has to be able to read it.
  projectRule({
    id: "cold-prompt-cache",
    event: DEFAULT_RULE_EVENT,
    trigger: "agent.idleSeconds",
    operator: "gte",
    value: 3600,
    outcomes: [{ kind: "block" }],
    message: undefined,
    order: undefined,
    enabled: true,
  }),
];

const README = `# Rules

Each \`*.json\` file here is one rule, evaluated against the current agent at the
moment it names — see Events below. The daemon re-reads this directory rather
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
  "outcomes": [{ "kind": "block", "wording": "Optional. Replaces the built-in sentence." }]
}
\`\`\`

The filename is the id — a rule needs no \`id\` field, and one that disagrees is
read under its filename anyway.

\`wording\` is what a person is told, and it belongs to the outcome that tells
them: \`warn\`, \`block\` and \`notify\` each carry their own. It may use
\`{{value}}\`, \`{{threshold}}\` and, for a duration trigger, \`{{duration}}\`.
A runnable outcome has no \`wording\` — it takes a \`prompt\`, which may use
\`{{value}}\` anywhere and \`{{message}}\` only at \`message.send\`, since
nobody types anything at the other seams.

The seeded files also carry \`measurement\`, \`threshold\`, \`disposition\`,
\`action\`, a singular \`outcome\` and a rule-level \`message\`, which are the
older names for \`trigger\`, \`value\`, \`outcomes\` and \`wording\`. They are written so a Paseo older than
0.3.2 can still read these rules, and either name works if you write one by
hand. The newer name wins where both appear, and where an older Paseo can carry
out only one outcome it gets the one that decides what happens to the message.

## Events

\`event\` says which moment a rule is evaluated at. Absent means
\`message.send\`, which is the only one that existed at first.

| name | when | outcomes | evaluated by |
| --- | --- | --- | --- |
| \`message.send\` | before a message leaves the composer | \`warn\`, \`block\`, a runner | the app |
| \`turn.completed\` | after an agent's turn ends | \`notify\`, a runner | the daemon |
| \`turn.failed\` | after an agent's turn fails | \`notify\`, a runner | the daemon |
| \`agent.idle\` | while an agent sits untouched, swept each minute | \`notify\`, a runner | the daemon |

An outcome its event does not accept is dropped and the rest of the rule still
runs, so a \`block\` on \`turn.failed\` never fires but a \`notify\` beside it
does. A rule whose every outcome the event refuses is skipped entirely.

A daemon-side rule fires on the *crossing*, not on the condition: once it has
notified, it stays quiet until the condition stops holding and starts again.
Otherwise a rule about a session's cost would notify on every failed turn for
the rest of that session. Restarting the daemon arms every rule afresh.

## Triggers

| name | unit |
| --- | --- |
| \`agent.idleSeconds\` | seconds since the end of the agent's last turn |
| \`agent.contextUsedPercent\` | 0-100 |
| \`agent.sessionCostUsd\` | US dollars |
| \`message\` | the text about to be sent, compared as a string |
| \`always\` | no comparison; the event itself is the condition |

## Operators

\`gt\`, \`gte\`, \`lt\`, \`lte\` for numbers. There is no \`eq\`: exact equality on a
duration or a dollar amount never fires. \`startsWith\` and \`contains\` for
\`message\`, both ignoring case.

## Outcomes

\`outcomes\` is a list, and everything in it happens. \`{"kind": "warn"}\` shows
a toast and sends anyway. \`{"kind": "block"}\` shows a toast and holds the send
with your typed text still in the box; pressing send again within a minute goes
through. \`{"kind": "notify"}\` reaches your phone, and only means something at a
daemon-side event. Any other kind names something the daemon runs with the
message instead of sending it — \`{"kind": "aside"}\` answers it in a hidden agent
and shows the reply under subagents; \`fork\`, \`start\` and \`schedule\` are the
others.

Listing several is how one condition gets more than one answer: an \`aside\` that
writes a handoff and a \`notify\` that tells you it is there are one moment, and
writing them as two rules means keeping two copies of the threshold in step.
Where two of them want the message, the most decisive one gets it and the rest
still run. A kind this Paseo cannot perform is dropped, and the outcomes beside
it still happen.

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
 *
 * Directory-existence has no SQL analogue, and the migration is where that bites:
 * an empty table cannot say whether it was never seeded or emptied on purpose. It
 * is deliberately *not* solved here with a marker file — this directory is
 * user-facing and hand-editable, and hidden bookkeeping in it is one more thing to
 * explain and one more thing to delete by accident. The marker belongs at the
 * import boundary, where `legacy_imports` already provides one. See "How this
 * lands in SQL" in `docs/data-model.md` for what the importer has to do with an
 * empty directory, which is the case it would otherwise get wrong.
 */
export async function ensureSeeded(dir: string, logger: Logger): Promise<void> {
  if (existsSync(dir)) {
    return;
  }

  await mkdir(dir, { recursive: true });
  await Promise.all([
    ...DEFAULT_RULES.map((rule) => writeJsonFileAtomic(join(dir, `${rule.id}.json`), rule)),
    writeFile(join(dir, "README.md"), README, "utf-8"),
  ]);
  logger.info({ dir, count: DEFAULT_RULES.length }, "Seeded default rules");
}
