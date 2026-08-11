import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import { buildAgentForkContextAttachment } from "../../agent/activity-curator.js";
import {
  RULE_CREATED_AGENT_LABEL,
  wasCreatedByRule,
  type PreSendActionOutcome,
  type PreSendActionRequest,
} from "./types.js";

/**
 * Carries a conversation into a new one, up to where it had got to.
 *
 * Paseo can already do this — `agent.fork_context.request` builds the
 * attachment and the app creates an agent with it — but only from a button, on
 * a conversation you are looking at. As an outcome it becomes something you can
 * ask for by rule: a `/fork` in the composer, or a fork the daemon takes on your
 * behalf when a turn fails.
 *
 * The whole conversation, not a slice. The button offers a boundary because
 * someone is pointing at a message; a rule has nobody pointing, and "up to now"
 * is the only boundary it could mean.
 *
 * Unlike an aside this is meant to be seen: a real agent, in the same workspace,
 * that shows up in the list and can be replied to. The aside is the one that
 * hides.
 */
export class ForkAction {
  private readonly manager: AgentManager;
  private readonly logger: Logger;

  constructor(options: { manager: AgentManager; logger: Logger }) {
    this.manager = options.manager;
    this.logger = options.logger.child({ module: "pre-send-checks", action: "fork" });
  }

  async run(request: PreSendActionRequest): Promise<PreSendActionOutcome> {
    const parent = this.manager.getAgent(request.agentId);
    if (!parent) {
      return { status: "declined", reason: "No such agent" };
    }

    // One generation. Without this a rule at a daemon seam creates an agent
    // whose turn then trips the same rule, forever - the edge trigger cannot
    // see it, because each new agent is a new id with nothing remembered.
    if (wasCreatedByRule(parent.labels)) {
      return {
        status: "declined",
        reason: "This conversation was made by a rule, so a rule will not make another from it",
      };
    }

    const timeline = this.manager.fetchTimeline(request.agentId, { direction: "tail", limit: 0 });
    const forked = buildAgentForkContextAttachment({
      rows: timeline.rows,
      agentTitle: parent.config.title ?? null,
      cwd: parent.cwd,
    });

    // Nothing to carry means nothing to fork. Creating an empty agent would
    // look like the rule worked and leave someone wondering where their
    // conversation went.
    if (forked.itemCount === 0) {
      return { status: "declined", reason: "This conversation has nothing to carry over yet" };
    }

    const title = request.action.title?.trim() || `${parent.config.title ?? "Agent"} (fork)`;

    try {
      const agent = await this.manager.createAgent(
        { ...parent.config, title },
        undefined,
        // The same workspace, deliberately. A fork is a continuation of this
        // work, and an agent with no workspace is one nothing can notify about
        // and nothing lists beside its parent.
        {
          workspaceId: parent.workspaceId,
          labels: { ...parent.labels, [RULE_CREATED_AGENT_LABEL]: "fork" },
        },
      );

      this.logger.info(
        { parentAgentId: request.agentId, agentId: agent.id, itemCount: forked.itemCount },
        "Forked a conversation",
      );

      return { status: "started", subagentId: agent.id, agentId: agent.id };
    } catch (error) {
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
