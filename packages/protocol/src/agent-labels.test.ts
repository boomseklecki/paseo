import { describe, expect, test } from "vitest";
import {
  getOpenAgentTabLabel,
  getParentAgentIdFromLabels,
  hasOpenAgentTab,
  inheritableLabels,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "./agent-labels.js";

describe("agent label policy", () => {
  test("treats a non-empty parent agent label as delegation", () => {
    const labels = { [PARENT_AGENT_ID_LABEL]: " parent-agent \n" };

    expect(getParentAgentIdFromLabels(labels)).toBe("parent-agent");
    expect(isDelegatedAgent({ labels })).toBe(true);
  });

  test("ignores missing, empty, and non-string parent agent labels", () => {
    expect(isDelegatedAgent({ labels: {} })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } })).toBe(false);
    expect(isDelegatedAgent({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } })).toBe(false);
  });

  test("treats any true client-scoped open-tab label as open", () => {
    const desktopLabel = getOpenAgentTabLabel("desktop-client");
    const mobileLabel = getOpenAgentTabLabel("mobile-client");

    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "true" })).toBe(true);
    expect(hasOpenAgentTab({ [desktopLabel]: "false", [mobileLabel]: "false" })).toBe(false);
    expect(hasOpenAgentTab({})).toBe(false);
  });

  test("recognizes only client-scoped open-tab labels", () => {
    expect(isOpenAgentTabLabel(getOpenAgentTabLabel("client-a"))).toBe(true);
    expect(isOpenAgentTabLabel("paseo.open-agent-tab")).toBe(false);
    expect(isOpenAgentTabLabel("custom.open-agent-tab.client-a")).toBe(false);
  });

  test("carries someone's own labels to a new agent and leaves the namespace behind", () => {
    expect(
      inheritableLabels({
        team: "infra",
        "paseo.parent-agent-id": "parent-agent",
        "paseo.open-agent-tab.client-a": "true",
        "paseo.anything-added-later": "whatever",
      }),
    ).toEqual({ team: "infra" });
  });

  test("has nothing to inherit from an agent with no labels", () => {
    expect(inheritableLabels(undefined)).toEqual({});
    expect(inheritableLabels(null)).toEqual({});
    expect(inheritableLabels({})).toEqual({});
  });

  test("keeps a label that merely mentions the namespace elsewhere", () => {
    expect(inheritableLabels({ "team.paseo.owner": "infra", paseo: "not-the-prefix" })).toEqual({
      "team.paseo.owner": "infra",
      paseo: "not-the-prefix",
    });
  });
});
