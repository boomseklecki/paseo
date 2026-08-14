import { describe, expect, test } from "vitest";
import {
  getParentAgentIdFromLabels,
  inheritableLabels,
  isDelegatedAgent,
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
