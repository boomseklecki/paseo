import type { PreSendCheckExample } from "@getpaseo/protocol/pre-send-checks/types";
import { isPlainOutcomeKind } from "@getpaseo/protocol/pre-send-checks/types";
import { PRE_SEND_OUTCOME_DESCRIPTORS } from "./outcomes/descriptors.js";

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
 * These live here beside the runners for the same reason those do: adding one is
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
      outcomes: [
        {
          kind: "aside",
          title: "Aside",
          prompt:
            "Answer this side question about the work in progress. Be brief, and do not change anything.\n\n{{message}}",
        },
      ],
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
      outcomes: [
        { kind: "notify", wording: "A turn failed on a session that has already cost {{value}}." },
      ],
    },
  },
  {
    id: "fork-on-slash-fork",
    label: "Fork the conversation on /fork",
    description:
      "Paseo has a fork button; this is the same thing as a shortcut you chose. Typing /fork carries the conversation into a new one instead of sending, and you land in the copy with everything up to that point.",
    rule: {
      trigger: "message",
      operator: "startsWith",
      value: "/fork",
      outcomes: [{ kind: "fork" }],
    },
  },
  {
    id: "start-fresh-when-full",
    label: "Open a fresh conversation when this one fills up",
    description:
      "At 85% a new conversation opens beside this one, in the same workspace, carrying none of the old one. Pair it with the handoff rule: one writes the summary, this one opens the place to take it. Forking here would carry in the very thing that triggered the rule.",
    rule: {
      event: "turn.completed",
      trigger: "agent.contextUsedPercent",
      operator: "gte",
      value: 85,
      outcomes: [
        {
          kind: "start",
          title: "Continued",
          prompt:
            "You are continuing work that filled its context. The previous conversation's handoff is in its subagent panel - ask for it if you need it. Start by saying what you understand the task to be.",
        },
      ],
    },
  },
  {
    id: "retry-after-a-failed-turn",
    label: "Try again ten minutes after a turn fails",
    description:
      "Most failed turns are a rate limit or a blip, and the fix is waiting rather than reading. This asks the conversation to try again once, later, and appears in the schedules list so you can cancel it if it was not a blip.",
    rule: {
      event: "turn.failed",
      trigger: "always",
      operator: "gte",
      outcomes: [
        {
          kind: "schedule",
          title: "Retry after a failure",
          delay: "10m",
          prompt: "The last turn failed. Try it again.",
        },
      ],
    },
  },
  {
    id: "notify-context-pressure",
    label: "Tell me when a conversation is nearly full",
    description:
      "Checked when a turn ends, and it reaches your phone rather than the screen you are not looking at - which is the point, because the thing to do about a full context is decide, and you cannot decide what you have not been told.",
    rule: {
      event: "turn.completed",
      trigger: "agent.contextUsedPercent",
      operator: "gte",
      value: 80,
      outcomes: [
        {
          kind: "notify",
          wording: "This conversation is {{value}} full. Wrap up or hand off before it compacts.",
        },
      ],
    },
  },
  {
    id: "notify-agent-left-idle",
    label: "Tell me when an agent has been left sitting",
    description:
      "An agent waiting on you looks exactly like an agent you finished with. This is the only rule that fires because nothing happened, which is what makes it the one worth having when you walked away mid-thought.",
    rule: {
      event: "agent.idle",
      trigger: "agent.idleSeconds",
      operator: "gte",
      value: 3600,
      outcomes: [{ kind: "notify", wording: "This agent has been idle for {{duration}}." }],
    },
  },
  {
    id: "handoff-before-compaction",
    label: "Write the handoff before a conversation compacts, and say so",
    description:
      "At 80% full, a hidden agent writes the summary you would have had to write yourself, and it appears under subagents. Two outcomes on one condition: the aside writes it, the notification tells you it is there - because a handoff nobody knows about is one nobody reads.",
    rule: {
      event: "turn.completed",
      trigger: "agent.contextUsedPercent",
      operator: "gte",
      value: 80,
      // The example that shows why outcomes are a list. Written as two rules
      // this is the same threshold twice, and the day someone adjusts one of
      // them the handoff and the notification stop meaning the same moment.
      outcomes: [
        {
          kind: "aside",
          title: "Handoff",
          prompt:
            "This conversation is nearly full and will compact soon. Write a handoff for whoever picks it up: what we were doing, what is decided, what is still open, and which files matter. Be specific and do not go looking - use what you already have.",
        },
        {
          kind: "notify",
          wording: "This conversation is {{value}} full. The handoff is under subagents.",
        },
      ],
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
      outcomes: [
        { kind: "warn", wording: "This conversation is {{value}}% full and will compact soon." },
      ],
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
      outcomes: [{ kind: "warn", wording: "This session has cost {{value}} so far." }],
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
      outcomes: [{ kind: "block" }],
    },
  },
];

/**
 * The examples this daemon could actually carry out.
 *
 * An example naming an outcome the daemon does not have would install a rule
 * that redirects a message into a decline — the message comes back unsent, with
 * nothing on screen explaining why the rule the person just chose did nothing.
 * Cheaper to never offer it.
 *
 * Every outcome has to be available, not merely one of them. An example is a
 * whole rule someone is being offered by its description, and installing half of
 * what that promised is worse than not being offered it at all. Deliberately the
 * opposite of how the evaluator treats a *stored* rule, which keeps the half it
 * understands — there the rule already exists, and dropping it would disarm
 * something a person wrote.
 *
 * A plain outcome is always available: a warn or a block needs nothing of the
 * daemon beyond evaluating it, which every version can do.
 */
export function listPreSendCheckExamples(
  examples: readonly PreSendCheckExample[] = PRE_SEND_CHECK_EXAMPLES,
  outcomeKinds: readonly string[] = PRE_SEND_OUTCOME_DESCRIPTORS.map(
    (descriptor) => descriptor.kind,
  ),
): PreSendCheckExample[] {
  return examples.filter((example) =>
    example.rule.outcomes.every(
      (outcome) => isPlainOutcomeKind(outcome.kind) || outcomeKinds.includes(outcome.kind),
    ),
  );
}
