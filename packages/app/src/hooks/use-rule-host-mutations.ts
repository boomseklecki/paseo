import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { queryClient } from "@/data/query-client";
import { rulesQueryKey } from "@/data/rules";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  describeRuleOutcomes,
  planRuleSave,
  type RuleHostOutcome,
} from "@/screens/settings/rule-groups";

export interface RuleFanOutMutations {
  /** Puts a rule on exactly `targetServerIds`, removing it from anywhere else it was. */
  saveRule: (input: {
    rule: Rule;
    currentServerIds: readonly string[];
    targetServerIds: readonly string[];
  }) => Promise<void>;
  deleteRule: (input: { ruleId: string; serverIds: readonly string[] }) => Promise<void>;
  reorderRules: (input: {
    ruleIds: readonly string[];
    serverIds: readonly string[];
  }) => Promise<void>;
}

/**
 * The same write, sent to several daemons.
 *
 * There is no transaction across hosts and there cannot be one, so every verb
 * here runs each host independently, keeps going when one fails, and rejects at
 * the end with a message naming what happened where. Rolling the successes back
 * was the alternative and it is worse: the rollback can fail too, and then the
 * state is neither what was asked for nor what was there before.
 *
 * Clients are resolved per call from the runtime store rather than through a
 * hook, because the host set is an argument here and hooks cannot be counted per
 * argument.
 */
export function useRuleHostMutations(): RuleFanOutMutations {
  const { t } = useTranslation();
  const hosts = useHosts();

  /** Runs one write on each host and reports what each did. Never throws. */
  const runOnHosts = useCallback(
    async (
      serverIds: readonly string[],
      write: (client: HostWriteClient) => Promise<void>,
    ): Promise<RuleHostOutcome[]> =>
      Promise.all(
        serverIds.map(async (serverId): Promise<RuleHostOutcome> => {
          const serverName = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
          const client = resolveClient(serverId);
          if (!client) {
            return { serverId, serverName, error: t("settings.rules.hostUnreachable") };
          }
          try {
            await write(client);
            return { serverId, serverName, error: null };
          } catch (error) {
            return {
              serverId,
              serverName,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      ),
    [hosts, t],
  );

  const reportOutcomes = useCallback(
    (outcomes: readonly RuleHostOutcome[]) => {
      const failure = describeRuleOutcomes(outcomes, t);
      if (failure) {
        throw new Error(failure);
      }
    },
    [t],
  );

  const saveRule = useCallback<RuleFanOutMutations["saveRule"]>(
    async ({ rule, currentServerIds, targetServerIds }) => {
      const plan = planRuleSave({ currentServerIds, targetServerIds });
      // Both phases run before anything is reported. Removing the rule from a
      // deselected host failing is no reason to withhold the edit from the hosts
      // that were selected — that would turn one host being offline into an edit
      // that landed nowhere.
      const removed = await runOnHosts(plan.remove, async (client) => {
        applyResult(client.serverId, await client.rulesDelete(rule.id));
      });
      const written = await runOnHosts(plan.write, async (client) => {
        applyResult(client.serverId, await client.rulesUpsert(rule));
      });
      reportOutcomes([...removed, ...written]);
    },
    [reportOutcomes, runOnHosts],
  );

  const deleteRule = useCallback<RuleFanOutMutations["deleteRule"]>(
    async ({ ruleId, serverIds }) => {
      reportOutcomes(
        await runOnHosts(serverIds, async (client) => {
          applyResult(client.serverId, await client.rulesDelete(ruleId));
        }),
      );
    },
    [reportOutcomes, runOnHosts],
  );

  const reorderRules = useCallback<RuleFanOutMutations["reorderRules"]>(
    async ({ ruleIds, serverIds }) => {
      // The merged order goes to every host unfiltered: the daemon skips ids it
      // does not have without advancing the position it is assigning, so each
      // host ends up with the merged arrangement restricted to its own rules.
      reportOutcomes(
        await runOnHosts(serverIds, async (client) => {
          applyResult(client.serverId, await client.rulesReorder(ruleIds));
        }),
      );
    },
    [reportOutcomes, runOnHosts],
  );

  return { saveRule, deleteRule, reorderRules };
}

interface HostWriteClient {
  serverId: string;
  rulesUpsert: (rule: Rule) => Promise<RuleWriteResult>;
  rulesDelete: (ruleId: string) => Promise<RuleWriteResult>;
  rulesReorder: (ruleIds: readonly string[]) => Promise<RuleWriteResult>;
}

interface RuleWriteResult {
  checks: Rule[];
  error?: string | null;
}

function resolveClient(serverId: string): HostWriteClient | null {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
  if (!client) {
    return null;
  }
  return {
    serverId,
    rulesUpsert: (rule) => client.rulesUpsert(rule),
    rulesDelete: (ruleId) => client.rulesDelete(ruleId),
    rulesReorder: (ruleIds) => client.rulesReorder(ruleIds),
  };
}

/**
 * Takes the authoritative list from a write response into that host's cache.
 *
 * The daemon reports a refused write in `error` rather than by failing the
 * request, so a response is not by itself a success and this throws instead of
 * caching a list the write never made it into.
 */
function applyResult(serverId: string, result: RuleWriteResult): void {
  if (result.error) {
    throw new Error(result.error);
  }
  queryClient.setQueryData(rulesQueryKey(serverId), result.checks);
}
