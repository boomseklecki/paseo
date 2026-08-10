export const PRE_SEND_CHECKS_QUERY_PREFIX = "pre-send-checks";

/**
 * Deliberately a plain function of `serverId` and nothing else. The send-time
 * reader has to rebuild this key outside React, so anything derived from live
 * state — connection status, a host set — would put it out of reach and force a
 * prefix scan instead.
 */
export function preSendChecksQueryKey(serverId: string | null) {
  return [PRE_SEND_CHECKS_QUERY_PREFIX, serverId] as const;
}
