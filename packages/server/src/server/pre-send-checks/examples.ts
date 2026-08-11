import type { PreSendCheckExample } from "@getpaseo/protocol/pre-send-checks/types";
import { isPlainOutcomeKind } from "@getpaseo/protocol/pre-send-checks/types";
import { PRE_SEND_ACTION_DESCRIPTORS } from "./actions/descriptors.js";

/**
 * Rules worth suggesting, none of them installed.
 *
 * The reason this exists rather than a longer default seed: a rule that
 * intercepts what you type is not something to switch on for someone who did
 * not ask for it. `/btw` below was very nearly a default, and it takes a message
 * away from the conversation you meant to send it to — which is right when you
 * chose it and alarming when you did not. So the daemon offers and the person
 * installs.
 *
 * These live here beside the actions for the same reason those do: adding one is
 * a server change, and an older app shows a newer daemon's example without
 * having shipped anything. The English is a fallback — the app translates the
 * ids it recognises and falls back to `label` for the ones it does not, so a
 * newer example appears untranslated rather than not at all.
 */
export const PRE_SEND_CHECK_EXAMPLES: readonly PreSendCheckExample[] = [
  {
    id: "aside-on-btw",
    label: "Answer /btw on the side",
    description:
      "A message starting with /btw is answered by a hidden agent instead of being sent, and the reply appears under subagents. The conversation is not interrupted and gains no context.",
    rule: {
      trigger: "message",
      operator: "startsWith",
      value: "/btw",
      outcome: {
        kind: "aside",
        title: "Aside",
        prompt:
          "Answer this side question about the work in progress. Be brief, and do not change anything.\n\n{{message}}",
      },
    },
  },
  {
    id: "notify-on-failed-turn",
    label: "Tell me when a turn fails after a costly session",
    description:
      "The daemon already says when an agent stops with an error. This says it again, in your words, only once this session has passed a cost worth interrupting you for.",
    rule: {
      event: "turn.failed",
      trigger: "agent.sessionCostUsd",
      operator: "gte",
      value: 25,
      outcome: { kind: "notify" },
      message: "A turn failed on a session that has already cost {{value}}.",
    },
  },
  {
    id: "warn-context-nearly-full",
    label: "Warn when the context is nearly full",
    description:
      "Says so at 80% rather than at the compaction that follows, which is the point where finishing the thought is still cheaper than restarting it.",
    rule: {
      trigger: "agent.contextUsedPercent",
      operator: "gte",
      value: 80,
      outcome: { kind: "warn" },
      message: "This conversation is {{value}}% full and will compact soon.",
    },
  },
  {
    id: "warn-session-cost",
    label: "Warn once a session passes a cost",
    description:
      "A warning rather than a block, because the number that matters is different every day and a block on the wrong one is a rule you turn off.",
    rule: {
      trigger: "agent.sessionCostUsd",
      operator: "gte",
      value: 10,
      outcome: { kind: "warn" },
      message: "This session has cost {{value}} so far.",
    },
  },
  {
    id: "block-cold-prompt-cache",
    label: "Block when the prompt cache has gone cold",
    description:
      "An hour is the longest cache TTL the provider offers, so past it the next turn reprocesses the whole conversation. This is what a fresh install starts with.",
    rule: {
      trigger: "agent.idleSeconds",
      operator: "gte",
      value: 3600,
      outcome: { kind: "block" },
    },
  },
];

/**
 * The examples this daemon could actually carry out.
 *
 * An example naming an action the daemon does not have would install a rule that
 * redirects a message into a decline — the message comes back unsent, with
 * nothing on screen explaining why the rule the person just chose did nothing.
 * Cheaper to never offer it.
 *
 * A plain outcome is always offered: a warn or a block needs nothing of the
 * daemon beyond evaluating it, which every version can do.
 */
export function listPreSendCheckExamples(
  examples: readonly PreSendCheckExample[] = PRE_SEND_CHECK_EXAMPLES,
  actionKinds: readonly string[] = PRE_SEND_ACTION_DESCRIPTORS.map((descriptor) => descriptor.kind),
): PreSendCheckExample[] {
  return examples.filter((example) => {
    const kind = example.rule.outcome.kind;
    return isPlainOutcomeKind(kind) || actionKinds.includes(kind);
  });
}
