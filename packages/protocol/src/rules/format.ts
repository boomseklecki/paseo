import { RULE_TRIGGER_UNITS_BY_NAME } from "./types.js";
import type { RuleTriggerUnit } from "./types.js";

/**
 * How a measured value reads.
 *
 * Here rather than in the app because both sides render it now. The composer
 * puts it in a toast, the settings list describes a threshold with it, and — now
 * that `{{value}}` is a token a prompt can interpolate — the daemon substitutes
 * it into text an agent receives. Three copies of "3600 means one hour" would
 * drift, and the first anyone would notice is a rule reading `3600` in the
 * editor and `1h` when it fires.
 *
 * Deliberately locale-free. The daemon has no locale to format in, and a token
 * substituted into a prompt is read by a model rather than by a person, so a
 * stable rendering matters more than a localised one.
 */

/** `90s` / `2m 30s` / `3h` — the same shape the app's own duration helper produces. */
export function formatRuleDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  const totalSeconds = durationMs / 1000;

  if (totalSeconds < 60) {
    return `${Math.floor(totalSeconds)}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

/**
 * One measured value, in the units its trigger is about.
 *
 * Anything that is not a number is shown as itself: a text rule's value is the
 * message, and `always` carries no operand at all, so running either through a
 * unit formatter would print a message as a duration.
 */
export function formatRuleTriggerValue(
  trigger: string,
  value: number | string | undefined,
): string {
  if (typeof value !== "number") {
    return value ?? "";
  }
  const unit = RULE_TRIGGER_UNITS_BY_NAME[trigger];
  // Widened at the lookup because the trigger came off disk; keyed by the unit
  // union in the table itself, so adding a unit without a renderer is a type
  // error. A `switch` with a `default` here would have taken the new `tokens`
  // unit and printed it as a bare number — the same silent half-working the
  // trigger table exists to prevent, one level down.
  return unit === undefined ? String(value) : RENDER_BY_UNIT[unit](value);
}

const RENDER_BY_UNIT: Record<RuleTriggerUnit, (value: number) => string> = {
  seconds: (value) => formatRuleDuration(value * 1000),
  percent: (value) => `${Math.round(value)}%`,
  usd: (value) => `$${value.toFixed(2)}`,
  // Thousands, because a context window is read in them and "18k left" is the
  // shape of the thought. Below a thousand the exact number is what matters.
  tokens: (value) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value))),
  // A text trigger's value is the text, and `always` has none; either way there
  // is no unit to apply, and a number reaching here is shown as itself.
  text: (value) => String(value),
  none: (value) => String(value),
};

/**
 * Fills the tokens a wording may carry.
 *
 * The composer gets this for free — it runs a rule's wording through i18next,
 * which interpolates as it translates. The daemon has no translator: it hands
 * the sentence to a push notification as-is, so `{{value}}` reached a phone
 * looking exactly like `{{value}}`. This is that missing half, and it is here
 * rather than in the server so the two sides substitute the same names.
 *
 * `{{duration}}` renders only for a numeric trigger. A text rule's value is the
 * message itself, and printing it as a formatted zero would be worse than
 * leaving the token empty.
 */
export function renderRuleWording(
  text: string,
  input: { trigger: string; value: number | string; operand: number | string },
): string {
  return text
    .replaceAll("{{value}}", formatRuleTriggerValue(input.trigger, input.value))
    .replaceAll("{{threshold}}", formatRuleTriggerValue(input.trigger, input.operand))
    .replaceAll(
      "{{duration}}",
      typeof input.value === "number" ? formatRuleDuration(input.value * 1000) : "",
    );
}
