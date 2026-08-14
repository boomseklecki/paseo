/**
 * How an aside gets the parent's conversation, and what that costs.
 *
 * Split from the runner because the decision is the interesting part and it is
 * pure: which route, whether to ask first, and how big the bill will be. The
 * runner does the provider work and has nothing worth asserting on.
 */

/**
 * Resuming the parent's session sends only the new question; the provider still
 * holds the conversation and reads it from cache. Replaying sends the whole
 * transcript as prompt text, which works on any provider and pays for the
 * transcript every time.
 *
 * Measured against a real ~50k-token conversation: resume cost $0.0072, replay
 * $0.0272 for the same question and answer. Both showed a similar cached-token
 * count, because `AgentUsage` collapses cache writes and cache reads into one
 * field — the cost is what separates them, and the gap widens with transcript
 * length.
 */
export type AsideRoute = "resume" | "replay";

/**
 * Above this, a replay is worth interrupting for.
 *
 * A replay re-reads the entire conversation, so the cost scales with how long
 * you have been working rather than with what you asked. That is exactly the
 * surprise worth a prompt: the question was one line, and the bill is for
 * everything said before it.
 *
 * Resuming is never gated however large the conversation, because there the
 * question really does cost what it looks like it costs.
 */
export const ASIDE_REPLAY_CONFIRM_TOKENS = 20_000;

/**
 * Characters per token. Crude on purpose and only ever used to decide whether to
 * ask, never to bill: a real tokenizer here would be a provider-specific
 * dependency bought to move a threshold that is itself a judgement call.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface AsidePlanInput {
  /** Whether the parent's provider left a session that can be resumed. */
  canResume: boolean;
  /** The transcript that a replay would have to send. */
  transcriptChars: number;
  /** True once the caller has answered a confirmation. */
  confirmed: boolean;
}

export type AsidePlan =
  | { decision: "run"; route: AsideRoute }
  | { decision: "confirm"; route: "replay"; estimatedTokens: number };

/**
 * Resume where the provider kept the conversation, replay where it did not, and
 * ask first only when replaying something large.
 *
 * Confirmation is checked after the route, not before, so a resume is never
 * gated — there is nothing to warn about when the expensive part is already
 * cached.
 */
export function planAside(input: AsidePlanInput): AsidePlan {
  if (input.canResume) {
    return { decision: "run", route: "resume" };
  }
  const estimatedTokens = estimateTokens(input.transcriptChars);
  if (!input.confirmed && estimatedTokens > ASIDE_REPLAY_CONFIRM_TOKENS) {
    return { decision: "confirm", route: "replay", estimatedTokens };
  }
  return { decision: "run", route: "replay" };
}
