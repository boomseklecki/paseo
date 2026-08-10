import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { queryClient } from "@/data/query-client";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

interface UsePreSendCheckMutationsResult {
  upsertCheck: (check: PreSendCheckRule) => Promise<void>;
  deleteCheck: (ruleId: string) => Promise<void>;
  reorderChecks: (ruleIds: readonly string[]) => Promise<void>;
}

/**
 * Writes rules to one host and keeps the local cache in step.
 *
 * Deliberately thinner than `use-schedule-mutations`, which carries optimistic
 * snapshot-and-restore for its three instant actions. Nothing here is instant —
 * every write is a form submit or a confirmed delete, both of which already show
 * pending state — and both responses carry the authoritative list, so there is
 * nothing to guess at and nothing to roll back.
 *
 * Errors are rethrown rather than swallowed: the modal shows a failed save
 * inline, and the delete path reports its own. A mutation layer that logged and
 * returned would leave the caller thinking it had succeeded.
 */
export function usePreSendCheckMutations(serverId: string | null): UsePreSendCheckMutationsResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");

  const applyChecks = useCallback(
    (checks: PreSendCheckRule[]) => {
      queryClient.setQueryData(preSendChecksQueryKey(serverId), checks);
    },
    [serverId],
  );

  const upsertCheck = useCallback(
    async (check: PreSendCheckRule) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.preSendChecksUpsert(check);
      // The daemon reports a refused write in `error` rather than by failing the
      // request, so a response is not by itself a success.
      if (result.error) {
        throw new Error(result.error);
      }
      applyChecks(result.checks);
    },
    [applyChecks, client, t],
  );

  const deleteCheck = useCallback(
    async (ruleId: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.preSendChecksDelete(ruleId);
      if (result.error) {
        throw new Error(result.error);
      }
      applyChecks(result.checks);
    },
    [applyChecks, client, t],
  );

  const reorderChecks = useCallback(
    async (ruleIds: readonly string[]) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.preSendChecksReorder(ruleIds);
      if (result.error) {
        throw new Error(result.error);
      }
      applyChecks(result.checks);
    },
    [applyChecks, client, t],
  );

  return { upsertCheck, deleteCheck, reorderChecks };
}
