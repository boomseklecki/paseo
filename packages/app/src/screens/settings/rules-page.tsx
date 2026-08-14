import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Alert, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Plus, Pencil, Trash2 } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";
import type { Theme } from "@/styles/theme";
import { SettingsSection } from "@/screens/settings/settings-section";
import { useAggregatedRules, type RuleHostState } from "@/hooks/use-aggregated-rules";
import { useRuleHostMutations } from "@/hooks/use-rule-host-mutations";
import { useRuleCatalog } from "@/hooks/use-rule-catalog";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { confirmDialog } from "@/utils/confirm-dialog";
import { RuleEditModal, type RuleModalHost } from "./rule-edit-modal";
import type { RuleGroup } from "./rule-groups";
import {
  listStateMessageKey,
  resolveHostUnavailableMessageKey,
  resolveRulesListState,
} from "./rule-host-state";
import type { RuleExample, RuleOutcomeDescriptor } from "@getpaseo/protocol/rules/types";
import { ruleNeverFires } from "@getpaseo/protocol/rules/dry-run";
import {
  applyRuleDraft,
  describeRule,
  describeRuleOutcome,
  moveRule,
  previewRuleMessage,
  ruleExampleToDraft,
  toRuleDraft,
  EMPTY_RULE_DRAFT,
  type RuleDraft,
} from "./rule-form";

const AddIcon = withUnistyles(Plus);
const EditIcon = withUnistyles(Pencil);
const RemoveIcon = withUnistyles(Trash2);
const MoveUpIcon = withUnistyles(ArrowUp);
const MoveDownIcon = withUnistyles(ArrowDown);

// Without an explicit mapping these inherit the accent colour and come out blue.
// Same two mappings the terminal profiles rows use, so the lists match.
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

// Module-level elements so five controls per row do not rebuild their icons on
// every render of the list.
const addIcon = <AddIcon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const editIcon = <EditIcon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const removeIcon = <RemoveIcon size={ICON_SIZE.sm} uniProps={destructiveColorMapping} />;
const moveUpIcon = <MoveUpIcon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const moveDownIcon = <MoveDownIcon size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

/**
 * Rule ids are minted here rather than by the daemon, and that is the design
 * rather than an oversight: one rule can live on several hosts, and grouping
 * those copies back together is done by id, so every daemon has to be handed the
 * same one. A daemon minting its own would give the same rule a different id per
 * host and the list would show it once per machine.
 *
 * Which puts the whole weight of not colliding on this function, because an
 * upsert carrying an id that already exists overwrites whatever is there. Hence
 * crypto rather than `Math.random`, whose hex expansion also silently comes out
 * shorter than the slice asks for whenever the low bits land on zero.
 */
function generateRuleId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface RuleRowProps {
  group: RuleGroup;
  /**
   * What the daemon says it can run, so the badge can use its label.
   *
   * Without these a runnable outcome badges as its raw wire kind — `aside`
   * beside `Block` and `Warn`, lowercase and in a vocabulary nobody chose. The
   * plain kinds are translated here; only the daemon can name the rest.
   */
  outcomeDescriptors: readonly RuleOutcomeDescriptor[];
  isFirst: boolean;
  isLast: boolean;
  showHosts: boolean;
  disabled: boolean;
  onEdit: (group: RuleGroup) => void;
  onRemove: (group: RuleGroup) => void;
  onMove: (group: RuleGroup, direction: "up" | "down") => void;
  onToggle: (group: RuleGroup, enabled: boolean) => void;
}

function RuleRow({
  group,
  outcomeDescriptors,
  isFirst,
  isLast,
  showHosts,
  disabled,
  onEdit,
  onRemove,
  onMove,
  onToggle,
}: RuleRowProps) {
  const { t } = useTranslation();
  const rule = group.rule;
  const handleEdit = useCallback(() => {
    onEdit(group);
  }, [onEdit, group]);
  const handleRemove = useCallback(() => {
    onRemove(group);
  }, [onRemove, group]);
  const handleMoveUp = useCallback(() => {
    onMove(group, "up");
  }, [onMove, group]);
  const handleMoveDown = useCallback(() => {
    onMove(group, "down");
  }, [onMove, group]);
  const handleToggle = useCallback(
    (next: boolean) => {
      onToggle(group, next);
    },
    [onToggle, group],
  );

  // Absent means on, matching the evaluator, so a hand-written rule needs no
  // boilerplate to be live.
  const isEnabled = rule.enabled !== false;

  const rowStyle = useMemo(() => [styles.row, !isFirst && settingsStyles.rowBorder], [isFirst]);

  // Three outcomes, not two. This read `isBlocking ? block : warn`, which
  // labelled the /btw rule "Warn" - a redirect neither warns nor blocks, it
  // takes the message somewhere else, and calling that a warning describes the
  // one rule most likely to be on the screen exactly backwards.
  //
  // `block` is the louder outcome and gets the louder badge. There is no amber
  // variant on StatusBadge and adding one would change a component several other
  // screens share, so the other two take the muted one rather than growing the
  // vocabulary for a single caller.
  // The editor refuses to build an impossible rule, but this directory is
  // hand-editable by design, so a rule written into a file never met the
  // editor. This is the only thing that would tell someone it can never fire.
  const neverFires = ruleNeverFires(rule);
  const { label: badgeLabel, isBlocking } = describeRuleOutcome(rule, t, outcomeDescriptors);

  return (
    <View style={rowStyle} testID={`rule-row-${group.id}`}>
      <View style={styles.rowText}>
        <View style={[styles.textBlock, !isEnabled && styles.textBlockOff]}>
          <Text style={settingsStyles.rowTitle} numberOfLines={2}>
            {describeRule(rule, t)}
          </Text>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {previewRuleMessage(rule, t) ?? t("settings.rules.defaultMessageHint")}
          </Text>
          {showHosts ? (
            <Text style={styles.hostLine} numberOfLines={2}>
              {group.serverNames.join(", ")}
            </Text>
          ) : null}
        </View>
        <View style={styles.badges}>
          {/* Ahead of the outcome badge, because "this can never fire" is the
              thing to read first. Only for rules that *cannot* fire, never for
              ones simply switched off - that would be telling someone off for
              using the switch. */}
          {neverFires ? (
            <StatusBadge label={t("settings.rules.neverFires")} variant="error" />
          ) : null}
          <StatusBadge label={badgeLabel} variant={isBlocking ? "error" : "muted"} />
          {group.differs ? (
            <StatusBadge label={t("settings.rules.differs")} variant="error" />
          ) : null}
        </View>
      </View>

      <View style={styles.rowControls}>
        <Switch
          value={isEnabled}
          onValueChange={handleToggle}
          disabled={disabled}
          accessibilityLabel={t("settings.rules.toggleRule")}
          testID={`rule-toggle-${group.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveUpIcon}
          onPress={handleMoveUp}
          disabled={disabled || isFirst}
          accessibilityLabel={t("settings.rules.moveUp")}
          testID={`rule-move-up-${group.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={moveDownIcon}
          onPress={handleMoveDown}
          disabled={disabled || isLast}
          accessibilityLabel={t("settings.rules.moveDown")}
          testID={`rule-move-down-${group.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={editIcon}
          onPress={handleEdit}
          disabled={disabled}
          accessibilityLabel={t("settings.rules.editRule")}
          testID={`rule-edit-${group.id}`}
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={removeIcon}
          onPress={handleRemove}
          disabled={disabled}
          accessibilityLabel={t("settings.rules.remove")}
          testID={`rule-remove-${group.id}`}
        />
      </View>
    </View>
  );
}

interface RulesFeatureRowProps {
  host: RuleHostState;
  /** True when this is the only host, which is when it carries the section hint. */
  isOnlyHost: boolean;
  withBorder: boolean;
}

/**
 * The per-host on switch for the whole gate.
 *
 * A component per host rather than a loop in the page, because the switch reads
 * `rulesEnabled` out of that host's daemon config and `useDaemonConfig`
 * is a hook — one host, one component, one hook, however many hosts there are.
 */
function RulesFeatureRow({ host, isOnlyHost, withBorder }: RulesFeatureRowProps) {
  const { t } = useTranslation();
  const { config, patchConfig } = useDaemonConfig(host.serverId);
  // Absent means on, so a host that has never seen the switch is checking.
  const isEnabled = config?.rulesEnabled !== false;

  const handleToggle = useCallback(
    (enabled: boolean) => {
      void patchConfig({ rulesEnabled: enabled }).catch((error: unknown) => {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      });
    },
    [patchConfig, t],
  );

  const rowStyle = useMemo(
    () => [settingsStyles.row, withBorder && settingsStyles.rowBorder],
    [withBorder],
  );

  // A disabled switch with nothing beside it reads as a switch that is simply
  // off, which is the wrong sentence in both directions: nobody turned it off,
  // and turning it on is not what would fix it. Replaces the section hint rather
  // than joining it — generic advice is worth less here than the reason.
  const unavailableMessageKey = resolveHostUnavailableMessageKey(host);
  let hintNode: ReactNode = null;
  if (unavailableMessageKey) {
    hintNode = (
      <Text style={settingsStyles.rowHint} testID={`rules-host-reason-${host.serverId}`}>
        {t(unavailableMessageKey)}
      </Text>
    );
  } else if (isOnlyHost) {
    hintNode = <Text style={settingsStyles.rowHint}>{t("settings.rules.sectionHint")}</Text>;
  }

  return (
    <View style={rowStyle}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>
          {isOnlyHost ? t("settings.rules.featureToggleTitle") : host.serverName}
        </Text>
        {hintNode}
      </View>
      <Switch
        value={isEnabled}
        onValueChange={handleToggle}
        disabled={!host.isConnected || !host.isSupported}
        accessibilityLabel={
          isOnlyHost
            ? t("settings.rules.featureToggleTitle")
            : t("settings.rules.featureToggleHost", { host: host.serverName })
        }
        testID={`rules-enabled-switch-${host.serverId}`}
      />
    </View>
  );
}

type FormState =
  | { kind: "closed" }
  | { kind: "create" }
  // An example opens the create form pre-filled rather than installing itself,
  // so what reaches disk is a rule someone read first.
  | { kind: "example"; example: RuleExample }
  | { kind: "edit"; group: RuleGroup };

/**
 * What the modal opens with.
 *
 * Three sources and one shape: an existing rule, an example, or nothing. Out
 * here as a function rather than a chain of ternaries inline, because the
 * example case is the one a reader will not expect.
 */
function resolveInitialDraft(form: FormState): RuleDraft {
  if (form.kind === "edit") {
    return toRuleDraft(form.group.rule);
  }
  if (form.kind === "example") {
    return ruleExampleToDraft(form.example);
  }
  return EMPTY_RULE_DRAFT;
}

interface RuleExampleRowProps {
  example: RuleExample;
  withBorder: boolean;
  disabled: boolean;
  onAdd: (example: RuleExample) => void;
}

/**
 * One suggestion, and the button that opens it as a new rule.
 *
 * The label and description are translated when the app recognises the id and
 * fall back to the daemon's English when it does not, so a newer daemon's
 * example shows up unnamed rather than not at all.
 */
function RuleExampleRow({ example, withBorder, disabled, onAdd }: RuleExampleRowProps) {
  const { t } = useTranslation();
  const handleAdd = useCallback(() => {
    onAdd(example);
  }, [example, onAdd]);

  const label = t(`settings.rules.examples.${example.id}.label`, {
    defaultValue: example.label,
  });
  const description = t(`settings.rules.examples.${example.id}.description`, {
    defaultValue: example.description ?? "",
  });

  return (
    <View
      style={[settingsStyles.row, withBorder ? settingsStyles.rowBorder : null]}
      testID={`rule-example-${example.id}`}
    >
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{label}</Text>
        {description ? <Text style={settingsStyles.rowHint}>{description}</Text> : null}
      </View>
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleAdd}
        disabled={disabled}
        accessibilityLabel={t("settings.rules.useExample", { name: label })}
        testID={`rule-example-add-${example.id}`}
      />
    </View>
  );
}

/**
 * Rules across every connected host.
 *
 * A rule lives one directory per daemon, so a rule "on three hosts" is three
 * files. The list groups them back by id, and the row says where each one lives.
 * Any write made from a row goes to every host in its group — which is also how a
 * group whose hosts have drifted apart gets put back in step: saving is the
 * reconcile, so there is no separate action for it.
 */
export function RulesPage() {
  const { t } = useTranslation();
  const { hosts, groups, isLoading, hasFailed, hasUsableHost, hasConnectedHost, retryFailed } =
    useAggregatedRules();
  const { saveRule, deleteRule, reorderRules } = useRuleHostMutations();
  const [form, setForm] = useState<FormState>({ kind: "closed" });
  const [isBusy, setIsBusy] = useState(false);

  const usableServerIds = useMemo(
    () => hosts.filter((host) => host.isConnected && host.isSupported).map((host) => host.serverId),
    [hosts],
  );
  const modalHosts = useMemo<RuleModalHost[]>(
    () =>
      hosts.map((host) => ({
        serverId: host.serverId,
        serverName: host.serverName,
        isUsable: host.isConnected && host.isSupported,
        unavailableMessageKey: resolveHostUnavailableMessageKey(host),
      })),
    [hosts],
  );
  const showHosts = hosts.length > 1;
  // Both come from one host: they describe the daemon build rather than the
  // machine, and a rule assigned to several is written identically to each.
  const { outcomes, examples } = useRuleCatalog(usableServerIds[0] ?? null);

  const handleOpenCreate = useCallback(() => {
    setForm({ kind: "create" });
  }, []);
  const handleOpenEdit = useCallback((group: RuleGroup) => {
    setForm({ kind: "edit", group });
  }, []);
  const handleOpenExample = useCallback((example: RuleExample) => {
    setForm({ kind: "example", example });
  }, []);
  const handleCloseForm = useCallback(() => {
    setForm({ kind: "closed" });
  }, []);

  const handleSave = useCallback(
    async (draft: RuleDraft, serverIds: readonly string[]) => {
      const existing = form.kind === "edit" ? form.group : null;
      const rule = applyRuleDraft({
        existing: existing?.rule ?? null,
        draft,
        id: existing?.id ?? generateRuleId(),
        descriptors: outcomes,
      });
      await saveRule({
        rule,
        currentServerIds: existing?.serverIds ?? [],
        // Empty only reaches here from a single-host setup, where the modal shows
        // no host field and there is exactly one place a rule can go.
        targetServerIds: serverIds.length > 0 ? serverIds : usableServerIds,
      });
    },
    [form, outcomes, saveRule, usableServerIds],
  );

  const handleRemove = useCallback(
    async (group: RuleGroup) => {
      const confirmed = await confirmDialog({
        title: t("settings.rules.removeConfirmTitle"),
        message: t("settings.rules.removeConfirmMessage", {
          rule: describeRule(group.rule, t),
        }),
        confirmLabel: t("settings.rules.remove"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      setIsBusy(true);
      try {
        await deleteRule({ ruleId: group.id, serverIds: group.serverIds });
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
    [deleteRule, t],
  );

  const handleMove = useCallback(
    async (group: RuleGroup, direction: "up" | "down") => {
      const nextOrder = moveRule(groups, group.id, direction);
      // Unchanged when the rule is already at the end it was moved towards, and
      // sending that would be a write and a broadcast that changed nothing.
      if (nextOrder.length === groups.length && nextOrder.every((id, i) => id === groups[i]?.id)) {
        return;
      }
      setIsBusy(true);
      try {
        await reorderRules({ ruleIds: nextOrder, serverIds: usableServerIds });
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [groups, reorderRules, t, usableServerIds],
  );

  const handleToggleRule = useCallback(
    async (group: RuleGroup, enabled: boolean) => {
      setIsBusy(true);
      try {
        await saveRule({
          rule: { ...group.rule, enabled },
          currentServerIds: group.serverIds,
          targetServerIds: group.serverIds,
        });
      } catch (error) {
        Alert.alert(
          t("common.errors.unableToSave"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsBusy(false);
      }
    },
    [saveRule, t],
  );

  const initialDraft = resolveInitialDraft(form);
  // A new rule starts on every host that can hold one, which is what someone with
  // three machines almost always means; unticking is one tap and re-ticking three.
  const initialServerIds = form.kind === "edit" ? form.group.serverIds : usableServerIds;

  const addButton = useMemo(
    () => (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={addIcon}
        onPress={handleOpenCreate}
        disabled={!hasUsableHost || isBusy}
        accessibilityLabel={t("settings.rules.addRule")}
        testID="rule-add"
      />
    ),
    [handleOpenCreate, hasUsableHost, isBusy, t],
  );

  // Whatever the state, the section header stays — unlike terminal profiles, which
  // returns before it and makes the screen look like it lost a setting rather than
  // like the setting is temporarily out of reach.
  const listState = resolveRulesListState({
    isConnected: hasConnectedHost,
    isSupported: hasUsableHost,
    // Same "any host" reading as the two above: a failure is worth the screen
    // only while it left nothing to show.
    hasFailed: hasFailed && groups.length === 0,
    // Loading only while nothing has arrived: once one host has answered its rules
    // are shown rather than held back for a slower machine.
    rules: isLoading && groups.length === 0 ? null : groups,
  });

  return (
    <SettingsSection
      title={t("settings.rules.sectionTitle")}
      trailing={addButton}
      testID="rules-section"
    >
      <View style={settingsStyles.card} testID="rules-enabled-card">
        {showHosts ? (
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.rules.featureToggleTitle")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.rules.sectionHint")}</Text>
            </View>
          </View>
        ) : null}
        {hosts.map((host, index) => (
          <RulesFeatureRow
            key={host.serverId}
            host={host}
            isOnlyHost={!showHosts}
            withBorder={showHosts || index > 0}
          />
        ))}
      </View>

      <View style={settingsStyles.card} testID="rules-card">
        {listState.kind === "rules" ? (
          groups.map((group, index) => (
            <RuleRow
              key={group.id}
              group={group}
              outcomeDescriptors={outcomes}
              isFirst={index === 0}
              isLast={index === groups.length - 1}
              showHosts={showHosts}
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
            {/* Only where asking again is the fix. Waiting out a reconnect and
                upgrading a daemon both resolve elsewhere, and a button that
                changes nothing is worse than none. */}
            {listState.kind === "failed" ? (
              <Button variant="ghost" size="sm" onPress={retryFailed} testID="rules-retry">
                {t("common.actions.retry")}
              </Button>
            ) : null}
          </View>
        )}
      </View>

      {examples.length > 0 ? (
        <View style={settingsStyles.card} testID="rules-examples-card">
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.rules.examplesTitle")}</Text>
              <Text style={settingsStyles.rowHint}>{t("settings.rules.examplesHint")}</Text>
            </View>
          </View>
          {examples.map((example) => (
            <RuleExampleRow
              key={example.id}
              example={example}
              withBorder
              disabled={!hasUsableHost || isBusy}
              onAdd={handleOpenExample}
            />
          ))}
        </View>
      ) : null}

      <RuleEditModal
        visible={form.kind !== "closed"}
        title={form.kind === "edit" ? t("settings.rules.editTitle") : t("settings.rules.addTitle")}
        // Keyed so the modal rebuilds its state when a different example is
        // picked: it reads initialDraft on open, and two examples in a row
        // would otherwise show the first one's fields.
        key={form.kind === "example" ? form.example.id : form.kind}
        initialDraft={initialDraft}
        hosts={modalHosts}
        initialServerIds={initialServerIds}
        outcomeDescriptors={outcomes}
        onClose={handleCloseForm}
        onSave={handleSave}
        testID="rule-modal"
      />
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Built from scratch rather than layered onto settingsStyles.row. That style is
  // a horizontal space-between row, and inheriting it while forcing a column is
  // what pushed the controls up over the hint text.
  row: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  // Text on the left, badges in the top right corner beside it. They stay on the
  // first line whatever the sentence wraps to, because they are a sibling of the
  // text block rather than part of it.
  rowText: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  textBlock: {
    flex: 1,
  },
  // Dimmed rather than hidden: a rule that is off still has to be findable, and
  // its position still matters for when it comes back.
  textBlockOff: {
    opacity: 0.5,
  },
  badges: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  // Which machines carry this rule. A line of text rather than a badge each,
  // because three host names in badges is most of a phone's width.
  hostLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  // Every control on one centred line under the text. The buttons carry their own
  // padding, so no gap between them is what reads as evenly spaced - the same
  // reason the terminal profiles actions use zero.
  rowControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
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
