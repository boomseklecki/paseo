import { PRE_SEND_ACTION_KINDS, PRE_SEND_TRIGGERS } from "./types.js";
import type { PreSendCheckRule } from "./types.js";
import { DEFAULT_PRE_SEND_EVENT, normalizePreSendCheckRule } from "./vocabulary.js";

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
export interface PreSendEventDefinition {
  event: string;
  /** Which side evaluates it. Nothing reads this yet; it is why the lists below differ. */
  side: "composer" | "daemon";
  outcomeKinds: readonly string[];
  triggers: readonly string[];
}

/** Triggers that describe the agent rather than the message. */
const AGENT_TRIGGERS = PRE_SEND_TRIGGERS.filter(
  (trigger) => trigger !== "message",
) as readonly string[];

export const PRE_SEND_EVENT_DEFINITIONS: readonly PreSendEventDefinition[] = [
  {
    event: DEFAULT_PRE_SEND_EVENT,
    side: "composer",
    // No `notify`: there is a person at the keyboard, and the toast a `warn`
    // raises is already in front of them.
    outcomeKinds: ["warn", "block", ...PRE_SEND_ACTION_KINDS],
    triggers: PRE_SEND_TRIGGERS,
  },
  {
    event: "turn.completed",
    side: "daemon",
    // The seam for anything about where a conversation has got to - how full the
    // context is, what it has cost - because those settle when a turn ends. A
    // `usage.changed` seam would answer the same questions per token batch, and
    // the rules are re-read from disk on every evaluation, so it would be a
    // directory scan per token to learn something that only changes per turn.
    outcomeKinds: ["notify"],
    triggers: AGENT_TRIGGERS,
  },
  {
    event: "turn.failed",
    side: "daemon",
    // No `warn` or `block`: the send already happened, and there is no composer
    // to hold anything in.
    outcomeKinds: ["notify"],
    // No `message`: the text was sent a turn ago, so matching on it here would
    // fire on something the rule's author is no longer looking at.
    triggers: AGENT_TRIGGERS,
  },
];

export function findPreSendEventDefinition(event: string): PreSendEventDefinition | undefined {
  return PRE_SEND_EVENT_DEFINITIONS.find((definition) => definition.event === event);
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
export function rulesForPreSendEvent(
  rules: readonly PreSendCheckRule[],
  event: string,
): PreSendCheckRule[] {
  return rules.filter((rule) => normalizePreSendCheckRule(rule).event === event);
}

/**
 * Whether a rule asks for something its seam can do.
 *
 * Read by the editor to decide what to offer, and worth checking again at
 * evaluation: a rule can be hand-written, and one saved by a newer app may name
 * an event this build supports with an outcome it does not.
 */
export function isOutcomeValidForEvent(event: string, outcomeKind: string): boolean {
  const definition = findPreSendEventDefinition(event);
  return definition ? definition.outcomeKinds.includes(outcomeKind) : false;
}

export function isTriggerValidForEvent(event: string, trigger: string): boolean {
  const definition = findPreSendEventDefinition(event);
  return definition ? definition.triggers.includes(trigger) : false;
}
