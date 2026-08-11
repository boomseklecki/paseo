import type pino from "pino";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { PRE_SEND_ACTION_DESCRIPTORS } from "../../pre-send-checks/actions/descriptors.js";
import { listPreSendCheckExamples } from "../../pre-send-checks/examples.js";
import type {
  PreSendActionOutcome,
  PreSendActionRequest,
} from "../../pre-send-checks/actions/types.js";
import type { PreSendChecksService } from "../../pre-send-checks/service.js";

export interface PreSendChecksSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/**
 * The whole of what this subsystem needs from an action.
 *
 * Declared here rather than importing `AsideAction`, which would drag
 * `AgentManager` — the fattest collaborator in the daemon — into a file that
 * otherwise touches nothing but a store and the wire. `AsideAction` satisfies
 * this structurally, so nothing has to implement it on purpose, and a test
 * needing an action that behaves a certain way writes the object rather than
 * standing up a manager to get one.
 */
export interface PreSendActionRunner {
  run(request: PreSendActionRequest): Promise<PreSendActionOutcome>;
}

export interface PreSendChecksSessionOptions {
  host: PreSendChecksSessionHost;
  preSendChecksService: PreSendChecksService;
  actionRunner: PreSendActionRunner;
  logger: pino.Logger;
}

type PreSendChecksWriteRequest = Extract<
  SessionInboundMessage,
  | { type: "pre_send_checks/upsert" }
  | { type: "pre_send_checks/delete" }
  | { type: "pre_send_checks/reorder" }
>;

/**
 * The five `pre_send_checks/*` verbs.
 *
 * Rules are the daemon's answer to "should this message be sent", so everything
 * here is shaped by one rule: a client must always be able to tell "no rules" apart
 * from "could not read the rules". The first means send freely and the second
 * does not, and a handler that reported them the same way would turn the gate
 * off on the one occasion it mattered.
 */
export class PreSendChecksSession {
  private readonly host: PreSendChecksSessionHost;
  private readonly preSendChecksService: PreSendChecksService;
  private readonly actionRunner: PreSendActionRunner;
  private readonly logger: pino.Logger;

  constructor(options: PreSendChecksSessionOptions) {
    this.host = options.host;
    this.preSendChecksService = options.preSendChecksService;
    this.actionRunner = options.actionRunner;
    this.logger = options.logger;
  }

  /**
   * Rules come off disk on every call rather than out of a cache, which is the
   * whole reason they no longer live in the daemon config. `error` is reported
   * rather than thrown: a client that cannot read the rules must be able to tell
   * that apart from there being none, because only one of those two states means
   * "send freely".
   */
  async handlePreSendChecksListRequest(
    msg: Extract<SessionInboundMessage, { type: "pre_send_checks/list" }>,
  ): Promise<void> {
    try {
      this.host.emit({
        type: "pre_send_checks/list/response",
        payload: {
          requestId: msg.requestId,
          checks: await this.preSendChecksService.list(),
          actions: [...PRE_SEND_ACTION_DESCRIPTORS],
          examples: listPreSendCheckExamples(),
          error: null,
        },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list pre-send checks");
      this.host.emit({
        type: "pre_send_checks/list/response",
        payload: {
          requestId: msg.requestId,
          checks: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handlePreSendChecksUpsertRequest(
    msg: Extract<SessionInboundMessage, { type: "pre_send_checks/upsert" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.preSendChecksService.upsert(msg.check));
  }

  async handlePreSendChecksDeleteRequest(
    msg: Extract<SessionInboundMessage, { type: "pre_send_checks/delete" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.preSendChecksService.delete(msg.ruleId));
  }

  async handlePreSendChecksReorderRequest(
    msg: Extract<SessionInboundMessage, { type: "pre_send_checks/reorder" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.preSendChecksService.reorder(msg.ruleIds));
  }

  /**
   * Carries out a rule's action instead of sending the message.
   *
   * Every failure answers `declined` rather than an rpc error, because the
   * caller reads that as "I did not take your message, send it yourself". An
   * error here would leave the person having typed something that went nowhere.
   */
  async handlePreSendChecksRunActionRequest(
    msg: Extract<SessionInboundMessage, { type: "pre_send_checks/run_action" }>,
  ): Promise<void> {
    // Which kinds exist is the runner's business now that there is more than
    // one, and it declines anything it does not have. A newer client can name a
    // kind this daemon has never heard of, and a redirect consumes what was
    // typed — so declining is the difference between a message sending normally
    // and a message disappearing.
    try {
      const outcome = await this.actionRunner.run({
        agentId: msg.agentId,
        message: msg.message,
        action: msg.action,
        confirmed: msg.confirmed === true,
      });
      this.respondToRunAction(msg.requestId, outcome);
    } catch (error) {
      this.logger.warn({ err: error }, "Pre-send action failed");
      this.respondToRunAction(msg.requestId, {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private respondToRunAction(requestId: string, outcome: PreSendActionOutcome): void {
    this.host.emit({
      type: "pre_send_checks/run_action/response",
      payload: {
        requestId,
        status: outcome.status,
        subagentId: outcome.status === "started" ? outcome.subagentId : null,
        reason: "reason" in outcome ? outcome.reason : null,
        estimatedTokens:
          outcome.status === "needs_confirmation" ? (outcome.estimatedTokens ?? null) : null,
      },
    });
  }

  /**
   * Shared by the three writers, because they differ only in which store call
   * they make. All three answer with the whole resulting list so the caller
   * replaces its cache rather than merging into it, and all three report a
   * failure as `error` with the rules they could still read — a write that
   * failed says nothing about whether the existing rules are readable, and a
   * client that blanked its list on a failed save would stop gating sends
   * because of it.
   */
  private async handleWriteRequest(
    msg: PreSendChecksWriteRequest,
    write: () => Promise<PreSendCheckRule[]>,
  ): Promise<void> {
    const responseType = `${msg.type}/response` as
      | "pre_send_checks/upsert/response"
      | "pre_send_checks/delete/response"
      | "pre_send_checks/reorder/response";
    try {
      this.host.emit({
        type: responseType,
        payload: { requestId: msg.requestId, checks: await write(), error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, type: msg.type }, "Failed to write pre-send check");
      this.host.emit({
        type: responseType,
        payload: {
          requestId: msg.requestId,
          checks: await this.preSendChecksService.list().catch(() => []),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
