import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField } from "@/components/ui/select-field";
import {
  preSendCheckOptions,
  validatePreSendCheckDraft,
  PRE_SEND_DISPOSITION_OPTIONS,
  PRE_SEND_MEASUREMENT_OPTIONS,
  PRE_SEND_OPERATOR_OPTIONS,
  type PreSendCheckDraft,
  type PreSendCheckField,
  type PreSendCheckFieldErrors,
} from "./pre-send-check-form";

interface PreSendCheckEditModalProps {
  visible: boolean;
  title: string;
  initialDraft: PreSendCheckDraft;
  onClose: () => void;
  onSave: (draft: PreSendCheckDraft) => Promise<void>;
  testID?: string;
}

type PickerKind = "measurement" | "operator" | "disposition";

const OPTION_LABEL_PREFIX: Record<PickerKind, string> = {
  measurement: "settings.preSendChecks.measurements.",
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

/**
 * Edits one rule.
 *
 * Knows nothing about ids, hosts or how a rule is saved — `onSave` returns a
 * promise, and resolving closes while rejecting shows the reason. That contract is
 * lifted from the terminal profile modal and is why both can be tested without a
 * daemon.
 */
export function PreSendCheckEditModal({
  visible,
  title,
  initialDraft,
  onClose,
  onSave,
  testID,
}: PreSendCheckEditModalProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<PreSendCheckDraft>(initialDraft);
  const [fieldErrors, setFieldErrors] = useState<PreSendCheckFieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const prefix = testID ?? "pre-send-check";

  const {
    measurement: initialMeasurement,
    operator: initialOperator,
    threshold: initialThreshold,
    disposition: initialDisposition,
    message: initialMessage,
  } = initialDraft;

  // Destructured deps rather than the object, so a caller rebuilding an equal
  // draft each render does not reset the form under the person typing in it.
  useEffect(() => {
    if (!visible) {
      setIsPending(false);
      return;
    }
    setDraft({
      measurement: initialMeasurement,
      operator: initialOperator,
      threshold: initialThreshold,
      disposition: initialDisposition,
      message: initialMessage,
    });
    setFieldErrors({});
    setSubmitError(null);
  }, [
    visible,
    initialMeasurement,
    initialOperator,
    initialThreshold,
    initialDisposition,
    initialMessage,
  ]);

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
      setField("threshold", next);
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
    const errors = validatePreSendCheckDraft(draft);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setIsPending(true);
    try {
      await onSave(draft);
      onClose();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("common.errors.unableToSave"));
    } finally {
      setIsPending(false);
    }
  }, [draft, isPending, onClose, onSave, t]);

  const handleCancel = useCallback(() => {
    if (isPending) {
      return;
    }
    onClose();
  }, [isPending, onClose]);

  const header = useMemo<SheetHeader>(() => ({ title }), [title]);
  const resetKey = visible ? "open" : "closed";
  const thresholdUnitKey = THRESHOLD_UNIT_KEYS[draft.measurement];
  const thresholdLabel = t("settings.preSendChecks.thresholdLabel");
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
          kind="measurement"
          known={PRE_SEND_MEASUREMENT_OPTIONS}
          value={draft.measurement}
          error={fieldErrors.measurement ? t(fieldErrors.measurement) : undefined}
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
          hint={thresholdUnitKey ? t(thresholdUnitKey) : undefined}
          error={fieldErrors.threshold ? t(fieldErrors.threshold) : undefined}
          testID={`${prefix}-threshold`}
        >
          <FormTextInput
            initialValue={draft.threshold}
            value={draft.threshold}
            resetKey={resetKey}
            onChangeText={handleThresholdChange}
            keyboardType="number-pad"
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
