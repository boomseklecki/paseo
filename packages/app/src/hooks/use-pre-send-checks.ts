import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { queryClient } from "@/data/query-client";
import { useReplicaQuery } from "@/data/query";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { hostSupportsFeature, useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

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
  /**
   * The same rules as a rendered value, for a screen that lists them. `null`
   * means what it means in `readRules`: not loaded, or a host that does not serve
   * them — never "there are none", which is `[]`.
   */
  rules: readonly PreSendCheckRule[] | null;
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
    pushEvent: "status:rules_changed",
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

  return {
    readRules,
    rules: supported ? (checksQuery.data ?? null) : null,
    isLoading: checksQuery.isLoading,
  };
}

/**
 * True when this host cannot run rules and some other host in this session can.
 *
 * The gate fails open, and deliberately: a rule that cannot be read must not
 * hold a send back. What it should not do is fail open in silence, because a
 * rule reads as a policy and is a per-host file — "block a send over 80%
 * context" is true on the machine you wrote it on and quietly false on the one
 * you are typing into.
 *
 * The claim is only ever about this host. The second half is a relevance filter
 * rather than part of it: on a fleet where nothing serves rules there was
 * nothing to expect, and a marker would be noise above every send anyone ever
 * makes. That is also why it is indifferent to whether the other host is
 * connected right now — having seen one this session is enough to establish
 * that rules are something this person uses, and a fork host being briefly
 * offline does not make the stock host's silence less worth saying.
 *
 * Connectivity of *this* host is required, though. A disconnected host reports
 * no features, which is not the same claim as a host that answered and does not
 * have them.
 */
export function usePreSendChecksHostGap(serverId: string | null): boolean {
  const normalizedServerId = serverId?.trim() ?? "";
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const supportedHere = useHostFeature(normalizedServerId, "preSendChecks");
  const supportedElsewhere = useSessionStore((state) =>
    Object.entries(state.sessions).some(
      ([otherServerId, session]) =>
        otherServerId !== normalizedServerId &&
        hostSupportsFeature(session?.serverInfo, "preSendChecks"),
    ),
  );

  return Boolean(normalizedServerId) && isConnected && !supportedHere && supportedElsewhere;
}
