import type { RuleOutcomeSpec } from "@getpaseo/protocol/rules/types";

/**
 * What a rule does instead of sending.
 *
 * Dispatch is a single check on `outcome.kind`. That check is not ceremony: a
 * newer client can set a kind this daemon has never heard of, and a redirect
 * consumes what was typed, so declining an outcome it cannot perform is the
 * difference between a message sending normally and a message disappearing.
 *
 * `outcome.kind` is the registry key, and `./registry.js` is the lookup a second
 * outcome turned it into. It stayed a single `if` for exactly as long as there
 * was one row.
 */

/**
 * What happened, in the caller's vocabulary rather than the outcome's.
 *
 * `needs_confirmation` is generic while its `reason` is not: "this may want to
 * ask first" is a property of outcomes in general, what it asks about is not.
 *
 * `declined` and `failed` are kept apart because they need opposite answers.
 * Declined means the outcome never started and the message should be sent the
 * ordinary way. Failed means the outcome was the right one and did not work —
 * and sending the text on anyway would deliver `/btw what does this flag do` to
 * the agent as an instruction.
 */
export type RuleOutcomeResult =
  | {
      status: "started";
      subagentId: string;
      /**
       * Set when what started is a real agent rather than a hidden subagent, so
       * a caller can go and look at it. An aside leaves this absent on purpose:
       * there is nowhere to navigate to, which is the whole point of an aside.
       */
      agentId?: string;
    }
  | { status: "needs_confirmation"; reason: string; estimatedTokens?: number }
  | { status: "declined"; reason: string }
  | { status: "failed"; reason: string };

export interface RuleOutcomeRequest {
  /** The conversation the message was typed into. */
  agentId: string;
  /**
   * What someone typed, trigger prefix and all. Empty at a daemon seam, where
   * nobody typed anything — which is why `{{message}}` is only offered in the
   * editor at `message.send`.
   */
  message: string;
  /**
   * The measured value that tripped the rule, already formatted for reading:
   * `80%`, `$25.00`, `2 hours`. Filled at every seam, which is what makes
   * `{{value}}` the token a daemon-side prompt can actually use.
   */
  value: string;
  outcome: RuleOutcomeSpec;
  /** True on a second attempt, after the caller answered a `needs_confirmation`. */
  confirmed: boolean;
  /**
   * True when the turn that reached this seam was started by a rule's schedule.
   *
   * The generation counter for the one outcome that acts on the agent it fired
   * for. `start` and `fork` can read their own provenance off the agent they
   * were handed, because they made it; `schedule` makes nothing and hands the
   * existing conversation a turn, so nothing on the agent says where the turn
   * came from and the seam has to say it.
   *
   * Read at the seam rather than looked up in the outcome, because the run is
   * still in flight there and will not be by the time the outcome is dispatched.
   * Absent at `message.send`, where a person is the cause.
   */
  causedByRuleSchedule?: boolean;
}

/**
 * Marks an agent a rule created, so a rule cannot create from it again.
 *
 * The edge trigger stops a rule firing twice for the same agent, which covers
 * every outcome that acts on the conversation it fired for. It cannot cover the
 * two that make a *new* agent: a fresh id has a fresh memory, so a
 * `turn.completed` rule with a `start` outcome creates an agent, whose turn
 * completes, which fires the rule again, without bound.
 *
 * One generation is the cap and it is deliberate rather than tunable. Every
 * legitimate chain anyone has wanted is one hop — fork on a failure, start when
 * full — and the second hop is always the runaway rather than a use case.
 */
/**
 * Fills a prompt's tokens.
 *
 * One function because three runners were each doing their own half of it, and
 * the halves had already drifted: the aside appended the message when the
 * template named no token and the others silently dropped it. Appending is the
 * aside's own behaviour and stays there; what is shared is the substitution.
 */
export function renderRulePrompt(template: string, request: RuleOutcomeRequest): string {
  return template.replaceAll("{{message}}", request.message).replaceAll("{{value}}", request.value);
}

/** Whether a template asks for anything that has to be substituted. */
export function promptUsesRuleToken(template: string): boolean {
  return template.includes("{{message}}") || template.includes("{{value}}");
}

export const RULE_CREATED_AGENT_LABEL = "paseo.created-by-rule";

export function wasCreatedByRule(labels: Record<string, string> | undefined): boolean {
  return typeof labels?.[RULE_CREATED_AGENT_LABEL] === "string";
}
