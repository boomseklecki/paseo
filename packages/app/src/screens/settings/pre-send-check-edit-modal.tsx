import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { Minus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
  isPlainOutcomeKind,
  isTextTrigger,
  preSendTokensForPrompt,
  preSendTokensForWording,
  type PreSendOutcomeDescriptor,
  type PreSendOutcomeParameter,
} from "@getpaseo/protocol/pre-send-checks/types";
import { settingsStyles } from "@/styles/settings";
import { dryRunPreSendCheckSample } from "@getpaseo/protocol/pre-send-checks/dry-run";
import {
  gatePreSendCheckSave,
  preSendCheckChoosesHosts,
  addPreSendOutcome,
  applyPreSendCheckDraft,
  withDefaultPreSendWording,
  PRE_SEND_WORDING_PARAM,
  applyPreSendEventChange,
  nextPreSendOutcomeKind,
  preSendOutcomeKindsForRow,
  preSendOutcomeOptions,
  preSendCheckOptions,
  preSendTriggerOptions,
  removePreSendOutcome,
  setPreSendOutcomeKind,
  setPreSendOutcomeParam,
  PRE_SEND_EVENT_OPTIONS,
  PRE_SEND_OPERATOR_OPTIONS,
  type PreSendCheckDraft,
  type PreSendCheckField,
  type PreSendCheckFieldErrors,
  type PreSendCheckOutcomeDraft,
} from "./pre-send-check-form";

export interface PreSendCheckModalHost {
  serverId: string;
  serverName: string;
  /** False for a host that is offline or too old to hold a rule at all. */
  isUsable: boolean;
}

interface PreSendCheckEditModalProps {
  visible: boolean;
  title: string;
  initialDraft: PreSendCheckDraft;
  /**
   * Every host the rule could live on. Empty or one entry hides the host field
   * entirely, so a single-daemon setup never sees a choice it does not have.
   */
  hosts: readonly PreSendCheckModalHost[];
  initialServerIds: readonly string[];
  /**
   * The outcomes this daemon can carry out, as it described them. Empty means a
   * daemon too old to say, in which case the picker offers only the plain kinds
   * — every version can warn, and guessing at the rest would invent a kind this
   * daemon would decline.
   */
  outcomeDescriptors: readonly PreSendOutcomeDescriptor[];
  onClose: () => void;
  onSave: (draft: PreSendCheckDraft, serverIds: readonly string[]) => Promise<void>;
  testID?: string;
}

const RemoveOutcomeIcon = withUnistyles(Minus);

/**
 * Which tokens a field may use here, spelled out rather than described.
 *
 * The old hint named `{{message}}` at every seam, including the ones where
 * nobody types anything and it renders as a hole. Listing what is live is the
 * difference between a field you can use and one you have to guess at.
 */
/**
 * Drops the sentence a daemon wrote about tokens, keeping the rest of its text.
 *
 * Its description is one or more sentences and only the token one is wrong here,
 * so replacing the whole thing would throw away "Sent to the new conversation as
 * its first message" along with it.
 */
function stripTokenSentence(description: string): string {
  return description
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !sentence.includes("{{"))
    .join(" ")
    .trim();
}

function tokenHelp(tokens: readonly string[], t: TFunction): string {
  const names: Record<string, string> = {
    "{{message}}": t("settings.preSendChecks.tokenMessage"),
    "{{value}}": t("settings.preSendChecks.tokenValue"),
    "{{threshold}}": t("settings.preSendChecks.tokenThreshold"),
    "{{duration}}": t("settings.preSendChecks.tokenDuration"),
  };
  const lines = tokens.map((token) => `${token} ${names[token] ?? ""}`.trim());
  return `${t("settings.preSendChecks.tokensLabel")} ${lines.join("   ")}`;
}

type PickerKind = "event" | "trigger" | "operator";

// Separates server ids inside the memo key below, chosen because it cannot
// occur in one. Written as an escape and not as the character itself: a raw
// NUL in the source makes the whole file binary to grep, to git diff and to
// anyone reviewing it, which is how this one went unnoticed.
const SERVER_ID_KEY_SEPARATOR = "\u0000";

const OPTION_LABEL_PREFIX: Record<PickerKind, string> = {
  event: "settings.preSendChecks.events.",
  trigger: "settings.preSendChecks.triggers.",
  operator: "settings.preSendChecks.operators.",
};

const THRESHOLD_UNIT_KEYS: Record<string, string> = {
  "agent.idleSeconds": "settings.preSendChecks.thresholdUnits.idleSeconds",
  "agent.contextUsedPercent": "settings.preSendChecks.thresholdUnits.contextUsedPercent",
  "agent.sessionCostUsd": "settings.preSendChecks.thresholdUnits.sessionCostUsd",
};

// Wire values are dotted or abbreviated (`agent.idleSeconds`, `gte`), and neither
// makes a label. The last segment is what the key is named after.
function labelKeyFor(kind: PickerKind, value: string): string {
  return `${OPTION_LABEL_PREFIX[kind]}${value.split(".").pop() ?? value}`;
}

interface PreSendCheckPickerProps {
  kind: PickerKind;
  known: readonly string[];
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (kind: PickerKind, value: string) => void;
  testID: string;
}

/**
 * One picker.
 *
 * Its own component so the option list, the selected display and the change
 * handler are all memoized — three inline props on a shared control is exactly
 * what makes a sheet rerender on every keystroke elsewhere in the form.
 */
function PreSendCheckPicker({
  kind,
  known,
  value,
  error,
  disabled,
  onChange,
  testID,
}: PreSendCheckPickerProps) {
  const { t } = useTranslation();

  const labelFor = useCallback(
    (option: string) =>
      known.includes(option)
        ? t(labelKeyFor(kind, option))
        : t("settings.preSendChecks.unrecognisedOption", { value: option }),
    [kind, known, t],
  );

  const options = useMemo(
    () =>
      preSendCheckOptions(known, value).map((option) => ({
        id: option,
        value: option,
        label: labelFor(option),
      })),
    [known, labelFor, value],
  );

  const selectedDisplay = useMemo(() => ({ label: labelFor(value) }), [labelFor, value]);

  const handleChange = useCallback(
    (next: string) => {
      onChange(kind, next);
    },
    [kind, onChange],
  );

  const label = t(`settings.preSendChecks.${kind}Label`);
  // Event and trigger carry a line of prose apiece, because the two stack and
  // nothing else on the form says so: the event is when we look, the trigger is
  // what must also hold when we do. Operator and outcome need no such help.
  const hint = t(`settings.preSendChecks.${kind}Hint`, { defaultValue: "" }) || undefined;

  return (
    <Field label={label} hint={hint} error={error} testID={testID}>
      <SelectField
        label={label}
        field={false}
        value={value}
        selectedDisplay={selectedDisplay}
        options={options}
        onChange={handleChange}
        // Neither is reachable — the list is never empty and a value is always
        // selected — but both are required, so they say what they would say.
        placeholder={label}
        emptyText={label}
        disabled={disabled}
        testID={`${testID}-select`}
      />
    </Field>
  );
}

interface PreSendCheckTryItProps {
  draft: PreSendCheckDraft;
  descriptors: readonly PreSendOutcomeDescriptor[];
  resetKey: string;
  disabled: boolean;
  testID: string;
}

/**
 * Try the rule you are writing, before saving it.
 *
 * Against a value you type rather than a live agent. The question while writing
 * a rule is "would this match" - would `/btw hello` trip my prefix, is 3600 the
 * number I meant - and answering from a real agent means picking one, waiting
 * for it to be in the right state, and getting an answer that changes by the
 * minute.
 *
 * Built from the draft on every keystroke, so it answers for the rule as it
 * stands rather than as it was last saved, and through the same evaluator the
 * real path uses so the two cannot disagree.
 */
function PreSendCheckTryIt({
  draft,
  descriptors,
  resetKey,
  disabled,
  testID,
}: PreSendCheckTryItProps) {
  const { t } = useTranslation();
  const [sample, setSample] = useState("");

  const verdict = useMemo(() => {
    const rule = applyPreSendCheckDraft({ existing: null, draft, id: "try-it", descriptors });
    return dryRunPreSendCheckSample(rule, sample).verdict;
  }, [descriptors, draft, sample]);

  const label = t("settings.preSendChecks.tryItLabel");

  return (
    <Field
      label={label}
      hint={t(`settings.preSendChecks.verdicts.${verdictKey(verdict)}`)}
      testID={testID}
    >
      <FormTextInput
        initialValue=""
        value={sample}
        resetKey={resetKey}
        onChangeText={setSample}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        placeholder={t("settings.preSendChecks.tryItPlaceholder")}
        accessibilityLabel={label}
        testID={`${testID}-input`}
      />
    </Field>
  );
}

/** One key per verdict, so the reason is translated rather than assembled. */
function verdictKey(verdict: ReturnType<typeof dryRunPreSendCheckSample>["verdict"]): string {
  return verdict.fires ? "fires" : verdict.because;
}

interface PreSendCheckEventPickerProps {
  value: string;
  error: string | undefined;
  disabled: boolean;
  onChange: (kind: PickerKind, value: string) => void;
  testID: string;
}

/**
 * Which seam the rule belongs to.
 *
 * Its own component so the modal is not the thing deciding whether to render it,
 * and renders nothing at all when there is one seam to choose from: a picker
 * offering a single option is a control that teaches nothing and takes a line
 * of a sheet that is already long.
 */
function PreSendCheckEventPicker({
  value,
  error,
  disabled,
  onChange,
  testID,
}: PreSendCheckEventPickerProps) {
  const { t } = useTranslation();
  if (PRE_SEND_EVENT_OPTIONS.length < 2) {
    return null;
  }
  return (
    <PreSendCheckPicker
      kind="event"
      known={PRE_SEND_EVENT_OPTIONS}
      value={value}
      error={error ? t(error) : undefined}
      disabled={disabled}
      onChange={onChange}
      testID={testID}
    />
  );
}

interface PreSendCheckHostRowProps {
  host: PreSendCheckModalHost;
  selected: boolean;
  disabled: boolean;
  onToggle: (serverId: string, selected: boolean) => void;
}

/**
 * One host the rule can live on.
 *
 * A switch each rather than a multi-select control, because the app has no
 * multi-select and this reads the same as every other list of toggles in
 * settings. An unusable host stays listed and switched off: knowing the rule
 * cannot go to that machine right now is worth more than the row being absent.
 */
function PreSendCheckHostRow({ host, selected, disabled, onToggle }: PreSendCheckHostRowProps) {
  const { t } = useTranslation();
  const handleToggle = useCallback(
    (next: boolean) => {
      onToggle(host.serverId, next);
    },
    [host.serverId, onToggle],
  );

  return (
    <View style={styles.hostRow}>
      <Text style={settingsStyles.rowTitle} numberOfLines={1}>
        {host.serverName}
      </Text>
      <Switch
        value={selected}
        onValueChange={handleToggle}
        disabled={disabled || !host.isUsable}
        accessibilityLabel={t("settings.preSendChecks.hostToggle", { host: host.serverName })}
        testID={`pre-send-check-host-${host.serverId}`}
      />
    </View>
  );
}

interface PreSendOutcomeFieldProps {
  parameter: PreSendOutcomeParameter;
  value: string;
  disabled: boolean;
  resetKey: string;
  onChange: (id: string, value: string) => void;
  testID: string;
}

/**
 * One outcome parameter, drawn from what the daemon said it takes.
 *
 * The labels arrive in English, because they come from the daemon. That is the
 * trade this arrangement makes: an editor that needs no change to offer an
 * outcome it has never heard of cannot also translate it.
 */
function PreSendOutcomeField({
  parameter,
  value,
  disabled,
  resetKey,
  onChange,
  testID,
}: PreSendOutcomeFieldProps) {
  const handleChangeText = useCallback(
    (next: string) => {
      onChange(parameter.id, next);
    },
    [onChange, parameter.id],
  );

  // The daemon describes its own parameters and cannot know the seam, so its
  // text for anything mentioning `{{message}}` says "what you typed" — true at
  // the composer and false everywhere else, where nobody typed anything and the
  // token takes the rule's own Message instead. Only the app knows which, so
  // only the app can say. Anything not mentioning the token keeps the daemon's
  // wording, so an outcome this build has never heard of still describes itself.
  const handleToggle = useCallback(
    (next: boolean) => {
      onChange(parameter.id, next ? "true" : "");
    },
    [onChange, parameter.id],
  );

  if (parameter.type === "toggle") {
    return (
      <View style={styles.hostRow}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {parameter.label}
        </Text>
        <Switch
          value={value === "true"}
          onValueChange={handleToggle}
          disabled={disabled}
          accessibilityLabel={parameter.label}
          testID={testID}
        />
      </View>
    );
  }

  return (
    <Field label={parameter.label} hint={parameter.description} testID={testID + "-field"}>
      <FormTextInput
        initialValue={value}
        value={value}
        resetKey={resetKey}
        onChangeText={handleChangeText}
        placeholder={parameter.placeholder}
        multiline={parameter.multiline}
        autoCapitalize="sentences"
        autoCorrect={false}
        editable={!disabled}
        accessibilityLabel={parameter.label}
        testID={testID}
      />
    </Field>
  );
}

interface PreSendOutcomeRowProps {
  index: number;
  /** The seam, which decides whether a prompt has `{{message}}` to interpolate. */
  event: string;
  /** The trigger, which decides which tokens a wording can render. */
  trigger: string;
  outcome: PreSendCheckOutcomeDraft;
  /** Every kind this seam accepts and this daemon can perform. */
  kinds: readonly string[];
  /** What the chosen kind takes, when the daemon described it. */
  descriptor: PreSendOutcomeDescriptor | undefined;
  /** False on the last remaining row: a rule with no outcome does nothing. */
  canRemove: boolean;
  disabled: boolean;
  resetKey: string;
  onKindChange: (index: number, kind: string) => void;
  onParamChange: (index: number, id: string, value: string) => void;
  onRemove: (index: number) => void;
  testID: string;
}

/**
 * One outcome: what to do, and whatever that takes.
 *
 * One picker where the editor used to have two. The old pair asked "what should
 * happen" and then "where to", which put the word `redirect` on screen purely to
 * introduce the second question — a word that named nothing in the rule. `Warn`
 * and `Ask on the side` are the same kind of answer, so they belong in the same
 * list.
 *
 * The label is translated for the kinds this build knows and comes from the
 * daemon for the ones it does not, which is the same trade the parameters make:
 * an editor that needs no change to offer a new outcome cannot also translate
 * it.
 */
function PreSendOutcomeRow({
  index,
  event,
  trigger,
  outcome,
  kinds,
  descriptor,
  canRemove,
  disabled,
  resetKey,
  onKindChange,
  onParamChange,
  onRemove,
  testID,
}: PreSendOutcomeRowProps) {
  const { t } = useTranslation();

  const labelFor = useCallback(
    (kind: string) =>
      isPlainOutcomeKind(kind)
        ? t(`settings.preSendChecks.outcomeKinds.${kind}`)
        : ((descriptor?.kind === kind ? descriptor.label : undefined) ?? kind),
    [descriptor, t],
  );

  const options = useMemo(
    () =>
      preSendCheckOptions(kinds, outcome.kind).map((kind) => ({
        id: kind,
        value: kind,
        label: labelFor(kind),
      })),
    [kinds, labelFor, outcome.kind],
  );

  const selectedDisplay = useMemo(
    () => ({ label: labelFor(outcome.kind) }),
    [labelFor, outcome.kind],
  );

  const handleKindChange = useCallback(
    (next: string) => {
      onKindChange(index, next);
    },
    [index, onKindChange],
  );

  const handleParamChange = useCallback(
    (id: string, value: string) => {
      onParamChange(index, id, value);
    },
    [index, onParamChange],
  );

  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);

  const label = t("settings.preSendChecks.outcomeLabel");

  // Declared here rather than beside the daemon's descriptors: `warn`, `block`
  // and `notify` are fixed in the protocol, so nothing describes them and the
  // editor has to know what they take. Shaped like a daemon-supplied parameter
  // so it renders through the same component, but translated, which the
  // daemon's own never are.
  const wordingParameter = useMemo<PreSendOutcomeParameter>(
    () => ({
      type: "text",
      id: PRE_SEND_WORDING_PARAM,
      label: t("settings.preSendChecks.wordingLabel"),
      description: `${t("settings.preSendChecks.wordingHint")} ${tokenHelp(
        preSendTokensForWording(trigger),
        t,
      )}`,
      multiline: true,
    }),
    [t, trigger],
  );

  // A daemon describes its own parameters and cannot know the seam, so its
  // sentence about tokens names one that may not exist here. Rewritten by the
  // row rather than by the field, because only the row knows it is looking at a
  // prompt — the field cannot tell a prompt from a wording, and guessing from
  // the text is exactly how the wording ended up advertising `{{message}}`,
  // which no wording has ever interpolated. Everything not mentioning a token
  // keeps the daemon's own words, so an unknown outcome still describes itself.
  const promptParameters = useMemo(() => {
    const tokens = tokenHelp(preSendTokensForPrompt(event), t);
    const rewritten: PreSendOutcomeParameter[] = [];
    for (const parameter of descriptor?.parameters ?? []) {
      if (parameter.description?.includes("{{") !== true) {
        rewritten.push(parameter);
        continue;
      }
      const described = { ...parameter };
      described.description = `${stripTokenSentence(parameter.description)} ${tokens}`.trim();
      rewritten.push(described);
    }
    return rewritten;
  }, [descriptor, event, t]);

  return (
    <View style={styles.outcomeRow}>
      <View style={styles.outcomePicker}>
        <SelectField
          label={label}
          field={false}
          value={outcome.kind}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={handleKindChange}
          placeholder={label}
          emptyText={label}
          disabled={disabled}
          testID={`${testID}-select`}
        />
        <Button
          variant="secondary"
          onPress={handleRemove}
          // Disabled rather than hidden on the last row, so the control does not
          // move under the pointer as rows come and go.
          disabled={disabled || !canRemove}
          accessibilityLabel={t("settings.preSendChecks.removeOutcome")}
          testID={`${testID}-remove`}
        >
          <RemoveOutcomeIcon size={16} />
        </Button>
      </View>
      {isPlainOutcomeKind(outcome.kind) ? (
        <PreSendOutcomeField
          parameter={wordingParameter}
          value={outcome.params[PRE_SEND_WORDING_PARAM] ?? ""}
          disabled={disabled}
          resetKey={`${resetKey}-${outcome.kind}`}
          onChange={handleParamChange}
          testID={`${testID}-${PRE_SEND_WORDING_PARAM}`}
        />
      ) : null}
      {promptParameters.map((parameter) => (
        <PreSendOutcomeField
          key={parameter.id}
          parameter={parameter}
          value={outcome.params[parameter.id] ?? ""}
          disabled={disabled}
          resetKey={`${resetKey}-${outcome.kind}`}
          onChange={handleParamChange}
          testID={`${testID}-${parameter.id}`}
        />
      ))}
    </View>
  );
}

interface PreSendOutcomeListProps {
  draft: PreSendCheckDraft;
  descriptors: readonly PreSendOutcomeDescriptor[];
  error: string | undefined;
  disabled: boolean;
  resetKey: string;
  onKindChange: (index: number, kind: string) => void;
  onParamChange: (index: number, id: string, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  testID: string;
}

/**
 * Everything the rule should do, as a list you add to.
 *
 * The `+` is absent rather than disabled when the seam has nothing left to
 * offer, because unlike the per-row `-` it sits at the end of the list where
 * nothing shifts under the pointer when it goes.
 */
function PreSendOutcomeList({
  draft,
  descriptors,
  error,
  disabled,
  resetKey,
  onKindChange,
  onParamChange,
  onRemove,
  onAdd,
  testID,
}: PreSendOutcomeListProps) {
  const { t } = useTranslation();
  const canAdd = nextPreSendOutcomeKind(draft, descriptors) !== null;

  return (
    <Field
      label={t("settings.preSendChecks.outcomesLabel")}
      hint={t("settings.preSendChecks.outcomesHint")}
      error={error}
      testID={testID}
    >
      <View style={styles.outcomeList}>
        {draft.outcomes.map((outcome, index) => (
          <PreSendOutcomeRow
            // Sound because no two rows can hold the same kind: each row's
            // picker leaves out what its siblings already have.
            key={outcome.kind}
            index={index}
            event={draft.event}
            trigger={draft.trigger}
            outcome={outcome}
            kinds={preSendOutcomeKindsForRow(draft, index, descriptors)}
            descriptor={descriptors.find((candidate) => candidate.kind === outcome.kind)}
            canRemove={draft.outcomes.length > 1}
            disabled={disabled}
            resetKey={resetKey}
            onKindChange={onKindChange}
            onParamChange={onParamChange}
            onRemove={onRemove}
            testID={`${testID}-${index}`}
          />
        ))}
        {canAdd ? (
          <Button
            variant="secondary"
            onPress={onAdd}
            disabled={disabled}
            accessibilityLabel={t("settings.preSendChecks.addOutcome")}
            testID={`${testID}-add`}
          >
            {t("settings.preSendChecks.addOutcome")}
          </Button>
        ) : null}
      </View>
    </Field>
  );
}

/**
 * Edits one rule.
 *
 * Knows nothing about ids or how a rule is saved — `onSave` returns a
 * promise, and resolving closes while rejecting shows the reason. That contract is
 * lifted from the terminal profile modal and is why both can be tested without a
 * daemon.
 */
export function PreSendCheckEditModal({
  visible,
  title,
  initialDraft,
  hosts,
  initialServerIds,
  outcomeDescriptors,
  onClose,
  onSave,
  testID,
}: PreSendCheckEditModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PreSendCheckDraft>(initialDraft);
  const [serverIds, setServerIds] = useState<readonly string[]>(initialServerIds);
  const [fieldErrors, setFieldErrors] = useState<PreSendCheckFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const prefix = testID ?? "pre-send-check";

  const initialDraftRef = useRef(initialDraft);
  initialDraftRef.current = initialDraft;

  const { trigger: initialTrigger, operator: initialOperator, value: initialValue } = initialDraft;
  // The outcomes as one string, for the same reason the host ids are joined
  // below: a caller rebuilding an equal list each render must not reset the
  // form under the person filling it in.
  const initialOutcomeKey = initialDraft.outcomes.map((outcome) => outcome.kind).join(",");

  // Joined rather than used as an array, for the same reason the draft is
  // destructured below: a caller rebuilding an equal list each render must not
  // reset the form under the person filling it in.
  const initialServerIdKey = initialServerIds.join(SERVER_ID_KEY_SEPARATOR);

  // Destructured deps rather than the object, so a caller rebuilding an equal
  // draft each render does not reset the form under the person typing in it.
  useEffect(() => {
    if (!visible) {
      setIsPending(false);
      return;
    }
    setDraft(withDefaultPreSendWording(initialDraftRef.current, t));
    setServerIds(initialServerIdKey ? initialServerIdKey.split(SERVER_ID_KEY_SEPARATOR) : []);
    setFieldErrors({});
    setSubmitError(null);
  }, [
    visible,
    initialTrigger,
    initialOperator,
    initialValue,
    initialOutcomeKey,
    initialServerIdKey,
    t,
  ]);

  const clearOutcomeError = useCallback(() => {
    setFieldErrors((current) => {
      if (!("outcomes" in current)) {
        return current;
      }
      const next = { ...current };
      delete next.outcomes;
      return next;
    });
  }, []);

  const handleOutcomeKindChange = useCallback(
    (index: number, kind: string) => {
      setDraft((current) => setPreSendOutcomeKind(current, index, kind));
      clearOutcomeError();
    },
    [clearOutcomeError],
  );

  const handleOutcomeParamChange = useCallback((index: number, id: string, value: string) => {
    setDraft((current) => setPreSendOutcomeParam(current, index, id, value));
  }, []);

  const handleOutcomeRemove = useCallback(
    (index: number) => {
      setDraft((current) => removePreSendOutcome(current, index));
      clearOutcomeError();
    },
    [clearOutcomeError],
  );

  const handleOutcomeAdd = useCallback(() => {
    // The kind is worked out from the draft rather than passed in, so the row
    // that appears is one the seam accepts and the list does not already hold.
    setDraft((current) =>
      withDefaultPreSendWording(
        addPreSendOutcome(current, nextPreSendOutcomeKind(current, outcomeDescriptors)),
        t,
      ),
    );
    clearOutcomeError();
  }, [clearOutcomeError, outcomeDescriptors, t]);

  const handleToggleHost = useCallback((serverId: string, selected: boolean) => {
    setServerIds((current) => {
      if (selected) {
        return current.includes(serverId) ? current : [...current, serverId];
      }
      return current.filter((candidate) => candidate !== serverId);
    });
    setSubmitError(null);
  }, []);

  const setField = useCallback((field: keyof PreSendCheckDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!(field in current)) {
        return current;
      }
      const next = { ...current };
      delete next[field as PreSendCheckField];
      return next;
    });
  }, []);

  const handlePickerChange = useCallback(
    (kind: PickerKind, value: string) => {
      // A seam change drags the other pickers with it: what a rule may look at
      // and ask for differs per seam, so the rest of the draft has to be made
      // legal in the same breath rather than left showing something its new
      // seam would silently refuse.
      setDraft((current) =>
        kind === "event"
          ? applyPreSendEventChange(current, value, outcomeDescriptors)
          : { ...current, [kind]: value },
      );
      setFieldErrors((current) => ({ ...current, [kind]: undefined }));
    },
    [outcomeDescriptors, setDraft, setFieldErrors],
  );

  const triggerOptions = useMemo(() => preSendTriggerOptions(draft.event), [draft.event]);

  const handleThresholdChange = useCallback(
    (next: string) => {
      setField("value", next);
    },
    [setField],
  );

  const handleSave = useCallback(async () => {
    if (isPending) {
      return;
    }
    setSubmitError(null);
    const gate = gatePreSendCheckSave({ draft, hostCount: hosts.length, serverIds });
    if (gate.kind === "fieldErrors") {
      setFieldErrors(gate.errors);
      return;
    }
    if (gate.kind === "hostsRequired") {
      setSubmitError(t("settings.preSendChecks.hostsRequired"));
      return;
    }
    setIsPending(true);
    try {
      await onSave(draft, serverIds);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    } finally {
      setIsPending(false);
    }
  }, [draft, hosts.length, isPending, onClose, onSave, serverIds, t]);

  const handleCancel = useCallback(() => {
    if (isPending) {
      return;
    }
    onClose();
  }, [isPending, onClose]);

  // Filtered by seam: the daemon describes every outcome it can run, and not
  // all of them mean anything everywhere. Offering one the seam would refuse is
  // how a rule gets saved that never fires.
  const seamOutcomes = useMemo(
    () => preSendOutcomeOptions(draft.event, outcomeDescriptors),
    [draft.event, outcomeDescriptors],
  );

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
  const isAlwaysTrigger = draft.trigger === "always";
  const resetKey = visible ? "open" : "closed";
  // One input holds either the number a numeric rule compares against or the
  // text a trigger matches, so it has to say which it currently is. Calling a
  // string "Threshold" reads as a mistake in the rule rather than in the label.
  const isTextRule = isTextTrigger(draft.trigger);
  const thresholdUnitKey = isTextRule ? undefined : THRESHOLD_UNIT_KEYS[draft.trigger];
  const thresholdLabel = t(
    isTextRule ? "settings.preSendChecks.textLabel" : "settings.preSendChecks.thresholdLabel",
  );
  const thresholdHint = isTextRule ? t("settings.preSendChecks.textHint") : undefined;

  // One ternary rather than two guards, which is also what keeps this function
  // under the complexity ceiling. `always` is the trigger with no comparison in
  // it, so the evaluator ignores both of these — rendering them would ask for
  // two values that do nothing, which is worse than asking for nothing.
  const comparisonFields = isAlwaysTrigger ? null : (
    <>
      {/* `always` is the trigger with no comparison in it, so the evaluator
              ignores both of these. Rendering them asks for two values that do
              nothing, which is worse than asking for nothing. */}
      <PreSendCheckPicker
        kind="operator"
        known={PRE_SEND_OPERATOR_OPTIONS}
        value={draft.operator}
        error={fieldErrors.operator ? t(fieldErrors.operator) : undefined}
        disabled={isPending}
        onChange={handlePickerChange}
        testID={`${prefix}-operator`}
      />
      <Field
        label={thresholdLabel}
        hint={thresholdUnitKey ? t(thresholdUnitKey) : thresholdHint}
        error={fieldErrors.value ? t(fieldErrors.value) : undefined}
        testID={`${prefix}-threshold`}
      >
        <FormTextInput
          initialValue={draft.value}
          value={draft.value}
          resetKey={resetKey}
          onChangeText={handleThresholdChange}
          keyboardType={isTextRule ? "default" : "number-pad"}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isPending}
          returnKeyType="next"
          accessibilityLabel={thresholdLabel}
          testID={`${prefix}-threshold-input`}
        />
      </Field>{" "}
    </>
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleCancel}
      desktopMaxWidth={480}
      testID={testID}
    >
      <View style={styles.body}>
        <PreSendCheckEventPicker
          value={draft.event}
          error={fieldErrors.event}
          disabled={isPending}
          onChange={handlePickerChange}
          testID={`${prefix}-event`}
        />
        <PreSendCheckPicker
          kind="trigger"
          known={triggerOptions}
          value={draft.trigger}
          error={fieldErrors.trigger ? t(fieldErrors.trigger) : undefined}
          disabled={isPending}
          onChange={handlePickerChange}
          testID={`${prefix}-measurement`}
        />
        {comparisonFields}

        <PreSendOutcomeList
          draft={draft}
          descriptors={seamOutcomes}
          error={fieldErrors.outcomes ? t(fieldErrors.outcomes) : undefined}
          disabled={isPending}
          resetKey={resetKey}
          onKindChange={handleOutcomeKindChange}
          onParamChange={handleOutcomeParamChange}
          onRemove={handleOutcomeRemove}
          onAdd={handleOutcomeAdd}
          testID={`${prefix}-outcomes`}
        />

        {preSendCheckChoosesHosts(hosts.length) ? (
          <Field
            label={t("settings.preSendChecks.hostsLabel")}
            hint={t("settings.preSendChecks.hostsHint")}
            testID={`${prefix}-hosts`}
          >
            <View style={styles.hostList}>
              {hosts.map((host) => (
                <PreSendCheckHostRow
                  key={host.serverId}
                  host={host}
                  selected={serverIds.includes(host.serverId)}
                  disabled={isPending}
                  onToggle={handleToggleHost}
                />
              ))}
            </View>
          </Field>
        ) : null}

        {/* Last, because it answers for the whole rule rather than for any one
            field: its verdict covers the seam, the trigger, the comparison and
            whether the outcomes can happen there. Sitting between the outcomes
            and the message, it separated two things that belong together and
            interrupted the rule halfway through being written. */}
        <PreSendCheckTryIt
          draft={draft}
          descriptors={seamOutcomes}
          resetKey={resetKey}
          disabled={isPending}
          testID={`${prefix}-try-it`}
        />

        {submitError ? (
          <Text style={styles.submitError} testID="pre-send-check-submit-error">
            {submitError}
          </Text>
        ) : null}

        <View style={styles.footer}>
          <Button
            variant="secondary"
            onPress={handleCancel}
            disabled={isPending}
            style={styles.footerButton}
            testID="pre-send-check-cancel"
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            onPress={handleSave}
            disabled={isPending}
            style={styles.footerButton}
            testID="pre-send-check-save"
          >
            {isPending ? t("settings.preSendChecks.saving") : t("settings.preSendChecks.save")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  hostList: {
    gap: theme.spacing[1],
  },
  outcomeList: {
    gap: theme.spacing[3],
  },
  outcomeRow: {
    gap: theme.spacing[2],
  },
  outcomePicker: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  footer: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  footerButton: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
