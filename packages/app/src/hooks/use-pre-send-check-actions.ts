import { useTranslation } from "react-i18next";
import type { PreSendActionDescriptor } from "@getpaseo/protocol/pre-send-checks/types";
import { useFetchQuery } from "@/data/query";
import { PRE_SEND_CHECKS_QUERY_PREFIX } from "@/data/pre-send-checks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * What one host says its actions are.
 *
 * A separate query from the rules rather than a wider one, even though both come
 * from the same response. The rules query is a replica the composer reads at
 * send time and the push router writes to directly; widening its shape would
 * mean touching the send path to add a settings-screen feature, and the two have
 * nothing to do with each other.
 *
 * Descriptors change only when the daemon does, so this is a plain fetch with a
 * long stale time rather than anything push-driven.
 */
export function usePreSendCheckActions(serverId: string | null): PreSendActionDescriptor[] {
  const { t } = useTranslation();

  const query = useFetchQuery({
    queryKey: [PRE_SEND_CHECKS_QUERY_PREFIX, "actions", serverId],
    enabled: Boolean(serverId),
    dataShape: "list",
    staleTimeMs: 5 * 60_000,
    queryFn: async () => {
      const client = serverId ? getHostRuntimeStore().getSnapshot(serverId)?.client : null;
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const result = await client.preSendChecksList();
      // A daemon too old to describe its actions sends none, and an empty list
      // is what the editor reads as "offer nothing" rather than "offer wrongly".
      return result.actions ?? [];
    },
  });

  return query.data ?? [];
}
