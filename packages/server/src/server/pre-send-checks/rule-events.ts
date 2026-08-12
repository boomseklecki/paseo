import type { PreSendEventFinding } from "@getpaseo/protocol/pre-send-checks/evaluate";
import { evaluatePreSendEvent } from "@getpaseo/protocol/pre-send-checks/evaluate";
import type {
  PreSendCheckRule,
  PreSendMeasurementContext,
} from "@getpaseo/protocol/pre-send-checks/types";

/**
 * Fires a daemon-side rule on the crossing, not on the condition.
 *
 * A rule at a composer seam is asked once, because a person pressed send once. A
 * rule at a daemon seam is asked every time the seam fires, and "context is over
 * 80%" is true for every turn from the first one past 80% until the conversation
 * ends. Evaluating that honestly and notifying each time is a notification per
 * turn, which is how a feature teaches people to turn it off.
 *
 * So what fires is the transition: a rule that was not tripping for this agent
 * and now is. It re-arms when the condition goes away, so a cost rule that trips,
 * is dealt with, and trips again later says so twice — which is right, because
 * those are two occasions.
 *
 * The memory is per (agent, rule) and lives here rather than in the rule file.
 * Rules are user-editable records and this is runtime state; writing it back
 * would mean a notification rewriting the rule that caused it, and a person
 * hand-editing a rule would be editing around a field they did not put there.
 *
 * **A restart re-arms everything**, and that is the accepted cost of not
 * persisting: after a daemon restart the first matching seam notifies again for
 * a condition that had already been reported. The alternative is a store, a
 * migration and a cleanup path for agents that no longer exist, to save one
 * duplicate notification per restart.
 */
export class PreSendRuleEventTracker {
  /**
   * Rule ids currently tripping, per agent *and seam*. Absent means nothing has
   * tripped yet.
   *
   * Keyed by both, and that is not tidiness. Each call replaces the whole set
   * for its key, so with one key per agent a seam that matched nothing would
   * wipe what another seam was remembering: a completed turn with no rules
   * matching would clear the failure seam's memory, and the next failed turn
   * would notify again for a condition it had already reported. Two seams is
   * what turned that from theory into a bug.
   */
  private readonly tripping = new Map<string, Set<string>>();

  private static key(agentId: string, event: string): string {
    return `${agentId}\u0000${event}`;
  }

  /**
   * The findings that are new since the last time this agent reached this seam.
   *
   * Also updates the memory, so calling it twice with the same input answers
   * once — which is the property the caller depends on and the reason this is
   * not a pure function.
   */
  fired(
    agentId: string,
    event: string,
    findings: readonly PreSendEventFinding[],
  ): PreSendEventFinding[] {
    const key = PreSendRuleEventTracker.key(agentId, event);
    const previous = this.tripping.get(key) ?? new Set<string>();
    const current = new Set(findings.map((finding) => finding.ruleId));

    if (current.size === 0) {
      // Nothing tripping: drop the entry rather than keeping an empty set, so an
      // idle daemon's memory is proportional to what is wrong.
      this.tripping.delete(key);
    } else {
      this.tripping.set(key, current);
    }

    return findings.filter((finding) => !previous.has(finding.ruleId));
  }

  /**
   * Forgets an agent at every seam, so its rules arm again from nothing.
   *
   * Called when an agent is closed or deleted. Without it the map grows for the
   * life of the daemon, one entry per agent and seam that ever tripped a rule.
   */
  forget(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    for (const key of this.tripping.keys()) {
      if (key.startsWith(prefix)) {
        this.tripping.delete(key);
      }
    }
  }
}

export interface PreSendRuleEventInput {
  agentId: string;
  event: string;
  rules: readonly PreSendCheckRule[];
  context: PreSendMeasurementContext;
}

/**
 * Evaluates one seam for one agent and reports only what newly tripped.
 *
 * The two halves are separable and tested apart: `evaluatePreSendEvent` is pure
 * and says what is true, the tracker says what is news.
 */
export function firePreSendRuleEvent(
  tracker: PreSendRuleEventTracker,
  input: PreSendRuleEventInput,
): PreSendEventFinding[] {
  const findings = evaluatePreSendEvent(input.rules, input.event, input.context);
  return tracker.fired(input.agentId, input.event, findings);
}

/**
 * The measurements a daemon-side seam can take, from what the manager already
 * holds.
 *
 * Thinner than the composer's context, and honestly so. `message` is empty
 * because the text was sent a turn ago and the events table does not offer that
 * trigger here. `idleSeconds` is measured from the turn that just ended, which
 * at a failure is approximately zero — a rule triggering on idle time at
 * `turn.failed` is asking the wrong question, and gets a truthful answer rather
 * than a fabricated one.
 */
export function buildAgentRuleContext(input: {
  contextWindowUsedTokens: number | null | undefined;
  contextWindowMaxTokens: number | null | undefined;
  totalCostUsd: number | null | undefined;
  idleSeconds: number | null;
  /** Since a person last typed here, which is not the same as since anything moved. */
  secondsSinceUserMessage?: number | null;
  /** Cleared by the provider on the next good turn, so a rule on it re-arms itself. */
  lastError?: string | null;
  provider?: string | null;
  model?: string | null;
}): PreSendMeasurementContext {
  const used = input.contextWindowUsedTokens ?? null;
  const max = input.contextWindowMaxTokens ?? null;
  // No `message` key at all, rather than an empty one. Nobody typed anything at
  // a daemon seam, and the events table does not offer that trigger here — an
  // empty string would be a measured value of "", which is a different claim.
  return {
    "agent.idleSeconds": input.idleSeconds,
    "agent.secondsSinceUserMessage": input.secondsSinceUserMessage ?? null,
    "agent.contextUsedPercent":
      used === null || max === null || max <= 0 ? null : (used / max) * 100,
    "agent.contextRemainingTokens": used === null || max === null ? null : Math.max(0, max - used),
    "agent.sessionCostUsd": input.totalCostUsd ?? null,
    // Absent rather than null when there is nothing to say, so a rule reading one
    // is skipped rather than compared against an empty string.
    ...(input.lastError ? { "agent.lastError": input.lastError } : {}),
    ...(input.provider ? { "agent.provider": input.provider } : {}),
    ...(input.model ? { "agent.model": input.model } : {}),
  };
}
