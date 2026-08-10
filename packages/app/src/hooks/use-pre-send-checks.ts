import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { queryClient } from "@/data/query-client";
import { useReplicaQuery } from "@/data/query";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

interface UsePreSendChecksResult {
  /**
   * The current rules, or `null` when they have not been loaded — which callers
   * must read as "do not gate", never as "use a default".
   *
   * Safe to call outside a render and outside React: it reads the query cache
   * directly rather than a value captured at the last commit, so a rule that
   * arrived on a push between renders is already visible. That property is the
   * reason this is a function and not a value.
   */
  readRules: () => readonly PreSendCheckRule[] | null;
  isLoading: boolean;
}

/**
 * Holds a host's pre-send check rules for the composer to consult at send time.
 *
 * A replica query rather than a fetch query, for three reasons. `gcTime: Infinity`
 * keeps the rules resident even while no screen displays them, which matters
 * because nothing displays them at all yet. The daemon pushes on change, so there
 * is nothing to poll for. And a fetch query would carry `keepPreviousData`, which
 * on a host switch hands host B the rules of host A — briefly gating sends on one
 * machine with another machine's rules, the one failure mode worse than missing a
 * gate.
 */
export function usePreSendChecks(serverId: string | null): UsePreSendChecksResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supported = useHostFeature(serverId, "preSendChecks");
  const queryKey = useMemo(() => preSendChecksQueryKey(serverId), [serverId]);

  const checksQuery = useReplicaQuery({
    queryKey,
    // An older daemon has no handler for the verb, so the request would never be
    // answered. Not asking is the whole of the back-compat story.
    enabled: Boolean(serverId && client && isConnected && supported),
    pushEvent: "status:pre_send_checks_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.preSendChecksList();
      return result.checks;
    },
  });

  const readRules = useCallback((): readonly PreSendCheckRule[] | null => {
    // Checked here as well as in `enabled` on purpose. `gcTime: Infinity` means a
    // daemon that was downgraded mid-session leaves its rules sitting in the cache,
    // and gating sends on rules the daemon no longer serves would be acting on a
    // config that is no longer live anywhere.
    if (!supported) {
      return null;
    }
    return queryClient.getQueryData<readonly PreSendCheckRule[]>(queryKey) ?? null;
  }, [queryKey, supported]);

  return { readRules, isLoading: checksQuery.isLoading };
}
