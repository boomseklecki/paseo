import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  PreSendOutcomeDescriptor,
  PreSendCheckExample,
} from "@getpaseo/protocol/pre-send-checks/types";
import { useFetchQuery } from "@/data/query";
import { PRE_SEND_CHECKS_QUERY_PREFIX } from "@/data/pre-send-checks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface PreSendCheckCatalog {
  /** What the daemon can carry out, so the editor can offer it untaught. */
  outcomes: PreSendOutcomeDescriptor[];
  /** Rules the daemon suggests, none of them installed. */
  examples: PreSendCheckExample[];
}

const EMPTY: PreSendCheckCatalog = { outcomes: [], examples: [] };

/**
 * What one host offers, as opposed to what it has.
 *
 * A separate query from the rules rather than a wider one, even though all three
 * come from the same response. The rules query is a replica the composer reads
 * at send time and the push router writes to directly; widening its shape would
 * mean touching the send path to add a settings-screen feature, and the two have
 * nothing to do with each other.
 *
 * Outcomes and examples share this one because they answer the same question and
 * arrive in the same message — splitting them would be two round trips for one
 * screen. Neither changes unless the daemon does, so this is a plain fetch with
 * a long stale time rather than anything push-driven.
 */
export function usePreSendCheckCatalog(serverId: string | null): PreSendCheckCatalog {
  const { t } = useTranslation();

  const query = useFetchQuery({
    queryKey: [PRE_SEND_CHECKS_QUERY_PREFIX, "catalog", serverId],
    enabled: Boolean(serverId),
    // One object rather than a list: "value" also keeps the previous-data
    // placeholder off, which for a list shape would hand back a partial object.
    dataShape: "value",
    staleTimeMs: 5 * 60_000,
    queryFn: async () => {
      const client = serverId ? getHostRuntimeStore().getSnapshot(serverId)?.client : null;
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.preSendChecksList();
      // A daemon too old to describe either sends neither, and empty is what the
      // editor reads as "offer nothing" rather than "offer wrongly".
      return { outcomes: result.outcomes ?? [], examples: result.examples ?? [] };
    },
  });

  const data = query.data;
  return useMemo(() => data ?? EMPTY, [data]);
}
