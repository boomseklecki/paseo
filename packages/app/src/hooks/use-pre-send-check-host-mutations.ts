import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { queryClient } from "@/data/query-client";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  describePreSendCheckOutcomes,
  planPreSendCheckSave,
  type PreSendCheckHostOutcome,
} from "@/screens/settings/pre-send-check-groups";

export interface PreSendCheckFanOutMutations {
  /** Puts a rule on exactly `targetServerIds`, removing it from anywhere else it was. */
  saveRule: (input: {
    rule: PreSendCheckRule;
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
export function usePreSendCheckHostMutations(): PreSendCheckFanOutMutations {
  const { t } = useTranslation();
  const hosts = useHosts();

  /** Runs one write on each host and reports what each did. Never throws. */
  const runOnHosts = useCallback(
    async (
      serverIds: readonly string[],
      write: (client: HostWriteClient) => Promise<void>,
    ): Promise<PreSendCheckHostOutcome[]> =>
      Promise.all(
        serverIds.map(async (serverId): Promise<PreSendCheckHostOutcome> => {
          const serverName = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
          const client = resolveClient(serverId);
          if (!client) {
            return { serverId, serverName, error: t("settings.preSendChecks.hostUnreachable") };
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
    (outcomes: readonly PreSendCheckHostOutcome[]) => {
      const failure = describePreSendCheckOutcomes(outcomes, t);
      if (failure) {
        throw new Error(failure);
      }
    },
    [t],
  );

  const saveRule = useCallback<PreSendCheckFanOutMutations["saveRule"]>(
    async ({ rule, currentServerIds, targetServerIds }) => {
      const plan = planPreSendCheckSave({ currentServerIds, targetServerIds });
      // Both phases run before anything is reported. Removing the rule from a
      // deselected host failing is no reason to withhold the edit from the hosts
      // that were selected — that would turn one host being offline into an edit
      // that landed nowhere.
      const removed = await runOnHosts(plan.remove, async (client) => {
        applyResult(client.serverId, await client.preSendChecksDelete(rule.id));
      });
      const written = await runOnHosts(plan.write, async (client) => {
        applyResult(client.serverId, await client.preSendChecksUpsert(rule));
      });
      reportOutcomes([...removed, ...written]);
    },
    [reportOutcomes, runOnHosts],
  );

  const deleteRule = useCallback<PreSendCheckFanOutMutations["deleteRule"]>(
    async ({ ruleId, serverIds }) => {
      reportOutcomes(
        await runOnHosts(serverIds, async (client) => {
          applyResult(client.serverId, await client.preSendChecksDelete(ruleId));
        }),
      );
    },
    [reportOutcomes, runOnHosts],
  );

  const reorderRules = useCallback<PreSendCheckFanOutMutations["reorderRules"]>(
    async ({ ruleIds, serverIds }) => {
      // The merged order goes to every host unfiltered: the daemon skips ids it
      // does not have without advancing the position it is assigning, so each
      // host ends up with the merged arrangement restricted to its own rules.
      reportOutcomes(
        await runOnHosts(serverIds, async (client) => {
          applyResult(client.serverId, await client.preSendChecksReorder(ruleIds));
        }),
      );
    },
    [reportOutcomes, runOnHosts],
  );

  return { saveRule, deleteRule, reorderRules };
}

interface HostWriteClient {
  serverId: string;
  preSendChecksUpsert: (rule: PreSendCheckRule) => Promise<PreSendCheckWriteResult>;
  preSendChecksDelete: (ruleId: string) => Promise<PreSendCheckWriteResult>;
  preSendChecksReorder: (ruleIds: readonly string[]) => Promise<PreSendCheckWriteResult>;
}

interface PreSendCheckWriteResult {
  checks: PreSendCheckRule[];
  error?: string | null;
}

function resolveClient(serverId: string): HostWriteClient | null {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
  if (!client) {
    return null;
  }
  return {
    serverId,
    preSendChecksUpsert: (rule) => client.preSendChecksUpsert(rule),
    preSendChecksDelete: (ruleId) => client.preSendChecksDelete(ruleId),
    preSendChecksReorder: (ruleIds) => client.preSendChecksReorder(ruleIds),
  };
}

/**
 * Takes the authoritative list from a write response into that host's cache.
 *
 * The daemon reports a refused write in `error` rather than by failing the
 * request, so a response is not by itself a success and this throws instead of
 * caching a list the write never made it into.
 */
function applyResult(serverId: string, result: PreSendCheckWriteResult): void {
  if (result.error) {
    throw new Error(result.error);
  }
  queryClient.setQueryData(preSendChecksQueryKey(serverId), result.checks);
}
