import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Pencil, Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { usePreSendChecks } from "@/hooks/use-pre-send-checks";
import { usePreSendCheckMutations } from "@/hooks/use-pre-send-check-mutations";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { PreSendCheckEditModal } from "./pre-send-check-edit-modal";
import {
  applyPreSendCheckDraft,
  describePreSendCheck,
  movePreSendCheck,
  toPreSendCheckDraft,
  EMPTY_PRE_SEND_CHECK_DRAFT,
  type PreSendCheckDraft,
} from "./pre-send-check-form";

const AddIcon = withUnistyles(Plus);
const EditIcon = withUnistyles(Pencil);
const RemoveIcon = withUnistyles(Trash2);
const MoveUpIcon = withUnistyles(ArrowUp);
const MoveDownIcon = withUnistyles(ArrowDown);

// Module-level elements so four buttons per row do not rebuild their icons on
// every render of the list.
const addIcon = <AddIcon size={16} />;
const editIcon = <EditIcon size={16} />;
const removeIcon = <RemoveIcon size={16} />;
const moveUpIcon = <MoveUpIcon size={16} />;
const moveDownIcon = <MoveDownIcon size={16} />;

function generateRuleId(): string {
  return Math.random().toString(16).slice(2, 10);
}

export type PreSendChecksListState =
  | { kind: "unavailable"; messageKey: string }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "rules" };

/**
 * What the card shows.
 *
 * Exported and pure so the four-way decision can be read in one place. The two
 * unavailable reasons are kept apart deliberately — waiting for a reconnect is a
 * matter of time, an old daemon is a matter of upgrading, and one message for
 * both would leave someone waiting for a state that will not arrive.
 */
export function resolvePreSendChecksListState(input: {
  isConnected: boolean;
  isSupported: boolean;
  rules: readonly PreSendCheckRule[] | null;
}): PreSendChecksListState {
  if (!input.isConnected) {
    return { kind: "unavailable", messageKey: "settings.preSendChecks.unavailableDisconnected" };
  }
  if (!input.isSupported) {
    return { kind: "unavailable", messageKey: "settings.preSendChecks.unavailableUnsupported" };
  }
  if (!input.rules) {
    return { kind: "loading" };
  }
  return input.rules.length === 0 ? { kind: "empty" } : { kind: "rules" };
}

function listStateMessageKey(state: PreSendChecksListState): string {
  switch (state.kind) {
    case "unavailable":
      return state.messageKey;
    case "loading":
      return "settings.preSendChecks.loading";
    default:
      return "settings.preSendChecks.emptyState";
  }
}

interface PreSendCheckRowProps {
  rule: PreSendCheckRule;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  onEdit: (rule: PreSendCheckRule) => void;
  onRemove: (rule: PreSendCheckRule) => void;
  onMove: (rule: PreSendCheckRule, direction: "up" | "down") => void;
  onToggle: (rule: PreSendCheckRule, enabled: boolean) => void;
}

function PreSendCheckRow({
  rule,
  isFirst,
  isLast,
  disabled,
  onEdit,
  onRemove,
  onMove,
  onToggle,
}: PreSendCheckRowProps) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => {
    onEdit(rule);
  }, [onEdit, rule]);
  const handleRemove = useCallback(() => {
    onRemove(rule);
  }, [onRemove, rule]);
  const handleMoveUp = useCallback(() => {
    onMove(rule, "up");
  }, [onMove, rule]);
  const handleMoveDown = useCallback(() => {
    onMove(rule, "down");
  }, [onMove, rule]);
  const handleToggle = useCallback(
    (next: boolean) => {
      onToggle(rule, next);
    },
    [onToggle, rule],
  );

  // Absent means on, matching the evaluator, so a hand-written rule needs no
  // boilerplate to be live.
  const isEnabled = rule.enabled !== false;

  const rowStyle = useMemo(
    () => [settingsStyles.row, !isFirst && settingsStyles.rowBorder, styles.row],
    [isFirst],
  );

  // `block` is the louder outcome and gets the louder badge. There is no amber
  // variant on StatusBadge and adding one would change a component several other
  // screens share, so `warn` takes the muted one rather than growing the vocabulary
  // for a single caller.
  const isBlocking = rule.disposition === "block";

  return (
    <View style={rowStyle} testID={`pre-send-check-row-${rule.id}`}>
      <View style={styles.rowLeading}>
        <Switch
          value={isEnabled}
          onValueChange={handleToggle}
          disabled={disabled}
          accessibilityLabel={t("settings.preSendChecks.toggleRule")}
          testID={`pre-send-check-toggle-${rule.id}`}
        />
      </View>
      <View style={[styles.rowContent, !isEnabled && styles.rowContentOff]}>
        {/*
          Two lines on a phone rather than one truncated to nothing. The sentence
          is the whole point of the row, and a badge plus four buttons beside it
          left it about a third of the width.
        */}
        <Text style={settingsStyles.rowTitle} numberOfLines={2}>
          {describePreSendCheck(rule, t)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={2}>
          {rule.message ?? t("settings.preSendChecks.defaultMessageHint")}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <View style={styles.badgeSlot}>
          <StatusBadge
            label={
              isBlocking
                ? t("settings.preSendChecks.dispositions.block")
                : t("settings.preSendChecks.dispositions.warn")
            }
            variant={isBlocking ? "error" : "muted"}
          />
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={disabled || isFirst}
          accessibilityLabel={t("settings.preSendChecks.moveUp")}
          testID={`pre-send-check-move-up-${rule.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={disabled || isLast}
          accessibilityLabel={t("settings.preSendChecks.moveDown")}
          testID={`pre-send-check-move-down-${rule.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editIcon}
          onPress={handleEdit}
          disabled={disabled}
          accessibilityLabel={t("settings.preSendChecks.editRule")}
          testID={`pre-send-check-edit-${rule.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeIcon}
          onPress={handleRemove}
          disabled={disabled}
          accessibilityLabel={t("settings.preSendChecks.remove")}
          testID={`pre-send-check-remove-${rule.id}`}
        />
      </View>
    </View>
  );
}

type FormState = { kind: "closed" } | { kind: "create" } | { kind: "edit"; rule: PreSendCheckRule };

/**
 * Rules for one host at a time.
 *
 * The host picker is a seam, not a convenience: rules live one directory per
 * daemon, so "this rule on three hosts" means writing it to three stores. When
 * that lands the picker becomes a multi-select and everything below it stays.
 */
export function PreSendChecksPage() {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [serverId, setServerId] = useState<string | null>(hosts[0]?.serverId ?? null);

  // Hosts arrive asynchronously, and one can go away while the screen is open.
  useEffect(() => {
    if (hosts.length === 0) {
      return;
    }
    if (!serverId || !hosts.some((host) => host.serverId === serverId)) {
      setServerId(hosts[0]?.serverId ?? null);
    }
  }, [hosts, serverId]);

  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isSupported = useHostFeature(serverId, "preSendChecks");
  const { rules } = usePreSendChecks(serverId);
  const { upsertCheck, deleteCheck, reorderChecks } = usePreSendCheckMutations(serverId);
  const { config: daemonConfig, patchConfig } = useDaemonConfig(serverId);
  // Absent means on, so a host that has never seen the switch is checking.
  const isFeatureEnabled = daemonConfig?.preSendChecksEnabled !== false;
  const [form, setForm] = useState<FormState>({ kind: "closed" });
  const [isBusy, setIsBusy] = useState(false);

  const hostOptions = useMemo(
    () => hosts.map((host) => ({ id: host.serverId, value: host.serverId, label: host.label })),
    [hosts],
  );
  const selectedHostDisplay = useMemo(() => {
    const host = hosts.find((candidate) => candidate.serverId === serverId);
    return host ? { label: host.label } : null;
  }, [hosts, serverId]);

  const handleOpenCreate = useCallback(() => {
    setForm({ kind: "create" });
  }, []);
  const handleOpenEdit = useCallback((rule: PreSendCheckRule) => {
    setForm({ kind: "edit", rule });
  }, []);
  const handleCloseForm = useCallback(() => {
    setForm({ kind: "closed" });
  }, []);

  const handleSave = useCallback(
    async (draft: PreSendCheckDraft) => {
      const existing = form.kind === "edit" ? form.rule : null;
      await upsertCheck(
        applyPreSendCheckDraft({
          existing,
          draft,
          id: existing?.id ?? generateRuleId(),
        }),
      );
    },
    [form, upsertCheck],
  );

  const handleRemove = useCallback(
    async (rule: PreSendCheckRule) => {
      const confirmed = await confirmDialog({
        title: t("settings.preSendChecks.removeConfirmTitle"),
        message: t("settings.preSendChecks.removeConfirmMessage", {
          rule: describePreSendCheck(rule, t),
        }),
        confirmLabel: t("settings.preSendChecks.remove"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setIsBusy(true);
      try {
        await deleteCheck(rule.id);
      } catch (error) {
        // The row has nowhere inline to put this, unlike the modal.
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [deleteCheck, t],
  );

  const handleMove = useCallback(
    async (rule: PreSendCheckRule, direction: "up" | "down") => {
      if (!rules) {
        return;
      }
      const nextOrder = movePreSendCheck(rules, rule.id, direction);
      // Unchanged when the rule is already at the end it was moved towards, and
      // sending that would be a write and a broadcast that changed nothing.
      if (nextOrder.length === rules.length && nextOrder.every((id, i) => id === rules[i]?.id)) {
        return;
      }
      setIsBusy(true);
      try {
        await reorderChecks(nextOrder);
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [reorderChecks, rules, t],
  );

  const handleToggleRule = useCallback(
    async (rule: PreSendCheckRule, enabled: boolean) => {
      setIsBusy(true);
      try {
        await upsertCheck({ ...rule, enabled });
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [t, upsertCheck],
  );

  const handleToggleFeature = useCallback(
    (enabled: boolean) => {
      void patchConfig({ preSendChecksEnabled: enabled }).catch((error: unknown) => {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, t],
  );

  const initialDraft =
    form.kind === "edit" ? toPreSendCheckDraft(form.rule) : EMPTY_PRE_SEND_CHECK_DRAFT;

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleOpenCreate}
        disabled={!isConnected || !isSupported || isBusy}
        accessibilityLabel={t("settings.preSendChecks.addRule")}
        testID="pre-send-check-add"
      />
    ),
    [handleOpenCreate, isBusy, isConnected, isSupported, t],
  );

  // Whatever the state, the section header stays — unlike terminal profiles, which
  // returns before it and makes the screen look like it lost a setting rather than
  // like the setting is temporarily out of reach.
  const listState = resolvePreSendChecksListState({ isConnected, isSupported, rules });

  return (
    <SettingsSection
      title={t("settings.preSendChecks.sectionTitle")}
      trailing={addButton}
      testID="pre-send-checks-section"
    >
      {hosts.length > 1 ? (
        <SelectField
          label={t("settings.preSendChecks.hostLabel")}
          value={serverId ?? ""}
          selectedDisplay={selectedHostDisplay}
          options={hostOptions}
          onChange={setServerId}
          placeholder={t("settings.preSendChecks.hostLabel")}
          emptyText={t("settings.preSendChecks.noHosts")}
          testID="pre-send-check-host"
        />
      ) : null}

      <View style={settingsStyles.card} testID="pre-send-checks-enabled-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {t("settings.preSendChecks.featureToggleTitle")}
            </Text>
            <Text style={settingsStyles.rowHint}>{t("settings.preSendChecks.sectionHint")}</Text>
          </View>
          <Switch
            value={isFeatureEnabled}
            onValueChange={handleToggleFeature}
            disabled={!isConnected || !isSupported}
            accessibilityLabel={t("settings.preSendChecks.featureToggleTitle")}
            testID="pre-send-checks-enabled-switch"
          />
        </View>
      </View>

      <View style={settingsStyles.card} testID="pre-send-checks-card">
        {listState.kind === "rules" ? (
          (rules ?? []).map((rule, index) => (
            <PreSendCheckRow
              key={rule.id}
              rule={rule}
              isFirst={index === 0}
              isLast={index === (rules?.length ?? 0) - 1}
              disabled={isBusy}
              onEdit={handleOpenEdit}
              onRemove={handleRemove}
              onMove={handleMove}
              onToggle={handleToggleRule}
            />
          ))
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>{t(listStateMessageKey(listState))}</Text>
          </View>
        )}
      </View>

      <PreSendCheckEditModal
        visible={form.kind !== "closed"}
        title={
          form.kind === "edit"
            ? t("settings.preSendChecks.editTitle")
            : t("settings.preSendChecks.addTitle")
        }
        initialDraft={initialDraft}
        onClose={handleCloseForm}
        onSave={handleSave}
        testID="pre-send-check-modal"
      />
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Stacked on a phone, side by side once there is room. The row carries a
  // sentence, a badge and four controls, which is more than fits on a narrow
  // screen in one line — below `md` the controls drop underneath the text and get
  // the full width instead of competing for it.
  // Matches the terminal profiles rows, which get their breathing room from the
  // shared row's own paddingVertical rather than from anything here — overriding
  // it made this list tighter than the one beside it. The action buttons carry
  // their own padding, so `gap: 0` between them is what looks evenly spaced.
  row: {
    flexDirection: { xs: "column", md: "row" },
    alignItems: { xs: "stretch", md: "center" },
    gap: theme.spacing[2],
    minHeight: { xs: 88, md: 56 },
  },
  rowLeading: {
    justifyContent: "center",
  },
  rowContent: {
    flex: { xs: 0, md: 1 },
    marginRight: { xs: 0, md: theme.spacing[3] },
  },
  // Dimmed rather than hidden: a rule that is off still has to be findable, and
  // its arrangement still matters for when it comes back on.
  rowContentOff: {
    opacity: 0.5,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    // On a phone the controls sit under the sentence with the badge anchoring the
    // left, so the row reads top to bottom instead of squeezing five things onto
    // one line.
    justifyContent: { xs: "space-between", md: "flex-end" },
    gap: 0,
  },
  badgeSlot: {
    marginRight: theme.spacing[2],
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
