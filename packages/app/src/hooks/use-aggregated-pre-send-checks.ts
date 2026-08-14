import { useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { useReplicaQueries } from "@/data/query";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import {
  groupPreSendCheckRules,
  type PreSendCheckGroup,
  type PreSendCheckHostRules,
} from "@/screens/settings/pre-send-check-groups";

export interface PreSendCheckHostState extends PreSendCheckHostRules {
  isConnected: boolean;
  isSupported: boolean;
  /** Asked, and has not answered yet. */
  isLoading: boolean;
  /** Asked, and the answer was a failure. */
  hasFailed: boolean;
}

export interface AggregatedPreSendChecks {
  /** Every known host, in registry order, whether or not it could answer. */
  hosts: PreSendCheckHostState[];
  /** One entry per distinct rule id across the hosts that answered. */
  groups: PreSendCheckGroup[];
  /** True while at least one host that should answer has not yet. */
  isLoading: boolean;
  /** True when at least one host that was asked answered with a failure. */
  hasFailed: boolean;
  /** True when some host is connected and serving the verbs. */
  hasUsableHost: boolean;
  /** True when at least one host is connected, whatever its version. */
  hasConnectedHost: boolean;
  /** Ask the hosts whose list failed again. */
  retryFailed: () => void;
}

/**
 * Each host's connection status, read from the store on every render.
 *
 * Not `useHostRuntimeConnectionStatuses`. That hook memoizes its map against the
 * store's aggregate version counter, and the counter does not move for every
 * transition the snapshot records — a host that came online during a page load
 * was still reported as `connecting` minutes later, with the store's own snapshot
 * saying `online` the whole time. Gating a settings screen on that means the rules
 * never appear.
 *
 * `useSyncExternalStore` re-reads on every render as well as on every
 * notification, so the value cannot lag behind the snapshot it is derived from.
 * The joined string is what makes that safe: React compares it by value, so
 * re-reading costs a string compare rather than a re-render. This is the same
 * conclusion `fetchAggregatedSchedules` reached from the other direction, where
 * connectivity is re-checked at execution time rather than taken from the map.
 */
function useLiveConnectionStatuses(serverIds: readonly string[]): ReadonlyMap<string, string> {
  const store = getHostRuntimeStore();
  const read = () =>
    serverIds
      .map(
        (serverId) =>
          `${serverId}=${store.getSnapshot(serverId)?.connectionStatus ?? "connecting"}`,
      )
      .join("|");
  const key = useSyncExternalStore((onChange) => store.subscribeAll(onChange), read, read);
  return useMemo(
    () => new Map(key ? key.split("|").map((entry) => entry.split("=") as [string, string]) : []),
    [key],
  );
}

/**
 * Every host's rules at once, for the screen that edits them.
 *
 * One replica query per host, on the same key the per-host hook and the push
 * router already use — so this shares their cache entries rather than opening a
 * second copy, and a rule changed on any host arrives here on that host's push
 * without anything being refetched. That is the reason this is not modelled on
 * `fetchAggregatedSchedules`, which fans out inside a single query because
 * schedules have no push to hang a per-host replica on.
 *
 * Clients are resolved inside the query function rather than through a hook, so
 * the host set can change without changing how many hooks run.
 */
export function useAggregatedPreSendChecks(): AggregatedPreSendChecks {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useLiveConnectionStatuses(serverIds);
  const features = useHostFeatureMap(serverIds, "preSendChecks");

  const queries = useReplicaQueries<readonly PreSendCheckRule[]>(
    hosts.map((host) => ({
      queryKey: preSendChecksQueryKey(host.serverId),
      // Same reason as the single-host hook: an older daemon has no handler for
      // the verb, so the request would never be answered. Not asking is the whole
      // of the back-compat story.
      enabled: statuses.get(host.serverId) === "online" && features.get(host.serverId) === true,
      pushEvent: "status:rules_changed",
      queryFn: async () => {
        const client = getHostRuntimeStore().getSnapshot(host.serverId)?.client;
        if (!client) {
          throw new Error(t("workspace.terminal.hostDisconnected"));
        }
        const result = await client.preSendChecksList();
        return result.checks;
      },
    })),
  );

  // Not memoized. `useQueries` hands back a fresh array on every render, so any
  // dependency list containing it would rebuild anyway — and a memo that never
  // holds is worse than none, because it reads as though it did.
  const hostStates: PreSendCheckHostState[] = hosts.map((host, index) => {
    const isConnected = statuses.get(host.serverId) === "online";
    const isSupported = features.get(host.serverId) === true;
    const wasAsked = isConnected && isSupported;
    const status = queries[index]?.status;
    return {
      serverId: host.serverId,
      serverName: host.label,
      isConnected,
      isSupported,
      // From the query's own status rather than from the absence of data. Both
      // states leave `rules` null, so reading loading off the data cannot tell a
      // host that has not answered from one that answered with a failure — and
      // with a single capable host, which is what a fork-plus-stock fleet is, the
      // second reads as the first forever.
      isLoading: wasAsked && status === "pending",
      hasFailed: wasAsked && status === "error",
      // Anything short of a host that answered is `null`, never `[]`: a host that
      // has not said what it holds must not read as a host holding nothing, which
      // is what would let a save delete a rule off it.
      rules: wasAsked ? (queries[index]?.data ?? null) : null,
    };
  });

  return {
    hosts: hostStates,
    groups: groupPreSendCheckRules(hostStates),
    isLoading: hostStates.some((host) => host.isLoading),
    hasFailed: hostStates.some((host) => host.hasFailed),
    hasUsableHost: hostStates.some((host) => host.isConnected && host.isSupported),
    hasConnectedHost: hostStates.some((host) => host.isConnected),
    retryFailed: () => {
      for (const query of queries) {
        if (query.status === "error") void query.refetch();
      }
    },
  };
}
