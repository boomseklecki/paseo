export const RULES_QUERY_PREFIX = "rules";

/**
 * Deliberately a plain function of `serverId` and nothing else. The send-time
 * reader has to rebuild this key outside React, so anything derived from live
 * state — connection status, a host set — would put it out of reach and force a
 * prefix scan instead.
 */
export function rulesQueryKey(serverId: string | null) {
  return [RULES_QUERY_PREFIX, serverId] as const;
}
