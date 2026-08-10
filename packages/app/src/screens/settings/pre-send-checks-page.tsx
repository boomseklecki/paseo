import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Plus, Pencil, Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { settingsStyles } from "@/styles/settings";
import { SettingsSection } from "@/screens/settings/settings-section";
import { usePreSendChecks } from "@/hooks/use-pre-send-checks";
import { usePreSendCheckMutations } from "@/hooks/use-pre-send-check-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { PreSendCheckEditModal } from "./pre-send-check-edit-modal";
import {
  applyPreSendCheckDraft,
  describePreSendCheck,
  toPreSendCheckDraft,
  EMPTY_PRE_SEND_CHECK_DRAFT,
  type PreSendCheckDraft,
} from "./pre-send-check-form";

const AddIcon = withUnistyles(Plus);
const EditIcon = withUnistyles(Pencil);
const RemoveIcon = withUnistyles(Trash2);

const addIcon = <AddIcon size={16} />;
const editIcon = <EditIcon size={16} />;
const removeIcon = <RemoveIcon size={16} />;

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
  disabled: boolean;
  onEdit: (rule: PreSendCheckRule) => void;
  onRemove: (rule: PreSendCheckRule) => void;
}

function PreSendCheckRow({ rule, isFirst, disabled, onEdit, onRemove }: PreSendCheckRowProps) {
  const { t } = useTranslation();
  const handleEdit = useCallback(() => {
    onEdit(rule);
  }, [onEdit, rule]);
  const handleRemove = useCallback(() => {
    onRemove(rule);
  }, [onRemove, rule]);

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
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
          {describePreSendCheck(rule, t)}
        </Text>
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {rule.message ?? t("settings.preSendChecks.defaultMessageHint")}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <StatusBadge
          label={
            isBlocking
              ? t("settings.preSendChecks.dispositions.block")
              : t("settings.preSendChecks.dispositions.warn")
          }
          variant={isBlocking ? "error" : "muted"}
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
  const { upsertCheck, deleteCheck } = usePreSendCheckMutations(serverId);
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

      <Text style={settingsStyles.rowHint}>{t("settings.preSendChecks.sectionHint")}</Text>

      <View style={settingsStyles.card} testID="pre-send-checks-card">
        {listState.kind === "rules" ? (
          (rules ?? []).map((rule, index) => (
            <PreSendCheckRow
              key={rule.id}
              rule={rule}
              isFirst={index === 0}
              disabled={isBusy}
              onEdit={handleOpenEdit}
              onRemove={handleRemove}
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
  row: {
    gap: theme.spacing[3],
    minHeight: 56,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
