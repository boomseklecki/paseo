/**
 * @vitest-environment jsdom
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { queryClient } from "@/data/query-client";
import { rulesQueryKey } from "@/data/rules";
import { useRules, useRulesHostGap } from "./use-rules";

const rulesList = vi.fn(async () => ({ requestId: "r", checks: RULES, error: null }));
let supported = true;
let connected = true;
let sessions: Record<string, { serverInfo: unknown } | undefined> = {};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Only `useHostFeature` is faked, so the tests can say what this host answers
// without building a session for it. `hostSupportsFeature` stays real, because it
// is what the gap hook asks about every *other* host and its reading of the
// feature map is the thing under test.
vi.mock("@/runtime/host-features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/host-features")>()),
  useHostFeature: () => supported,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: { sessions: typeof sessions }) => unknown) =>
    selector({ sessions }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    rulesList: () => rulesList(),
  }),
  useHostRuntimeIsConnected: () => connected,
}));

const RULES: Rule[] = [
  {
    id: "cold-prompt-cache",
    measurement: "agent.idleSeconds",
    operator: "gte",
    threshold: 3600,
    disposition: "block",
  },
];

const SERVER_ID = "srv-test";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function session(rules: boolean) {
  return { serverInfo: { features: { rules } } };
}

beforeEach(() => {
  supported = true;
  connected = true;
  sessions = {};
  rulesList.mockClear();
  queryClient.removeQueries({ queryKey: rulesQueryKey(SERVER_ID) });
});

afterEach(() => {
  queryClient.removeQueries({ queryKey: rulesQueryKey(SERVER_ID) });
});

describe("useRules", () => {
  // The regression pin for the deleted resolver. It used to map "nothing loaded"
  // onto the shipped blocking rule, which meant a gate could fire while it had no
  // idea what the rules were. `null` here is what keeps the composer failing open.
  it("reads null before anything has loaded, not a default rule", () => {
    connected = false;
    const { result } = renderHook(() => useRules(SERVER_ID), { wrapper });

    expect(result.current.readRules()).toBeNull();
  });

  it("reads the rules the daemon served", async () => {
    const { result } = renderHook(() => useRules(SERVER_ID), { wrapper });

    await waitFor(() => expect(result.current.readRules()).toEqual(RULES));
  });

  // The property that justifies reading the cache rather than a ref: a push that
  // lands between renders is in effect immediately, with no commit in between.
  it("sees a pushed update without waiting for a rerender", async () => {
    const { result } = renderHook(() => useRules(SERVER_ID), { wrapper });
    await waitFor(() => expect(result.current.readRules()).toEqual(RULES));

    const next: Rule[] = [{ ...RULES[0]!, threshold: 60 }];
    queryClient.setQueryData(rulesQueryKey(SERVER_ID), next);

    expect(result.current.readRules()).toEqual(next);
  });

  it("treats an empty list as rules deliberately turned off", async () => {
    rulesList.mockResolvedValueOnce({ requestId: "r", checks: [], error: null });
    const { result } = renderHook(() => useRules(SERVER_ID), { wrapper });

    await waitFor(() => expect(result.current.readRules()).toEqual([]));
  });

  it("never calls a daemon that does not advertise the feature", async () => {
    supported = false;
    renderHook(() => useRules(SERVER_ID), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rulesList).not.toHaveBeenCalled();
  });

  // gcTime is Infinity, so a downgrade mid-session leaves the old rules sitting in
  // the cache. Gating on rules the daemon no longer serves would be acting on a
  // config that is live nowhere.
  it("ignores cached rules once the feature disappears", () => {
    queryClient.setQueryData(rulesQueryKey(SERVER_ID), RULES);
    supported = false;

    const { result } = renderHook(() => useRules(SERVER_ID), { wrapper });

    expect(result.current.readRules()).toBeNull();
  });
});

describe("useRulesHostGap", () => {
  it("reports the gap when this host cannot gate and another host can", () => {
    supported = false;
    sessions = { [SERVER_ID]: session(false), "srv-fork": session(true) };

    const { result } = renderHook(() => useRulesHostGap(SERVER_ID), { wrapper });

    expect(result.current).toBe(true);
  });

  it("says nothing on a fleet where no host serves rules", () => {
    supported = false;
    sessions = { [SERVER_ID]: session(false), "srv-other": session(false) };

    const { result } = renderHook(() => useRulesHostGap(SERVER_ID), { wrapper });

    expect(result.current).toBe(false);
  });

  it("says nothing while this host gates sends itself", () => {
    supported = true;
    sessions = { [SERVER_ID]: session(true), "srv-fork": session(true) };

    const { result } = renderHook(() => useRulesHostGap(SERVER_ID), { wrapper });

    expect(result.current).toBe(false);
  });

  // A disconnected host reports no features, which is silence rather than an
  // answer. Claiming its rules do not run would be inventing the half of the
  // sentence nobody has heard yet.
  it("says nothing while this host is disconnected", () => {
    supported = false;
    connected = false;
    sessions = { [SERVER_ID]: session(false), "srv-fork": session(true) };

    const { result } = renderHook(() => useRulesHostGap(SERVER_ID), { wrapper });

    expect(result.current).toBe(false);
  });

  it("says nothing when no host is selected", () => {
    supported = false;
    sessions = { "srv-fork": session(true) };

    const { result } = renderHook(() => useRulesHostGap(null), { wrapper });

    expect(result.current).toBe(false);
  });
});
