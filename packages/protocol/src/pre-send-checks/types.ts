import { z } from "zod";

/**
 * Rules the composer evaluates against the current agent before a message leaves
 * the input box. Each is a measurement compared to a threshold, yielding a
 * disposition: `warn` toasts and sends anyway, `block` toasts and holds the send
 * so the typed text survives.
 *
 * Rules are stored one per file under `<PASEO_HOME>/pre-send-checks/`, read from
 * disk on every access. This module owns only what a rule *is*; `./evaluate.js`
 * owns what one means, and neither knows where they came from.
 */

// `measurement`, `operator` and `disposition` are plain strings rather than enums on
// purpose. Narrowing them here would make an older client drop a whole rule it merely
// failed to recognise, and once a settings UI round-trips them that drop becomes
// permanent. The evaluator narrows instead, skipping rules it cannot read — so a
// hand-typed operator costs one rule rather than the whole list.
export const PreSendCheckRuleSchema = z
  .object({
    id: z.string(),
    measurement: z.string(),
    operator: z.string(),
    threshold: z.number(),
    disposition: z.string(),
    message: z.string().optional(),
    /**
     * Where the rule sits in a list, and nothing more.
     *
     * Evaluation is unaffected: every rule is evaluated and the most severe
     * outcome wins, so this is not precedence and a rule cannot be shadowed by
     * one above it. It exists because a list you cannot arrange is a list you
     * stop reading, and the rest of Paseo lets you arrange things.
     *
     * Optional, so a rule written before this existed still loads; those sort
     * after everything ordered, by id, which is stable rather than arbitrary.
     */
    order: z.number().optional(),
    /**
     * Off without being gone.
     *
     * Absent means on, so every rule written before this existed keeps working
     * and a hand-written rule needs no boilerplate to be live. Only an explicit
     * `false` silences one — which is why the evaluator tests for that rather
     * than for falsiness.
     */
    enabled: z.boolean().optional(),
  })
  .passthrough();

export type PreSendCheckRule = z.infer<typeof PreSendCheckRuleSchema>;

/** Measurements a rule may name. Unknown values are skipped, not rejected. */
export const PRE_SEND_MEASUREMENTS = [
  "agent.idleSeconds",
  "agent.contextUsedPercent",
  "agent.sessionCostUsd",
] as const;

export type PreSendMeasurement = (typeof PRE_SEND_MEASUREMENTS)[number];

/**
 * Operators the evaluator understands, exported as data so an editor can offer
 * them. The wire still accepts any string and a rule naming something absent
 * from this list is skipped, not rejected — so an editor that only emits these
 * must still round-trip one it does not recognise. See the note on the rule
 * schema above.
 *
 * No `eq`: exact equality on a duration or a dollar amount never fires.
 */
export const PRE_SEND_OPERATORS = ["gt", "gte", "lt", "lte"] as const;

export type PreSendOperator = (typeof PRE_SEND_OPERATORS)[number];

/**
 * Dispositions a *rule* may carry, which is narrower than the outcome of an
 * evaluation: `allow` is what comes back when nothing tripped and is not
 * something a rule can ask for. A rule claiming it is skipped.
 */
export const PRE_SEND_RULE_DISPOSITIONS = ["warn", "block"] as const;

export type PreSendRuleDisposition = (typeof PRE_SEND_RULE_DISPOSITIONS)[number];

/**
 * The measured values, assembled by the caller at send time. `null` means the
 * value is unknown right now — no usage reported yet, no timeline loaded, no
 * agent — and any rule reading a `null` is skipped rather than guessed at.
 */
export interface PreSendMeasurementContext {
  /**
   * Seconds since the agent last did anything, measured from the end of its
   * last turn. That is when a provider-side prompt cache was written, which is
   * what makes it the right clock for a staleness rule.
   */
  idleSeconds: number | null;
  /** Context window consumed, 0-100. */
  contextUsedPercent: number | null;
  /** Cumulative cost of this agent's session, in USD. */
  sessionCostUsd: number | null;
}

export type PreSendDisposition = "allow" | "warn" | "block";

export interface PreSendFinding {
  ruleId: string;
  measurement: string;
  disposition: "warn" | "block";
  /** The measured value that tripped the rule. */
  value: number;
  threshold: number;
  /** The rule's own message, raw and uninterpolated. `null` falls back to a translated default. */
  message: string | null;
}

export interface PreSendEvaluation {
  /** The most severe finding's disposition; `allow` when nothing tripped. */
  disposition: PreSendDisposition;
  /** Every rule that tripped, in rule order. */
  findings: readonly PreSendFinding[];
}
