import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { AgentSessionConfig, AgentTimelineItem } from "../../agent/agent-sdk-types.js";
import { planAside, type AsideRoute } from "./aside-plan.js";
import type { PreSendActionOutcome, PreSendActionRequest } from "./types.js";

/**
 * Answers a question about the current work without the conversation taking a
 * turn for it.
 *
 * The work runs in an agent hidden from every listing and streams into the
 * parent's subagent panel, so the answer is attached to the conversation it came
 * from without being part of it. The parent is never prompted, never
 * interrupted, and gains no context.
 *
 * Two ways in, chosen by `planAside`: resume the parent's provider session where
 * the provider kept it, otherwise replay Paseo's own transcript. The first is
 * far cheaper and needs the provider to persist sessions; the second works
 * anywhere and pays for the conversation again.
 */

const DEFAULT_TITLE = "Aside";

export interface AsideActionOptions {
  manager: AgentManager;
  logger: Logger;
  /** Injected so a test can await the work the caller deliberately does not. */
  onSettled?: (result: { subagentId: string; error: Error | null }) => void;
}

export class AsideAction {
  private readonly manager: AgentManager;
  private readonly logger: Logger;
  private readonly onSettled: AsideActionOptions["onSettled"];

  constructor(options: AsideActionOptions) {
    this.manager = options.manager;
    this.logger = options.logger.child({ module: "pre-send-checks", action: "aside" });
    this.onSettled = options.onSettled;
  }

  async run(request: PreSendActionRequest): Promise<PreSendActionOutcome> {
    const parent = this.manager.getAgent(request.agentId);
    if (!parent) {
      return { status: "declined", reason: "No such agent" };
    }

    const transcript = renderTranscript(this.manager.getTimeline(request.agentId));
    const plan = planAside({
      // Resuming needs the provider to have kept the session. Asking the handle
      // rather than a capability flag means a provider that claims persistence
      // but produced no handle falls back rather than failing.
      canResume: Boolean(parent.persistence?.sessionId),
      transcriptChars: transcript.length,
      confirmed: request.confirmed,
    });

    if (plan.decision === "confirm") {
      return {
        status: "needs_confirmation",
        reason: "replay",
        estimatedTokens: plan.estimatedTokens,
      };
    }

    const subagentId = `aside-${Date.now().toString(36)}`;
    const title = request.action.title?.trim() || DEFAULT_TITLE;
    const question = buildQuestion(request);

    this.manager.applyProviderSubagentEvent(request.agentId, parent.provider, {
      type: "upsert",
      id: subagentId,
      title,
      // What was typed, not the prompt it gets wrapped in. The panel row shows
      // this, and a row reading back the template rather than the question is a
      // list of identical entries.
      description: request.message,
      status: "running",
      // Nothing in the parent's transcript asked for this, so there is no tool
      // call to point at. The field is nullable for exactly this case.
      toolCallId: null,
      cwd: parent.config.cwd,
      subtitle: plan.route === "resume" ? undefined : "replayed",
    });

    // Deliberately not awaited. The whole point is that the send returns at once
    // and the answer arrives in the panel later; awaiting here would make an
    // aside block the composer exactly as a normal send does.
    void this.execute({ request, plan: plan.route, subagentId, question, transcript }).then(
      () => this.onSettled?.({ subagentId, error: null }),
      (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ err, subagentId }, "Aside failed");
        this.manager.applyProviderSubagentEvent(request.agentId, parent.provider, {
          type: "upsert",
          id: subagentId,
          status: "failed",
          subtitle: err.message,
        });
        this.onSettled?.({ subagentId, error: err });
      },
    );

    return { status: "started", subagentId };
  }

  private async execute(input: {
    request: PreSendActionRequest;
    plan: AsideRoute;
    subagentId: string;
    question: string;
    transcript: string;
  }): Promise<void> {
    const { request, subagentId } = input;
    const parent = this.manager.getAgent(request.agentId);
    if (!parent) {
      throw new Error("Agent went away before the aside started");
    }

    const asideAgentId =
      input.plan === "resume" ? await this.startResumed(parent) : await this.startReplayed(parent);

    try {
      for await (const event of this.manager.streamAgent(
        asideAgentId,
        input.plan === "resume"
          ? input.question
          : buildReplayPrompt(input.transcript, input.question),
      )) {
        if (event.type !== "timeline") {
          continue;
        }
        this.manager.applyProviderSubagentEvent(request.agentId, parent.provider, {
          type: "timeline",
          id: subagentId,
          item: event.item as AgentTimelineItem,
        });
      }
      this.manager.applyProviderSubagentEvent(request.agentId, parent.provider, {
        type: "upsert",
        id: subagentId,
        status: "completed",
      });
    } finally {
      // The aside is over either way, and leaving a hidden agent alive is a
      // provider session nobody can see and nobody will close.
      await this.manager.closeAgent(asideAgentId).catch(() => undefined);
      await this.manager.deleteAgentState(asideAgentId).catch(() => undefined);
    }
  }

  private async startResumed(
    parent: NonNullable<ReturnType<AgentManager["getAgent"]>>,
  ): Promise<string> {
    const handle = parent.persistence;
    if (!handle) {
      throw new Error("Parent has no session to resume");
    }
    const agent = await this.manager.resumeAgentFromPersistence(
      handle,
      {
        ...asideConfig(parent.config),
        // The resumed config otherwise inherits the parent's provider options,
        // which some clients refuse outright.
        providerOptions: undefined,
      },
      undefined,
      { workspaceId: undefined },
    );
    return agent.id;
  }

  private async startReplayed(
    parent: NonNullable<ReturnType<AgentManager["getAgent"]>>,
  ): Promise<string> {
    const agent = await this.manager.createAgent(asideConfig(parent.config), undefined, {
      persistSession: false,
      workspaceId: undefined,
    });
    return agent.id;
  }
}

/**
 * The config an aside runs under.
 *
 * `internal` keeps it out of every listing and out of notifications. The mode is
 * left as the parent's: the provider read-only modes are not portable — codex
 * has none at all — and the one that exists on claude answers a question by
 * commenting on whether a plan is needed, which is worse than no guarantee.
 */
function asideConfig(parent: AgentSessionConfig): AgentSessionConfig {
  return { ...parent, internal: true, title: DEFAULT_TITLE };
}

/**
 * What to ask.
 *
 * The trigger prefix is left on the message. Stripping it needs the rule's
 * trigger text, which the action is not given and should not have to know, and
 * a model reading `/btw what does this flag do` understands it perfectly well.
 */
function buildQuestion(request: PreSendActionRequest): string {
  const template = request.action.prompt?.trim();
  if (!template) {
    return request.message;
  }
  return template.includes("{{message}}")
    ? template.replaceAll("{{message}}", request.message)
    : `${template}\n\n${request.message}`;
}

function buildReplayPrompt(transcript: string, question: string): string {
  return `Here is the conversation so far.\n\n${transcript}\n\n---\n\n${question}`;
}

/** Only what a person said and what was said back; tool traffic is not context. */
function renderTranscript(items: readonly AgentTimelineItem[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.type !== "user_message" && item.type !== "assistant_message") {
      continue;
    }
    const text = typeof item.text === "string" ? item.text : "";
    if (text) {
      lines.push(`${item.type === "user_message" ? "User" : "Assistant"}: ${text}`);
    }
  }
  return lines.join("\n\n");
}
