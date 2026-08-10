/**
 * @vitest-environment jsdom
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { queryClient } from "@/data/query-client";
import { preSendChecksQueryKey } from "@/data/pre-send-checks";
import { usePreSendChecks } from "./use-pre-send-checks";

const preSendChecksList = vi.fn(async () => ({ requestId: "r", checks: RULES, error: null }));
let supported = true;
let connected = true;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => supported,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => ({
    preSendChecksList: () => preSendChecksList(),
  }),
  useHostRuntimeIsConnected: () => connected,
}));

const RULES: PreSendCheckRule[] = [
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

beforeEach(() => {
  supported = true;
  connected = true;
  preSendChecksList.mockClear();
  queryClient.removeQueries({ queryKey: preSendChecksQueryKey(SERVER_ID) });
});

afterEach(() => {
  queryClient.removeQueries({ queryKey: preSendChecksQueryKey(SERVER_ID) });
});

describe("usePreSendChecks", () => {
  // The regression pin for the deleted resolver. It used to map "nothing loaded"
  // onto the shipped blocking rule, which meant a gate could fire while it had no
  // idea what the rules were. `null` here is what keeps the composer failing open.
  it("reads null before anything has loaded, not a default rule", () => {
    connected = false;
    const { result } = renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });

    expect(result.current.readRules()).toBeNull();
  });

  it("reads the rules the daemon served", async () => {
    const { result } = renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });

    await waitFor(() => expect(result.current.readRules()).toEqual(RULES));
  });

  // The property that justifies reading the cache rather than a ref: a push that
  // lands between renders is in effect immediately, with no commit in between.
  it("sees a pushed update without waiting for a rerender", async () => {
    const { result } = renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });
    await waitFor(() => expect(result.current.readRules()).toEqual(RULES));

    const next: PreSendCheckRule[] = [{ ...RULES[0]!, threshold: 60 }];
    queryClient.setQueryData(preSendChecksQueryKey(SERVER_ID), next);

    expect(result.current.readRules()).toEqual(next);
  });

  it("treats an empty list as rules deliberately turned off", async () => {
    preSendChecksList.mockResolvedValueOnce({ requestId: "r", checks: [], error: null });
    const { result } = renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });

    await waitFor(() => expect(result.current.readRules()).toEqual([]));
  });

  it("never calls a daemon that does not advertise the feature", async () => {
    supported = false;
    renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(preSendChecksList).not.toHaveBeenCalled();
  });

  // gcTime is Infinity, so a downgrade mid-session leaves the old rules sitting in
  // the cache. Gating on rules the daemon no longer serves would be acting on a
  // config that is live nowhere.
  it("ignores cached rules once the feature disappears", () => {
    queryClient.setQueryData(preSendChecksQueryKey(SERVER_ID), RULES);
    supported = false;

    const { result } = renderHook(() => usePreSendChecks(SERVER_ID), { wrapper });

    expect(result.current.readRules()).toBeNull();
  });
});
