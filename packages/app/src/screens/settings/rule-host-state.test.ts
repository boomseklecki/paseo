import { describe, expect, it } from "vitest";
import {
  listStateMessageKey,
  resolveHostUnavailableMessageKey,
  resolveRulesListState,
} from "./rule-host-state";

const DISCONNECTED = "settings.rules.unavailableDisconnected";
const UNSUPPORTED = "settings.rules.unavailableUnsupported";

describe("resolveHostUnavailableMessageKey", () => {
  it("says nothing about a host that can hold rules", () => {
    expect(resolveHostUnavailableMessageKey({ isConnected: true, isSupported: true })).toBeNull();
  });

  it("separates waiting for a reconnect from needing an upgrade", () => {
    expect(resolveHostUnavailableMessageKey({ isConnected: false, isSupported: true })).toBe(
      DISCONNECTED,
    );
    expect(resolveHostUnavailableMessageKey({ isConnected: true, isSupported: false })).toBe(
      UNSUPPORTED,
    );
  });

  // An offline host reports no features, so every disconnected host also looks
  // unsupported. Telling someone to upgrade a machine that is merely asleep sends
  // them after the wrong thing.
  it("asks for a reconnect before an upgrade when it cannot tell", () => {
    expect(resolveHostUnavailableMessageKey({ isConnected: false, isSupported: false })).toBe(
      DISCONNECTED,
    );
  });
});

describe("resolveRulesListState", () => {
  it("carries the host's own reason when it is unavailable", () => {
    expect(
      resolveRulesListState({
        isConnected: true,
        isSupported: false,
        hasFailed: false,
        rules: [],
      }),
    ).toEqual({ kind: "unavailable", messageKey: UNSUPPORTED });
  });

  // The distinction the whole feature rests on: a host that has not answered is
  // not a host holding nothing, and a save driven by the second reading would
  // delete the rules of the first.
  it("keeps not-yet-answered apart from answered-with-nothing", () => {
    expect(
      resolveRulesListState({
        isConnected: true,
        isSupported: true,
        hasFailed: false,
        rules: null,
      }),
    ).toEqual({ kind: "loading" });
    expect(
      resolveRulesListState({
        isConnected: true,
        isSupported: true,
        hasFailed: false,
        rules: [],
      }),
    ).toEqual({ kind: "empty" });
  });

  // Both leave the rules unread, so nothing in the data separates them. Read as
  // loading, a failure waits for an answer that already came.
  it("keeps a failed answer apart from no answer yet", () => {
    expect(
      resolveRulesListState({
        isConnected: true,
        isSupported: true,
        hasFailed: true,
        rules: null,
      }),
    ).toEqual({ kind: "failed" });
  });

  it("shows the list once a host answers with rules", () => {
    expect(
      resolveRulesListState({
        isConnected: true,
        isSupported: true,
        hasFailed: false,
        rules: [{ id: "a" }],
      }),
    ).toEqual({ kind: "rules" });
  });
});

describe("listStateMessageKey", () => {
  it("passes the unavailable reason through rather than flattening it", () => {
    expect(listStateMessageKey({ kind: "unavailable", messageKey: DISCONNECTED })).toBe(
      DISCONNECTED,
    );
  });

  it("names loading, failed and empty apart", () => {
    expect(listStateMessageKey({ kind: "loading" })).toBe("settings.rules.loading");
    expect(listStateMessageKey({ kind: "failed" })).toBe("settings.rules.loadFailed");
    expect(listStateMessageKey({ kind: "empty" })).toBe("settings.rules.emptyState");
  });
});
