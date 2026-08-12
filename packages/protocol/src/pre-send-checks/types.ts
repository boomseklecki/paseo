import { z } from "zod";

/**
 * Rules evaluated at a seam, most of them before a message leaves the input box.
 * Each names an `event`, compares a `trigger` against a `value` with an
 * `operator`, and asks for one or more `outcomes`: `warn` toasts and sends
 * anyway, `block` toasts and holds the send so the typed text survives, and any
 * other kind names something the daemon runs with the message instead.
 *
 * Rules are stored one per file under `<PASEO_HOME>/pre-send-checks/`, read from
 * disk on every access. This module owns only what a rule *is*; `./evaluate.js`
 * owns what one means, and neither knows where they came from.
 */

/**
 * One thing a rule asks for.
 *
 * Passthrough, so an outcome's parameters ride alongside its kind, and a kind
 * this build has never heard of is read rather than dropped and then skipped by
 * the evaluator. Declared once and used for all three of the fields that carry
 * an outcome, which is what stops the new list and the two compat singulars
 * drifting apart field by field.
 */
const PreSendOutcomeSchema = z
  .object({
    kind: z.string(),
    /**
     * What a person is told: the toast a `warn` or `block` raises, the body of a
     * `notify`. Absent falls back to a translated sentence built from the
     * trigger.
     *
     * On the outcome rather than on the rule, and that is the point. It lived on
     * the rule and was therefore shared by outcomes that do not all use it — a
     * rule whose only outcome was an `aside` still offered a Message box that
     * nothing read, because the composer redirects before it renders one. A
     * field only exists where something consumes it.
     */
    wording: z.string().optional(),
    /**
     * What a runner is told. `{{message}}` is what someone typed and is only
     * filled at `message.send`; `{{value}}` is the measured value and is filled
     * everywhere.
     */
    prompt: z.string().optional(),
    /** What the resulting subagent is called in the panel. */
    title: z.string().optional(),
  })
  .passthrough();

// `event`, `trigger`, `operator` and `outcome.kind` are plain strings rather than enums
// on purpose. Narrowing them here would make an older client drop a whole rule it merely
// failed to recognise, and once a settings UI round-trips them that drop becomes
// permanent. The evaluator narrows instead, skipping rules it cannot read — so a
// hand-typed operator costs one rule rather than the whole list.
//
// Half these fields have an older name kept beside them; `./vocabulary.js` owns that
// migration and is the only place either name should be read or written.
export const PreSendCheckRuleSchema = z
  .object({
    id: z.string(),
    /**
     * Which seam the rule is evaluated at.
     *
     * Absent means `message.send`, which is the only seam that existed when
     * rules did, so every rule written before this field keeps its meaning
     * without carrying it. New here rather than renamed from anything, so there
     * is no old counterpart to project onto.
     */
    event: z.string().optional(),
    /**
     * COMPAT(preSendCheckVocabulary): added in v0.3.2, remove after 2027-02-10
     * once daemon floor >= v0.3.2. `measurement` is the old name for `trigger`
     * and stays required, written as a projection of it. Readers prefer
     * `trigger` — see `normalizePreSendCheckRule`.
     */
    measurement: z.string(),
    /** What is looked at: `message`, `agent.idleSeconds`, and so on. */
    trigger: z.string().optional(),
    operator: z.string(),
    /**
     * What the trigger is compared against.
     *
     * One field where there were two, because a rule is never both: a text
     * trigger compares against a string and a numeric one against a number, so
     * the type says which and nothing has to look the trigger up to find out.
     */
    value: z.union([z.string(), z.number()]).optional(),
    /**
     * The number a numeric measurement is compared against.
     *
     * Optional only because a string trigger has nothing numeric to compare —
     * it carries `text` instead. A daemon old enough to require this skips such
     * a rule rather than rejecting the list, which is exactly what the store's
     * skip-the-bad-record behaviour was built for, and is the right outcome: a
     * trigger a daemon cannot act on should not fire on it.
     */
    threshold: z.number().optional(),
    /** What a string operator compares against. See `threshold`. */
    text: z.string().optional(),
    /**
     * COMPAT(preSendCheckVocabulary): added in v0.3.2, remove after 2027-02-10
     * once daemon floor >= v0.3.2. `disposition` is the old name for the kind of
     * the most severe outcome and stays required, written as a projection of it.
     * A rule whose outcome is one the daemon runs projects to `"redirect"` here,
     * which is what the old field called that case.
     */
    disposition: z.string(),
    /**
     * What happens instead of, or alongside, sending.
     *
     * A list because the things a rule asks for do not compete: warning about a
     * stale context and asking the question on the side are two answers to one
     * condition, and making them two rules means writing the condition twice and
     * keeping the copies in step by hand. Where they *do* compete — a `block`
     * and an `aside` both wanting the message — the evaluator settles it the
     * same way it settles two rules tripping at once, by severity and then by
     * the arrangement someone chose. So there is no new invariant here: nothing
     * about a list of outcomes is a state the single field could not already
     * reach with two rules.
     *
     * Optional so a rule predating it still loads, in which case the singular
     * `outcome` below carries the answer.
     */
    outcomes: z.array(PreSendOutcomeSchema).optional(),
    /**
     * COMPAT(preSendCheckOutcomeList): added in v0.3.2, remove after 2027-02-10
     * once daemon floor >= v0.3.2. The single-outcome field `outcomes`
     * superseded, written as a projection of the most severe entry — which is
     * what a reader that can only carry out one of them should carry out.
     */
    outcome: PreSendOutcomeSchema.optional(),
    message: z.string().optional(),
    /**
     * COMPAT(preSendCheckVocabulary): added in v0.3.2, remove after 2027-02-10
     * once daemon floor >= v0.3.2. The old name for `outcome` when the outcome
     * is an action, written as a projection of it. Stays optional, because it
     * always was and a `warn` never had one.
     */
    action: PreSendOutcomeSchema.optional(),
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

/**
 * Triggers a rule may name. Unknown values are skipped, not rejected.
 *
 * `message` is the odd one and deliberately so: it reads the text being sent
 * rather than anything about the agent, which is what lets a rule fire on what
 * you typed instead of on how long you left the session alone. It is a string,
 * so only the string operators apply to it. It is also why the field is not
 * called `measurement` any more - a message prefix measures nothing.
 */
export const PRE_SEND_TRIGGERS = [
  "agent.idleSeconds",
  "agent.secondsSinceUserMessage",
  "agent.contextUsedPercent",
  "agent.contextRemainingTokens",
  "agent.sessionCostUsd",
  "agent.lastError",
  "agent.provider",
  "agent.model",
  "message",
  "always",
] as const;

export type PreSendTrigger = (typeof PRE_SEND_TRIGGERS)[number];

/**
 * The trigger with no comparison in it.
 *
 * A rule needs a trigger, an operator and a value, which is the right shape for
 * "when the context is over 80%" and the wrong one for "when a turn fails" -
 * where the event *is* the condition and there is nothing to compare. `always`
 * is how that is said: its operator and value are ignored. Without it, a rule
 * that just wants to fire on an event has to invent a comparison that is always
 * true, and every reader then has to work out that that is what it meant.
 */
export const PRE_SEND_ALWAYS_TRIGGER = "always";

/**
 * What each trigger measures, and therefore how it is compared and rendered.
 *
 * Keyed by the trigger union rather than by `string`, so adding a trigger to
 * `PRE_SEND_TRIGGERS` without an entry here is a type error rather than a rule
 * that silently never fires. That is the guarantee `COMPARATORS` has given the
 * operators from the start, and the triggers went without it: `PreSendTrigger`
 * was declared and referenced nowhere, so a new one would have compiled clean,
 * been offered by the editor, saved into a rule, and then fallen through three
 * separate defaults — the evaluator's switch, the unit formatter, and the app's
 * wording table.
 *
 * One table rather than three lists, for the reason `docs/coding-standards.md`
 * gives: the same discriminator branched in three files is a policy table.
 */
export type PreSendTriggerUnit = "seconds" | "percent" | "usd" | "tokens" | "text" | "none";

export const PRE_SEND_TRIGGER_UNITS: Record<PreSendTrigger, PreSendTriggerUnit> = {
  "agent.idleSeconds": "seconds",
  /**
   * Since a person last typed here, rather than since anything moved.
   *
   * `idleSeconds` is measured from different clocks on the two sides — the
   * newest timeline item in the composer, `updatedAt` in the daemon, which is
   * bumped on every state change — so the same rule means slightly different
   * things depending on the seam. This one reads `lastUserMessageAt`, which is
   * the same field on both, and is the better question for "has this been left
   * alone" anyway: an agent working hard on its own is not idle, but nobody has
   * been near it.
   */
  "agent.secondsSinceUserMessage": "seconds",
  "agent.contextUsedPercent": "percent",
  /**
   * Headroom rather than proportion.
   *
   * 10% of a 1M window and 10% of a 200k one are five times apart, and what
   * anyone actually reasons about is "how much room is left before this
   * compacts". `lt 20000` says that; `gt 90` says it only if you know which
   * model you are on.
   */
  "agent.contextRemainingTokens": "tokens",
  "agent.sessionCostUsd": "usd",
  /**
   * The provider's own words for why the last turn failed.
   *
   * The one trigger that makes `turn.failed` more than a single undifferentiated
   * seam: `contains "rate limit"` and `contains "context"` want opposite
   * responses — wait and retry, versus compact and carry on. Cleared on the next
   * successful turn, so a rule on it re-arms by itself.
   */
  "agent.lastError": "text",
  /**
   * Which agent this is, for scoping every other rule.
   *
   * Not decoration: token and context reporting differ by provider, and the
   * ACP-based ones report no context window at all, so a `contextUsedPercent`
   * rule silently never fires there and nothing says why. Being able to write
   * `agent.provider contains codex` is the cheapest fix for that.
   */
  "agent.provider": "text",
  "agent.model": "text",
  message: "text",
  // The trigger with no comparison in it, so there is nothing to render.
  always: "none",
};

/**
 * The same table, widened, for lookups whose key came off disk.
 *
 * Declare typed, consume widened — the idiom this file already uses twice for
 * operators. The type checks whoever adds a trigger; the `| undefined` handles a
 * rule file naming one this build has never heard of.
 */
export const PRE_SEND_TRIGGER_UNITS_BY_NAME = PRE_SEND_TRIGGER_UNITS as Record<
  string,
  PreSendTriggerUnit | undefined
>;

/**
 * The triggers compared as text rather than as numbers.
 *
 * Derived from the unit table rather than written out again. A second list is a
 * second thing to forget: `d5dd876d` records `schedule` missing from one of four
 * parallel outcome lists, refused by the evaluator at every seam while the
 * registry, the descriptor and a shipped example all said it worked.
 */
export const PRE_SEND_TEXT_TRIGGERS = PRE_SEND_TRIGGERS.filter(
  (trigger) => PRE_SEND_TRIGGER_UNITS[trigger] === "text",
);

export function isTextTrigger(trigger: string): boolean {
  return PRE_SEND_TRIGGER_UNITS_BY_NAME[trigger] === "text";
}

/**
 * Whether a trigger is compared with the numeric operators.
 *
 * Stated as "not text and not nothing" rather than by listing the numeric units,
 * so adding a unit makes its triggers numeric without a second edit. Listing
 * them is how `tokens` arrived numeric-in-name and refused by the evaluator,
 * which a test caught and a type would not have.
 */
export function isNumericTrigger(trigger: string): boolean {
  const unit = PRE_SEND_TRIGGER_UNITS_BY_NAME[trigger];
  return unit !== undefined && unit !== "text" && unit !== "none";
}

/**
 * Operators the evaluator understands, exported as data so an editor can offer
 * them. The wire still accepts any string and a rule naming something absent
 * from this list is skipped, not rejected — so an editor that only emits these
 * must still round-trip one it does not recognise. See the note on the rule
 * schema above.
 *
 * No `eq`: exact equality on a duration or a dollar amount never fires.
 */
export const PRE_SEND_NUMERIC_OPERATORS = ["gt", "gte", "lt", "lte"] as const;

/**
 * Operators over text. `startsWith` is the one that makes `/btw` work, and it is
 * anchored rather than a `contains` so a message merely mentioning the word does
 * not get redirected.
 */
export const PRE_SEND_TEXT_OPERATORS = ["startsWith", "contains"] as const;

export const PRE_SEND_OPERATORS = [
  ...PRE_SEND_NUMERIC_OPERATORS,
  ...PRE_SEND_TEXT_OPERATORS,
] as const;

export type PreSendNumericOperator = (typeof PRE_SEND_NUMERIC_OPERATORS)[number];
export type PreSendTextOperator = (typeof PRE_SEND_TEXT_OPERATORS)[number];
export type PreSendOperator = (typeof PRE_SEND_OPERATORS)[number];

/**
 * Outcome kinds the daemon runs, as opposed to the plain ones the app and
 * daemon carry out themselves. Unknown kinds are declined, not run.
 */
export const PRE_SEND_RUNNABLE_OUTCOME_KINDS = ["aside", "fork", "start", "schedule"] as const;

export type PreSendRunnableOutcomeKind = (typeof PRE_SEND_RUNNABLE_OUTCOME_KINDS)[number];

export type PreSendOutcome = z.infer<typeof PreSendOutcomeSchema>;

/** One outcome as a runner is asked to carry it out. Structurally a `PreSendOutcome`. */
export type PreSendOutcomeSpec = PreSendOutcome;

export function isPreSendRunnableOutcomeKind(kind: string): boolean {
  return (PRE_SEND_RUNNABLE_OUTCOME_KINDS as readonly string[]).includes(kind);
}

/**
 * Outcome kinds the daemon and app carry out themselves, as opposed to the
 * runnable ones, which are a registry an editor is told about.
 *
 * `warn` and `block` only mean something where there is a send to comment on or
 * hold; `notify` only means something where there is not, since a person looking
 * at the composer does not need their phone buzzed. Which of them an event
 * accepts is `./events.js`, not this list. `allow` is absent on purpose: it is
 * what comes back when nothing tripped, not something a rule can ask for.
 */
export const PRE_SEND_PLAIN_OUTCOME_KINDS = ["warn", "block", "notify"] as const;

export type PreSendPlainOutcomeKind = (typeof PRE_SEND_PLAIN_OUTCOME_KINDS)[number];

/** What an editor offers: the plain outcomes plus every runnable one this build has. */
export const PRE_SEND_OUTCOME_KINDS = [
  ...PRE_SEND_PLAIN_OUTCOME_KINDS,
  ...PRE_SEND_RUNNABLE_OUTCOME_KINDS,
] as const;

export function isPlainOutcomeKind(kind: string): boolean {
  return (PRE_SEND_PLAIN_OUTCOME_KINDS as readonly string[]).includes(kind);
}

/**
 * The tokens a text field may interpolate, and where each is filled.
 *
 * Declared rather than documented in prose, so an editor can list exactly what
 * is live at the seam being edited instead of naming a token that quietly
 * renders as nothing. `{{message}}` is the one with a condition on it: it is
 * what a person typed, and nobody types anything at a daemon seam.
 */
export const PRE_SEND_VALUE_TOKEN = "{{value}}";
export const PRE_SEND_THRESHOLD_TOKEN = "{{threshold}}";
export const PRE_SEND_DURATION_TOKEN = "{{duration}}";
export const PRE_SEND_MESSAGE_TOKEN = "{{message}}";

/**
 * What a **prompt** may use: text handed to an agent.
 *
 * `{{message}}` is what a person typed, so it exists only where a person typed
 * something. A prompt does not interpolate `{{threshold}}` or `{{duration}}` —
 * those are rendered by the wording path, and listing them here would name two
 * more tokens that quietly resolve to nothing.
 */
export function preSendTokensForPrompt(event: string): readonly string[] {
  return event === "message.send"
    ? [PRE_SEND_MESSAGE_TOKEN, PRE_SEND_VALUE_TOKEN]
    : [PRE_SEND_VALUE_TOKEN];
}

/**
 * What a **wording** may use: the sentence a person is shown.
 *
 * Never `{{message}}`, at any seam. A wording says what happened, and what was
 * typed is not that — the composer interpolates value, threshold and duration
 * into it and nothing else, so offering the fourth would be inviting someone to
 * write a sentence with a hole in it.
 *
 * `{{duration}}` only where the value is a duration. On a cost rule it renders
 * empty, and a token that resolves to nothing should not be advertised.
 */
export function preSendTokensForWording(trigger: string): readonly string[] {
  const tokens = [PRE_SEND_VALUE_TOKEN, PRE_SEND_THRESHOLD_TOKEN];
  return trigger === "agent.idleSeconds" ? [...tokens, PRE_SEND_DURATION_TOKEN] : tokens;
}

/** What one outcome says, or `undefined` to fall back to a translated default. */
export function preSendOutcomeWording(outcome: PreSendOutcome): string | undefined {
  const wording = outcome.wording;
  return typeof wording === "string" && wording.trim() ? wording : undefined;
}

/**
 * How much of a rule one outcome speaks for, when only one of them fits.
 *
 * Needed in exactly two places, and both are places where a list has to become
 * a single answer: the compat projection, which writes one `disposition` for a
 * reader that predates the list, and the composer, which has one message and
 * has to decide where it goes. Everywhere else runs every outcome and never
 * asks.
 *
 * An unrecognised kind ranks below every known one rather than above. It is the
 * direction that matters: a rule saying `warn` alongside something this build
 * has never heard of should warn, not fall silent because the unknown half won
 * a comparison it could not act on afterwards.
 */
export function preSendOutcomeSeverity(kind: string): number {
  if (kind === "warn") {
    return 1;
  }
  if (kind === "block") {
    return 2;
  }
  // `notify` sits here with the runnable kinds rather than below `block`. The
  // two never meet — the events table gives `notify` to the daemon seams and
  // `block` to the composer — so the rank between them is unobservable, and
  // grouping them is what lets the old `disposition` projection stay a single
  // "is this something to carry out" question.
  return isPreSendRunnableOutcomeKind(kind) || kind === "notify" ? 3 : 0;
}

/**
 * The outcome that speaks for the rule when only one can.
 *
 * Throws on an empty list rather than inventing a default: the editor refuses to
 * save a rule with no outcome and the normaliser always produces at least one,
 * so an empty list here is a programming error, and a quiet `warn` standing in
 * for it would be a rule that fires and says nothing anyone asked for.
 */
export function mostSeverePreSendOutcome(outcomes: readonly PreSendOutcome[]): PreSendOutcome {
  const [first] = outcomes;
  if (!first) {
    throw new Error("A pre-send check rule needs at least one outcome");
  }
  return outcomes.reduce(
    (worst, candidate) =>
      preSendOutcomeSeverity(candidate.kind) > preSendOutcomeSeverity(worst.kind)
        ? candidate
        : worst,
    first,
  );
}

/**
 * The measured values, assembled by the caller at the moment a rule is asked.
 *
 * Keyed by trigger rather than a field per trigger, because the two sides can
 * measure different things: the composer reads what the session store holds, the
 * daemon reads the agent record, and neither can supply the other's. A field per
 * trigger would make each of them write an explicit `null` for everything it
 * cannot see, which is noise that grows with every trigger added.
 *
 * A missing key and a `null` mean the same thing to the evaluator — not measured,
 * skip the rule — and that is deliberate. There is no useful difference between
 * "this build does not know that trigger" and "nobody could measure it", because
 * both must fail open: a gate that blocks because it could not read itself is
 * worse than one that occasionally misses.
 *
 * `Partial<Record<...>>` rather than an open string map is the repo's idiom for
 * "typed key, deliberately incomplete" — `RULE_EVENT_BY_ATTENTION_REASON` is the
 * same shape. Typed keys are what keep a mistyped override in a test a compile
 * error rather than a silently ignored entry.
 *
 * Never serialised: each side builds its own and hands it to a pure function in
 * the same process, so this shape is not a wire concern and owes no COMPAT tag.
 */
export type PreSendMeasurementContext = Partial<Record<PreSendTrigger, number | string | null>>;

export type PreSendDisposition = "allow" | "warn" | "block" | "redirect";

/**
 * What one tripped rule reports.
 *
 * In the current vocabulary throughout and with no compat half, because a
 * finding is never serialised: the evaluator hands it straight to the composer
 * in the same process. `disposition` survives here as the *severity* of an
 * outcome rather than as a rule field - three ranks the composer switches on,
 * where the outcome kind itself is open-ended.
 */
export interface PreSendFinding {
  ruleId: string;
  trigger: string;
  disposition: "warn" | "block" | "redirect";
  /** The measured value that tripped the rule: a number, or the text for a text rule. */
  value: number | string;
  /** What it was compared against, in the same shape as `value`. */
  operand: number | string;
  /** The rule's own message, raw and uninterpolated. `null` falls back to a translated default. */
  message: string | null;
  /**
   * Everything this rule asked for that this build can carry out, in the order
   * the rule listed them.
   *
   * Every outcome, not only the ones needing a runner: a finding is a faithful
   * record of what tripped, and the composer already has to know that a rule
   * said `warn` as well as `aside` to decide what to put in the toast. Outcome
   * kinds this build cannot perform are dropped here rather than reported and
   * declined later — see `readOutcomeDisposition`.
   */
  outcomes: readonly PreSendOutcome[];
}

export interface PreSendEvaluation {
  /** The most severe finding's disposition; `allow` when nothing tripped. */
  disposition: PreSendDisposition;
  /** Every rule that tripped, in rule order. */
  findings: readonly PreSendFinding[];
}

/**
 * A parameter an outcome takes, in the shape the app already renders.
 *
 * Deliberately the same vocabulary as `AgentFeature`, which providers use to
 * describe their own controls and which the composer already draws by switching
 * on `type`. Inventing a second form language when the app can draw this one
 * would be a choice to justify rather than a default.
 *
 * Labels come from the daemon, so they arrive in one language. That is already
 * true of provider feature labels; it is new for the settings screen, and it is
 * the price of an editor that needs no change to offer an outcome it has never
 * heard of.
 */
export const PreSendOutcomeParameterSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
    placeholder: z.string().optional(),
    multiline: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("toggle"),
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }),
]);

export type PreSendOutcomeParameter = z.infer<typeof PreSendOutcomeParameterSchema>;

/** What one outcome is and what it takes, as the daemon describes itself. */
export const PreSendOutcomeDescriptorSchema = z.object({
  kind: z.string(),
  label: z.string(),
  description: z.string().optional(),
  parameters: z.array(PreSendOutcomeParameterSchema),
});

export type PreSendOutcomeDescriptor = z.infer<typeof PreSendOutcomeDescriptorSchema>;

/**
 * A rule someone might want, offered rather than installed.
 *
 * Nothing evaluates these. They exist because the interesting rules are the ones
 * nobody would think to write — `/btw` in particular, which is a redirect to an
 * outcome, and which was very nearly shipped as a default before it became clear
 * that a rule silently intercepting what you type is not something to switch on
 * for people who did not ask.
 *
 * `rule` carries no `id` because an example is a template: the app mints one on
 * install, which is what lets the same example be added twice, and what keeps
 * one id per rule across the hosts it is assigned to.
 *
 * Standalone rather than hanging off an outcome descriptor, because most of what
 * is worth showing needs no runner at all — a warning at 80% context is a rule
 * with nothing to redirect to. The daemon drops any example naming an outcome it
 * cannot
 * perform, so being standalone costs nothing in capability terms.
 */
export const PreSendCheckExampleSchema = z.object({
  /**
   * Stable, and the app's i18n key. An example the app has no translation for
   * falls back to `label`, so a newer daemon's example still appears rather than
   * being hidden by the older app that could not name it.
   */
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  /**
   * The rule, in the current vocabulary only.
   *
   * No compat half here, unlike a stored rule: examples and the rename shipped
   * together, so no client has ever read one written the old way and none ever
   * will. The app projects both vocabularies when it saves the rule this
   * becomes.
   */
  rule: z
    .object({
      event: z.string().optional(),
      trigger: z.string(),
      operator: z.string(),
      value: z.union([z.string(), z.number()]).optional(),
      outcomes: z.array(PreSendOutcomeSchema).min(1),
      message: z.string().optional(),
    })
    .passthrough(),
});

export type PreSendCheckExample = z.infer<typeof PreSendCheckExampleSchema>;
