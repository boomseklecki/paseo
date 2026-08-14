export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

/** The namespace the daemon keeps for itself. */
export const RESERVED_LABEL_PREFIX = "paseo.";

/**
 * The labels a new agent may take from the one it was made out of.
 *
 * Everything under `paseo.` says where an agent sits rather than what it is
 * for - whose child it is, which client has a tab open on it. Copied onto a new
 * agent it claims a place nobody put it in, and the claim outlives the copying:
 * an inherited open-tab label keeps an agent alive through the archive that
 * should have taken it, and no later pass clears it, because the label reads
 * exactly like a tab someone opened.
 *
 * So the namespace stays behind and the rest comes along. What is left is what
 * somebody set themselves, which the agent list filters on, and which means the
 * same thing on the copy as it did on the original.
 */
export function inheritableLabels(
  labels: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!labels) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(labels).filter(([key]) => !key.startsWith(RESERVED_LABEL_PREFIX)),
  );
}
