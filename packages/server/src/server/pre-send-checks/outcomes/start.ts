import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import {
  RULE_CREATED_AGENT_LABEL,
  wasCreatedByRule,
  type PreSendOutcomeResult,
  type PreSendOutcomeRequest,
} from "./types.js";
import { promptUsesPreSendToken, renderPreSendPrompt } from "./types.js";

/**
 * Starts a fresh conversation beside this one.
 *
 * Fork without the transcript, and the missing transcript is the point rather
 * than a shortcoming. The rule most worth attaching this to fires *because* a
 * conversation is nearly full — carrying it into the copy would carry the very
 * thing that triggered the rule. Fork is "try again from here"; start is "carry
 * on somewhere with room".
 *
 * Which makes the pair worth writing down: an `aside` writes the handoff, a
 * `start` opens the conversation that receives it. Two rules, or one rule and a
 * prompt that says where the handoff lives.
 */
export class StartOutcome {
  private readonly manager: AgentManager;
  private readonly logger: Logger;

  constructor(options: { manager: AgentManager; logger: Logger }) {
    this.manager = options.manager;
    this.logger = options.logger.child({ module: "pre-send-checks", outcome: "start" });
  }

  async run(request: PreSendOutcomeRequest): Promise<PreSendOutcomeResult> {
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

    const title = request.outcome.title?.trim() || `${parent.config.title ?? "Agent"} (continued)`;
    const opening = readOpening(request);

    try {
      const agent = await this.manager.createAgent(
        { ...parent.config, title },
        undefined,
        // Same workspace and cwd as the conversation that asked for it: this is
        // the same work continuing, not a new piece of it.
        {
          workspaceId: parent.workspaceId,
          labels: { ...parent.labels, [RULE_CREATED_AGENT_LABEL]: "start" },
        },
      );

      if (opening) {
        // Not awaited, for the same reason the aside is not: the rule has
        // already done its job by opening the conversation, and a caller
        // waiting on a whole turn would be waiting on a model.
        void this.manager.runAgent(agent.id, opening).catch((error: unknown) => {
          this.logger.warn(
            { err: error, agentId: agent.id },
            "Started an agent but its opening message failed",
          );
        });
      }

      this.logger.info(
        { parentAgentId: request.agentId, agentId: agent.id, opened: Boolean(opening) },
        "Started a conversation",
      );

      return { status: "started", subagentId: agent.id, agentId: agent.id };
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * What the new conversation is told first.
 *
 * `{{message}}` is substituted the same way the aside does it, so a rule at the
 * composer can hand across what was typed. With no prompt the agent is simply
 * opened and left waiting, which is a legitimate thing to want: somewhere with
 * room, ready when you switch to it.
 */
function readOpening(request: PreSendOutcomeRequest): string {
  const template = request.outcome.prompt?.trim();
  if (!template) {
    return "";
  }
  return promptUsesPreSendToken(template) ? renderPreSendPrompt(template, request) : template;
}
