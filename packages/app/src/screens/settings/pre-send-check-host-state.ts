/**
 * What a host can say about rules, resolved once for everything that asks.
 *
 * Its own module rather than three functions inside the page, because three
 * surfaces read the same two booleans — the card, the per-host switch and the
 * modal's host list — and a copy of the decision in each is how they drift.
 * Nothing here touches React, so it is also the part that can be tested.
 */

export type PreSendChecksListState =
  | { kind: "unavailable"; messageKey: string }
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "rules" };

/**
 * Why one host cannot hold a rule, or null when it can.
 *
 * The reason has to be per host and not per fleet. The card's inputs are "any
 * host", so the moment one machine answers the card says nothing at all — and a
 * mixed fleet, one fork daemon and one stock, is exactly the arrangement where
 * that happens and where the disabled switch beside it is the thing needing an
 * explanation.
 *
 * Disconnected is checked first because it is the one that resolves on its own.
 * A host that is both offline and too old is worth waiting for before it is
 * worth upgrading.
 */
export function resolveHostUnavailableMessageKey(input: {
  isConnected: boolean;
  isSupported: boolean;
}): string | null {
  if (!input.isConnected) {
    return "settings.preSendChecks.unavailableDisconnected";
  }
  if (!input.isSupported) {
    return "settings.preSendChecks.unavailableUnsupported";
  }
  return null;
}

/**
 * What the card shows.
 *
 * The two unavailable reasons are kept apart deliberately — waiting for a
 * reconnect is a matter of time, an old daemon is a matter of upgrading, and one
 * message for both would leave someone waiting for a state that will not arrive.
 *
 * Across several hosts each input is "any host": one machine being offline is not
 * a reason to hide rules the others answered with.
 */
export function resolvePreSendChecksListState(input: {
  isConnected: boolean;
  isSupported: boolean;
  rules: readonly { id: string }[] | null;
}): PreSendChecksListState {
  const unavailable = resolveHostUnavailableMessageKey(input);
  if (unavailable) {
    return { kind: "unavailable", messageKey: unavailable };
  }
  if (!input.rules) {
    return { kind: "loading" };
  }
  return input.rules.length === 0 ? { kind: "empty" } : { kind: "rules" };
}

export function listStateMessageKey(state: PreSendChecksListState): string {
  switch (state.kind) {
    case "unavailable":
      return state.messageKey;
    case "loading":
      return "settings.preSendChecks.loading";
    default:
      return "settings.preSendChecks.emptyState";
  }
}
