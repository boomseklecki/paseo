import { RULE_ALWAYS_TRIGGER, RULE_RUNNABLE_OUTCOME_KINDS, RULE_TRIGGERS } from "./types.js";
import type { Rule } from "./types.js";
import { DEFAULT_RULE_EVENT, normalizeRule } from "./vocabulary.js";

/**
 * The seams a rule can be evaluated at, and what each one accepts.
 *
 * Two things differ per seam and both matter. **Where it runs**: `message.send`
 * is evaluated in the composer with a person waiting, everything else in the
 * daemon with nobody there. And **what it can ask for**: `block` needs a send to
 * hold, so it is meaningless anywhere else, and `notify` is meaningless at a
 * seam where the person is already looking at the screen.
 *
 * Declaring that here rather than letting the editor offer everything everywhere
 * is what stops a rule being saved that can never fire — a `turn.failed` rule
 * asking to `block` would be accepted, stored, evaluated and silently do
 * nothing, which is the worst of the available outcomes.
 */
export interface RuleEventDefinition {
  event: string;
  /** Which side evaluates it. Nothing reads this yet; it is why the lists below differ. */
  side: "composer" | "daemon";
  outcomeKinds: readonly string[];
  triggers: readonly string[];
}

/** Triggers that describe the agent rather than the message. */
const AGENT_TRIGGERS = RULE_TRIGGERS.filter(
  (trigger) => trigger !== "message",
) as readonly string[];

/**
 * The sweep's triggers, which are the agent ones without `always`.
 *
 * `always` says the event itself is the condition, and that reads sensibly at a
 * transition: a turn ended, a turn failed, each happening once and meaning it.
 * This seam is not a transition. It is a sweep, and an agent that goes on
 * sitting there reaches it again every minute for as long as it stays idle - so
 * an unconditional rule here asks to fire once a minute for the rest of the
 * session, which is not a thing anyone means by writing one.
 *
 * With a runnable outcome it is worse than noise. The crossing memory holds a
 * repeat back only until the condition stops holding, and this condition never
 * stops holding, so nothing re-arms and nothing bounds it either.
 *
 * Duration is what this seam is for, and `agent.idleSeconds` already says
 * "however long it has been" - `always` is that rule with the threshold left
 * out, not a different question.
 */
const IDLE_TRIGGERS = AGENT_TRIGGERS.filter(
  (trigger) => trigger !== RULE_ALWAYS_TRIGGER,
) as readonly string[];

export const RULE_EVENT_DEFINITIONS: readonly RuleEventDefinition[] = [
  {
    event: DEFAULT_RULE_EVENT,
    side: "composer",
    // No `notify`: there is a person at the keyboard, and the toast a `warn`
    // raises is already in front of them.
    outcomeKinds: ["warn", "block", ...RULE_RUNNABLE_OUTCOME_KINDS],
    triggers: RULE_TRIGGERS,
  },
  {
    event: "turn.completed",
    side: "daemon",
    // The seam for anything about where a conversation has got to - how full the
    // context is, what it has cost - because those settle when a turn ends. A
    // `usage.changed` seam would answer the same questions per token batch, and
    // the rules are re-read from disk on every evaluation, so it would be a
    // directory scan per token to learn something that only changes per turn.
    // Actions too, not just notify. An aside at a daemon seam is the same
    // hidden agent the composer's /btw uses, asked without anyone typing: write
    // the handoff before this conversation compacts, say why that turn failed.
    outcomeKinds: ["notify", ...RULE_RUNNABLE_OUTCOME_KINDS],
    triggers: AGENT_TRIGGERS,
  },
  {
    event: "agent.idle",
    side: "daemon",
    // The one seam with nothing to ride: every other is a transition the daemon
    // already detects, and nothing happens when an agent goes on not being
    // touched - which is the thing worth being told about. See idle-watcher.ts.
    // Actions too, not just notify. An aside at a daemon seam is the same
    // hidden agent the composer's /btw uses, asked without anyone typing: write
    // the handoff before this conversation compacts, say why that turn failed.
    outcomeKinds: ["notify", ...RULE_RUNNABLE_OUTCOME_KINDS],
    // No `always`: this seam is swept rather than reached, so an unconditional
    // rule fires every minute forever. See IDLE_TRIGGERS.
    triggers: IDLE_TRIGGERS,
  },
  {
    event: "turn.failed",
    side: "daemon",
    // No `warn` or `block`: the send already happened, and there is no composer
    // to hold anything in.
    // Actions too, not just notify. An aside at a daemon seam is the same
    // hidden agent the composer's /btw uses, asked without anyone typing: write
    // the handoff before this conversation compacts, say why that turn failed.
    outcomeKinds: ["notify", ...RULE_RUNNABLE_OUTCOME_KINDS],
    // No `message`: the text was sent a turn ago, so matching on it here would
    // fire on something the rule's author is no longer looking at.
    triggers: AGENT_TRIGGERS,
  },
];

export function findRuleEventDefinition(event: string): RuleEventDefinition | undefined {
  return RULE_EVENT_DEFINITIONS.find((definition) => definition.event === event);
}

/**
 * The rules belonging to one seam.
 *
 * Both sides filter, and both have to: a `turn.failed` rule evaluated in the
 * composer would hold a send over a condition about a turn that already failed,
 * and a `message.send` rule evaluated in the daemon would fire on every agent at
 * once. Neither list is a subset of the other, so neither side can skip this.
 *
 * A rule naming an event this build has never heard of belongs to no seam and is
 * evaluated by nobody, which is the same failing-open the evaluator does for an
 * unrecognised trigger.
 */
export function rulesForRuleEvent(rules: readonly Rule[], event: string): Rule[] {
  return rules.filter((rule) => normalizeRule(rule).event === event);
}

/**
 * Whether a rule asks for something its seam can do.
 *
 * Read by the editor to decide what to offer, and worth checking again at
 * evaluation: a rule can be hand-written, and one saved by a newer app may name
 * an event this build supports with an outcome it does not.
 */
export function isOutcomeValidForEvent(event: string, outcomeKind: string): boolean {
  const definition = findRuleEventDefinition(event);
  return definition ? definition.outcomeKinds.includes(outcomeKind) : false;
}

export function isTriggerValidForEvent(event: string, trigger: string): boolean {
  const definition = findRuleEventDefinition(event);
  return definition ? definition.triggers.includes(trigger) : false;
}
