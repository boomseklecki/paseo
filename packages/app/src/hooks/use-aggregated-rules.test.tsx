/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Rule } from "@getpaseo/protocol/rules/types";
import { useAggregatedRules } from "./use-aggregated-rules";

interface FakeHost {
  serverId: string;
  label: string;
  connectionStatus: string;
  supported: boolean;
  list: () => Promise<{ checks: Rule[] }>;
}

let hosts: FakeHost[] = [];

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeatureMap: (serverIds: readonly string[]) =>
    new Map(
      serverIds.map((serverId) => [
        serverId,
        hosts.find((host) => host.serverId === serverId)?.supported === true,
      ]),
    ),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => hosts.map(({ serverId, label }) => ({ serverId, label })),
  useHostRuntimeConnectionStatuses: (serverIds: readonly string[]) =>
    new Map(
      serverIds.map((serverId) => [
        serverId,
        hosts.find((entry) => entry.serverId === serverId)?.connectionStatus ?? "connecting",
      ]),
    ),
  getHostRuntimeStore: () => ({
    subscribeAll: () => () => undefined,
    getSnapshot: (serverId: string) => {
      const host = hosts.find((entry) => entry.serverId === serverId);
      if (!host) return undefined;
      return {
        connectionStatus: host.connectionStatus,
        client: { rulesList: host.list },
      };
    },
  }),
}));

const RULE: Rule = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

function makeHost(overrides: Partial<FakeHost> & { serverId: string }): FakeHost {
  return {
    label: overrides.serverId,
    connectionStatus: "online",
    supported: true,
    list: async () => ({ checks: [RULE] }),
    ...overrides,
  };
}

// Retries off, so a failure is a failure on the first answer rather than a
// minute of backoff. What is under test is how the hook reads the status, not
// how many times the query is willing to ask.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  hosts = [];
});

describe("useAggregatedRules", () => {
  // The mixed fleet this exists for: one host that can hold rules, and it fails.
  // Read off the absence of data, that host stays "loading" for as long as the
  // screen is open, with nothing to retry and nothing saying anything is wrong.
  it("reports a failed list rather than waiting on it forever", async () => {
    hosts = [
      makeHost({ serverId: "srv-fork", list: async () => Promise.reject(new Error("nope")) }),
    ];

    const { result } = renderHook(() => useAggregatedRules(), { wrapper });

    await waitFor(() => expect(result.current.hasFailed).toBe(true));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.groups).toEqual([]);
    // Still null, not `[]` — a host that failed has not said it holds nothing.
    expect(result.current.hosts[0]?.rules).toBeNull();
  });

  it("keeps the rules a working host answered while another one fails", async () => {
    hosts = [
      makeHost({ serverId: "srv-fork" }),
      makeHost({ serverId: "srv-other", list: async () => Promise.reject(new Error("nope")) }),
    ];

    const { result } = renderHook(() => useAggregatedRules(), { wrapper });

    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.hasFailed).toBe(true);
    expect(result.current.hosts.map((entry) => entry.hasFailed)).toEqual([false, true]);
  });

  // A host nobody asked is not a host that has not answered. Counting it as
  // loading is what would pin a stock-only fleet on the loading message.
  it("counts neither loading nor failure against a host that was never asked", async () => {
    hosts = [
      makeHost({ serverId: "srv-stock", supported: false }),
      makeHost({ serverId: "srv-offline", connectionStatus: "connecting" }),
    ];

    const { result } = renderHook(() => useAggregatedRules(), { wrapper });

    await waitFor(() => expect(result.current.hasUsableHost).toBe(false));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasFailed).toBe(false);
  });

  it("asks the failed host again on retry", async () => {
    let shouldFail = true;
    const list = vi.fn(async () => {
      if (shouldFail) throw new Error("nope");
      return { checks: [RULE] };
    });
    hosts = [makeHost({ serverId: "srv-fork", list })];

    const { result } = renderHook(() => useAggregatedRules(), { wrapper });
    await waitFor(() => expect(result.current.hasFailed).toBe(true));

    shouldFail = false;
    await act(async () => {
      result.current.retryFailed();
    });

    await waitFor(() => expect(result.current.groups).toHaveLength(1));
    expect(result.current.hasFailed).toBe(false);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
