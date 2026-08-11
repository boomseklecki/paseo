import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
  isTextTrigger,
  type PreSendActionDescriptor,
  type PreSendActionParameter,
} from "@getpaseo/protocol/pre-send-checks/types";
import { settingsStyles } from "@/styles/settings";
import {
  gatePreSendCheckSave,
  preSendCheckChoosesHosts,
  preSendCheckOptions,
  PRE_SEND_DISPOSITION_OPTIONS,
  PRE_SEND_TRIGGER_OPTIONS,
  PRE_SEND_OPERATOR_OPTIONS,
  type PreSendCheckDraft,
  type PreSendCheckField,
  type PreSendCheckFieldErrors,
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
   * The actions this daemon can carry out, as it described them. Empty means a
   * daemon too old to say, so the action fields stay hidden rather than showing
   * an empty picker: there is nothing to offer and guessing would invent a kind.
   */
  actions: readonly PreSendActionDescriptor[];
  onClose: () => void;
  onSave: (draft: PreSendCheckDraft, serverIds: readonly string[]) => Promise<void>;
  testID?: string;
}

type PickerKind = "trigger" | "operator" | "disposition";

// Separates server ids inside the memo key below, chosen because it cannot
// occur in one. Written as an escape and not as the character itself: a raw
// NUL in the source makes the whole file binary to grep, to git diff and to
// anyone reviewing it, which is how this one went unnoticed.
const SERVER_ID_KEY_SEPARATOR = "\u0000";

const OPTION_LABEL_PREFIX: Record<PickerKind, string> = {
  trigger: "settings.preSendChecks.triggers.",
  operator: "settings.preSendChecks.operators.",
  disposition: "settings.preSendChecks.dispositions.",
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

  return (
    <Field label={label} error={error} testID={testID}>
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

interface PreSendActionFieldProps {
  parameter: PreSendActionParameter;
  value: string;
  disabled: boolean;
  resetKey: string;
  onChange: (id: string, value: string) => void;
  testID: string;
}

/**
 * One action parameter, drawn from what the daemon said it takes.
 *
 * The labels arrive in English, because they come from the daemon. That is the
 * trade this arrangement makes: an editor that needs no change to offer an
 * action it has never heard of cannot also translate it.
 */
function PreSendActionField({
  parameter,
  value,
  disabled,
  resetKey,
  onChange,
  testID,
}: PreSendActionFieldProps) {
  const handleChangeText = useCallback(
    (next: string) => {
      onChange(parameter.id, next);
    },
    [onChange, parameter.id],
  );

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
  actions,
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

  const {
    trigger: initialTrigger,
    operator: initialOperator,
    value: initialValue,
    disposition: initialDisposition,
    message: initialMessage,
  } = initialDraft;

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
    setDraft(initialDraftRef.current);
    setServerIds(initialServerIdKey ? initialServerIdKey.split(SERVER_ID_KEY_SEPARATOR) : []);
    setFieldErrors({});
    setSubmitError(null);
  }, [
    visible,
    initialTrigger,
    initialOperator,
    initialValue,
    initialDisposition,
    initialMessage,
    initialServerIdKey,
  ]);

  const handleActionKindChange = useCallback((next: string) => {
    setDraft((current) => ({ ...current, actionKind: next }));
    setFieldErrors((current) => {
      if (!("action" in current)) {
        return current;
      }
      const nextErrors = { ...current };
      delete nextErrors.action;
      return nextErrors;
    });
  }, []);

  const handleActionParamChange = useCallback((id: string, value: string) => {
    setDraft((current) => ({
      ...current,
      actionParams: { ...current.actionParams, [id]: value },
    }));
  }, []);

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
      setField(kind, value);
    },
    [setField],
  );

  const handleThresholdChange = useCallback(
    (next: string) => {
      setField("value", next);
    },
    [setField],
  );

  const handleMessageChange = useCallback(
    (next: string) => {
      setField("message", next);
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

  const selectedAction = actions.find((action) => action.kind === draft.actionKind);
  const actionOptions = useMemo(
    () =>
      actions.map((action) => ({
        id: action.kind,
        value: action.kind,
        label: action.label,
        description: action.description,
      })),
    [actions],
  );
  // The daemon's own label where it knows the kind, and the raw kind where it
  // does not — a rule written against a newer daemon must still show what it
  // holds rather than appearing to hold nothing.
  const selectedActionDisplay = useMemo(
    () => ({ label: selectedAction?.label ?? draft.actionKind }),
    [draft.actionKind, selectedAction],
  );

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
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
  const messageLabel = t("settings.preSendChecks.messageLabel");

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleCancel}
      desktopMaxWidth={480}
      testID={testID}
    >
      <View style={styles.body}>
        <PreSendCheckPicker
          kind="trigger"
          known={PRE_SEND_TRIGGER_OPTIONS}
          value={draft.trigger}
          error={fieldErrors.trigger ? t(fieldErrors.trigger) : undefined}
          disabled={isPending}
          onChange={handlePickerChange}
          testID={`${prefix}-measurement`}
        />
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
        </Field>

        <PreSendCheckPicker
          kind="disposition"
          known={PRE_SEND_DISPOSITION_OPTIONS}
          value={draft.disposition}
          error={fieldErrors.disposition ? t(fieldErrors.disposition) : undefined}
          disabled={isPending}
          onChange={handlePickerChange}
          testID={`${prefix}-disposition`}
        />

        <Field
          label={messageLabel}
          hint={t("settings.preSendChecks.messageHint")}
          testID={`${prefix}-message`}
        >
          <FormTextInput
            initialValue={draft.message}
            value={draft.message}
            resetKey={resetKey}
            onChangeText={handleMessageChange}
            placeholder={t("settings.preSendChecks.messagePlaceholder")}
            autoCapitalize="sentences"
            autoCorrect={false}
            editable={!isPending}
            returnKeyType="done"
            onSubmitEditing={handleSave}
            accessibilityLabel={messageLabel}
            testID={`${prefix}-message-input`}
          />
        </Field>

        {draft.disposition === "redirect" && actions.length > 0 ? (
          <>
            <Field
              label={t("settings.preSendChecks.actionLabel")}
              error={fieldErrors.action ? t(fieldErrors.action) : undefined}
              testID={`${prefix}-action`}
            >
              <SelectField
                label={t("settings.preSendChecks.actionLabel")}
                field={false}
                value={draft.actionKind}
                selectedDisplay={selectedActionDisplay}
                options={actionOptions}
                onChange={handleActionKindChange}
                placeholder={t("settings.preSendChecks.actionPlaceholder")}
                emptyText={t("settings.preSendChecks.actionPlaceholder")}
                disabled={isPending}
                testID={`${prefix}-action-select`}
              />
            </Field>

            {selectedAction?.parameters.map((parameter) => (
              <PreSendActionField
                key={parameter.id}
                parameter={parameter}
                value={draft.actionParams[parameter.id] ?? ""}
                disabled={isPending}
                resetKey={`${resetKey}-${draft.actionKind}`}
                onChange={handleActionParamChange}
                testID={`${prefix}-action-${parameter.id}`}
              />
            ))}
          </>
        ) : null}

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
