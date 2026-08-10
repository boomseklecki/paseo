import type {
  PreSendFinding,
  PreSendMeasurementContext,
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

  return {
    idleSeconds,
    contextUsedPercent,
    sessionCostUsd: input.totalCostUsd,
    message: input.message ?? "",
  };
}

const MESSAGE_KEY_BY_MEASUREMENT: Record<string, string> = {
  "agent.idleSeconds": "composer.preSendChecks.idleSeconds",
  "agent.contextUsedPercent": "composer.preSendChecks.contextUsedPercent",
  "agent.sessionCostUsd": "composer.preSendChecks.sessionCostUsd",
};

/**
 * Exported so the settings list describes a threshold in the same units the toast
 * reports the measured value in. Two formatters would drift, and the first anyone
 * would notice is a rule that reads "3600" in the editor and "1 hour" when it fires.
 */
export function formatMeasurementValue(
  measurement: string,
  value: number | string | undefined,
): string {
  // A text rule's value is the message itself and a trigger carries no
  // threshold, so anything that is not a number is shown as itself rather than
  // run through a unit formatter that would print it as a duration.
  if (typeof value !== "number") {
    return value ?? "";
  }
  switch (measurement) {
    case "agent.idleSeconds":
      return formatDuration(value * 1000);
    case "agent.contextUsedPercent":
      return `${Math.round(value)}%`;
    case "agent.sessionCostUsd":
      return `$${value.toFixed(2)}`;
    default:
      return String(value);
  }
}

/**
 * The sentence shown in the toast.
 *
 * A rule's own `message` wins outright, interpolated but never appended to, so
 * whoever wrote it gets the wording they asked for. Only the shipped rules —
 * which carry no message — fall through to a translated default.
 */
export function formatPreSendFinding(finding: PreSendFinding, t: PreSendTranslate): string {
  const values = {
    value: formatMeasurementValue(finding.measurement, finding.value),
    threshold: formatMeasurementValue(finding.measurement, finding.threshold),
    // Only a numeric finding has a duration to render; a text trigger's value is
    // the message, and there is nothing to convert.
    duration: typeof finding.value === "number" ? formatDuration(finding.value * 1000) : "",
  };

  const sentence = finding.message
    ? t(finding.message, { ...values, defaultValue: finding.message })
    : t(
        MESSAGE_KEY_BY_MEASUREMENT[finding.measurement] ?? "composer.preSendChecks.generic",
        values,
      );

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
