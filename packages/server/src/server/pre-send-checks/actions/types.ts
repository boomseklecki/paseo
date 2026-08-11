import type { PreSendAction } from "@getpaseo/protocol/pre-send-checks/types";

/**
 * What a rule does instead of sending.
 *
 * One action exists today and the dispatch for it is a single check on
 * `action.kind`. That check is not ceremony: a newer client can set a kind this
 * daemon has never heard of, and a redirect consumes what was typed, so
 * declining an action it cannot perform is the difference between a message
 * sending normally and a message disappearing.
 *
 * `action.kind` is the registry key, and `./registry.js` is the lookup a second
 * action turned it into. It stayed a single `if` for exactly as long as there
 * was one row.
 */

/**
 * What happened, in the caller's vocabulary rather than the action's.
 *
 * `needs_confirmation` is generic while its `reason` is not: "this may want to
 * ask first" is a property of actions in general, what it asks about is not.
 *
 * `declined` and `failed` are kept apart because they need opposite answers.
 * Declined means the action never started and the message should be sent the
 * ordinary way. Failed means the action was the right one and did not work —
 * and sending the text on anyway would deliver `/btw what does this flag do` to
 * the agent as an instruction.
 */
export type PreSendActionOutcome =
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

export interface PreSendActionRequest {
  /** The conversation the message was typed into. */
  agentId: string;
  /** The full text, trigger prefix and all. Trimming it is the action's business. */
  message: string;
  action: PreSendAction;
  /** True on a second attempt, after the caller answered a `needs_confirmation`. */
  confirmed: boolean;
}
