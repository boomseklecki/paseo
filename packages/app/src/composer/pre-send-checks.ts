import type {
  PreSendFinding,
  PreSendMeasurementContext,
  PreSendTrigger,
} from "@getpaseo/protocol/pre-send-checks/types";

import type { StreamItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";

/**
 * Turns what the composer already holds into the numbers the protocol evaluator
 * compares. Everything impure lives here — the store read, the clock, the
 * translator — so `@getpaseo/protocol/pre-send-checks` stays a pure function and
 * this stays testable without a store or a rendered tree.
 */

export type PreSendTranslate = (key: string, options?: Record<string, unknown>) => string;

/**
 * When the agent last did anything, taken from the newest timeline item.
 *
 * The timeline is stored as two segments rendered `[...tail, ...head]`, so the
 * newest item is the last of `head`, or the last of `tail` while `head` is
 * empty. This is the same timestamp the assistant message footer renders, which
 * is the property worth having: the number a rule fires on can be checked by
 * hovering the last message.
 *
 * `lastUserMessageAt` is the fallback for a timeline that has not loaded yet.
 * It is durable across a daemon restart, where the timeline is not.
 */
export function resolveLastTurnEndAt(input: {
  head: readonly StreamItem[];
  tail: readonly StreamItem[];
  lastUserMessageAt: Date | null;
}): Date | null {
  return input.head.at(-1)?.timestamp ?? input.tail.at(-1)?.timestamp ?? input.lastUserMessageAt;
}

export interface PreSendMeasurementInput {
  head: readonly StreamItem[];
  tail: readonly StreamItem[];
  lastUserMessageAt: Date | null;
  contextWindowUsedTokens: number | null;
  contextWindowMaxTokens: number | null;
  totalCostUsd: number | null;
  /** Injected rather than read, so idle time is testable without faking a clock. */
  nowMs: number;
  /**
   * The text about to be sent, for rules that trigger on what was typed.
   *
   * Optional and defaulted to empty, because most callers build this context to
   * describe the agent rather than to gate a particular send. Empty is inert
   * rather than merely harmless: the evaluator refuses a text rule with an empty
   * operand, so no trigger can match a caller that had no message to give.
   */
  message?: string;
  /**
   * What the provider said about the last failure, and which agent this is.
   *
   * Optional because a caller describing an agent it has not loaded fully has
   * nothing to say, and a missing key means "not measured" rather than "empty".
   */
  lastError?: string | null;
  provider?: string | null;
  model?: string | null;
}

export function buildPreSendMeasurementContext(
  input: PreSendMeasurementInput,
): PreSendMeasurementContext {
  const lastTurnEndAt = resolveLastTurnEndAt(input);
  const lastTurnEndMs = lastTurnEndAt?.getTime() ?? null;

  // The timestamp is the daemon's and `nowMs` is this client's, with no offset
  // anywhere in the protocol to reconcile them. A clock behind the daemon's
  // would otherwise produce negative idle, so clamp. Immaterial at an hour-long
  // threshold; it would not be at five minutes.
  const idleSeconds =
    lastTurnEndMs === null || !Number.isFinite(lastTurnEndMs)
      ? null
      : Math.max(0, (input.nowMs - lastTurnEndMs) / 1000);

  const { contextWindowUsedTokens, contextWindowMaxTokens } = input;
  const contextUsedPercent =
    contextWindowUsedTokens === null ||
    contextWindowMaxTokens === null ||
    contextWindowMaxTokens <= 0
      ? null
      : (contextWindowUsedTokens / contextWindowMaxTokens) * 100;

  // Keyed by trigger, and only what this side can measure. The composer has the
  // session store; the daemon has the agent record; neither writes a null for
  // the other's values, because a missing key already means "not measured".
  const { lastUserMessageAt } = input;
  const secondsSinceUserMessage =
    lastUserMessageAt === null
      ? null
      : Math.max(0, (input.nowMs - lastUserMessageAt.getTime()) / 1000);

  const contextRemainingTokens =
    contextWindowUsedTokens === null || contextWindowMaxTokens === null
      ? null
      : Math.max(0, contextWindowMaxTokens - contextWindowUsedTokens);

  return {
    "agent.idleSeconds": idleSeconds,
    "agent.secondsSinceUserMessage": secondsSinceUserMessage,
    "agent.contextUsedPercent": contextUsedPercent,
    "agent.contextRemainingTokens": contextRemainingTokens,
    "agent.sessionCostUsd": input.totalCostUsd,
    // Absent rather than null when the caller did not supply them, so a rule
    // reading one is skipped rather than compared against an empty string.
    ...(input.lastError ? { "agent.lastError": input.lastError } : {}),
    ...(input.provider ? { "agent.provider": input.provider } : {}),
    ...(input.model ? { "agent.model": input.model } : {}),
    message: input.message ?? "",
  };
}

/**
 * The translated sentence a trigger falls back to when a rule words nothing.
 *
 * Keyed by the trigger union, so a trigger added without a sentence here is a
 * type error rather than one that quietly reads the generic line. `message` and
 * `always` take the generic one on purpose: neither measures anything there is a
 * unit for, so there is nothing specific to say.
 */
const MESSAGE_KEY_BY_MEASUREMENT: Record<PreSendTrigger, string> = {
  message: "composer.preSendChecks.generic",
  always: "composer.preSendChecks.generic",
  // Scoping triggers, rarely a rule's whole reason, so the generic sentence is
  // the honest default rather than an invented one about a provider name.
  "agent.provider": "composer.preSendChecks.generic",
  "agent.model": "composer.preSendChecks.generic",
  "agent.lastError": "composer.preSendChecks.lastError",
  "agent.secondsSinceUserMessage": "composer.preSendChecks.secondsSinceUserMessage",
  "agent.contextRemainingTokens": "composer.preSendChecks.contextRemainingTokens",
  "agent.idleSeconds": "composer.preSendChecks.idleSeconds",
  "agent.contextUsedPercent": "composer.preSendChecks.contextUsedPercent",
  "agent.sessionCostUsd": "composer.preSendChecks.sessionCostUsd",
};

/**
 * The same table, widened, because a trigger read off a rule file is a `string`.
 *
 * Declare typed, consume widened — the idiom `COMPARATORS` uses in the evaluator.
 * The type checks whoever adds a trigger; the `| undefined` handles a rule naming
 * one this build has never heard of.
 */
const MESSAGE_KEY_BY_NAME = MESSAGE_KEY_BY_MEASUREMENT as Record<string, string | undefined>;

/**
 * Re-exported rather than implemented, because the daemon renders this too now:
 * `{{value}}` is a token a prompt can interpolate, so the same number reaches an
 * agent through the server. `@getpaseo/protocol` owns it so the editor, the
 * toast and the prompt cannot disagree about what 3600 means.
 */
import { formatPreSendTriggerValue } from "@getpaseo/protocol/pre-send-checks/format";

export { formatPreSendTriggerValue as formatTriggerValue };

/**
 * The sentence shown in the toast.
 *
 * A rule's own `message` wins outright, interpolated but never appended to, so
 * whoever wrote it gets the wording they asked for. Only the shipped rules —
 * which carry no message — fall through to a translated default.
 */
/**
 * The sentence a rule would say if nobody wrote one.
 *
 * Exported so the editor can *show* it rather than name it. "Leave empty for the
 * default wording" asked people to accept text they had no way of reading; this
 * is that text, rendered against the rule's own threshold because there is no
 * measured value at settings time and the threshold is the boundary at which the
 * sentence first appears.
 */
export function defaultPreSendWording(
  trigger: string,
  operand: number | string | undefined,
  t: PreSendTranslate,
): string {
  const rendered = formatPreSendTriggerValue(trigger, operand);
  return t(MESSAGE_KEY_BY_NAME[trigger] ?? "composer.preSendChecks.generic", {
    value: rendered,
    threshold: rendered,
    duration: typeof operand === "number" ? formatDuration(operand * 1000) : "",
  });
}

export function formatPreSendFinding(finding: PreSendFinding, t: PreSendTranslate): string {
  const values = {
    value: formatPreSendTriggerValue(finding.trigger, finding.value),
    threshold: formatPreSendTriggerValue(finding.trigger, finding.operand),
    // Only a numeric finding has a duration to render; a text trigger's value is
    // the message, and there is nothing to convert.
    duration: typeof finding.value === "number" ? formatDuration(finding.value * 1000) : "",
  };

  const sentence = finding.message
    ? t(finding.message, { ...values, defaultValue: finding.message })
    : t(MESSAGE_KEY_BY_NAME[finding.trigger] ?? "composer.preSendChecks.generic", values);

  if (finding.disposition !== "block") {
    return sentence;
  }
  return `${sentence} ${t("composer.preSendChecks.overrideHint")}`;
}

/** Every finding as one string, most severe first so a block leads. */
export function formatPreSendFindings(
  findings: readonly PreSendFinding[],
  t: PreSendTranslate,
): string {
  const blocking = findings.filter((finding) => finding.disposition === "block");
  const ordered = blocking.length > 0 ? blocking : findings;
  return ordered.map((finding) => formatPreSendFinding(finding, t)).join(" ");
}

/**
 * A block the user has already seen and chosen to send through.
 *
 * `agentId` is part of the identity because a tab can be retargeted at another
 * agent without the composer remounting, and an override earned against one
 * agent must not carry to another. Exact text matching means an edited message
 * is new intent and gets a fresh evaluation.
 */
export interface PreSendOverride {
  agentId: string;
  message: string;
  atMs: number;
}

export const PRE_SEND_OVERRIDE_WINDOW_MS = 60_000;

export function isPreSendOverrideValid(
  override: PreSendOverride | null,
  candidate: { agentId: string; message: string; nowMs: number },
): boolean {
  if (!override) {
    return false;
  }
  return (
    override.agentId === candidate.agentId &&
    override.message === candidate.message &&
    candidate.nowMs - override.atMs <= PRE_SEND_OVERRIDE_WINDOW_MS &&
    candidate.nowMs >= override.atMs
  );
}
