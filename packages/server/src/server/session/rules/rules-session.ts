import type pino from "pino";
import type { Rule } from "@getpaseo/protocol/rules/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { RULE_OUTCOME_DESCRIPTORS } from "../../rules/outcomes/descriptors.js";
import { listRuleExamples } from "../../rules/examples.js";
import type { RuleOutcomeResult, RuleOutcomeRequest } from "../../rules/outcomes/types.js";
import type { RulesService } from "../../rules/service.js";

export interface RulesSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/**
 * The whole of what this subsystem needs from an action.
 *
 * Declared here rather than importing `AsideOutcome`, which would drag
 * `AgentManager` — the fattest collaborator in the daemon — into a file that
 * otherwise touches nothing but a store and the wire. `AsideOutcome` satisfies
 * this structurally, so nothing has to implement it on purpose, and a test
 * needing an action that behaves a certain way writes the object rather than
 * standing up a manager to get one.
 */
export interface RuleOutcomeRunner {
  run(request: RuleOutcomeRequest): Promise<RuleOutcomeResult>;
}

export interface RulesSessionOptions {
  host: RulesSessionHost;
  rulesService: RulesService;
  outcomeRunner: RuleOutcomeRunner;
  logger: pino.Logger;
}

type RulesWriteRequest = Extract<
  SessionInboundMessage,
  | { type: "rules.upsert.request" }
  | { type: "rules.delete.request" }
  | { type: "rules.reorder.request" }
>;

/**
 * The five `rules/*` verbs.
 *
 * Rules are the daemon's answer to "should this message be sent", so everything
 * here is shaped by one rule: a client must always be able to tell "no rules" apart
 * from "could not read the rules". The first means send freely and the second
 * does not, and a handler that reported them the same way would turn the gate
 * off on the one occasion it mattered.
 */
export class RulesSession {
  private readonly host: RulesSessionHost;
  private readonly rulesService: RulesService;
  private readonly outcomeRunner: RuleOutcomeRunner;
  private readonly logger: pino.Logger;

  constructor(options: RulesSessionOptions) {
    this.host = options.host;
    this.rulesService = options.rulesService;
    this.outcomeRunner = options.outcomeRunner;
    this.logger = options.logger;
  }

  /**
   * Rules come off disk on every call rather than out of a cache, which is the
   * whole reason they no longer live in the daemon config. `error` is reported
   * rather than thrown: a client that cannot read the rules must be able to tell
   * that apart from there being none, because only one of those two states means
   * "send freely".
   */
  async handleRulesListRequest(
    msg: Extract<SessionInboundMessage, { type: "rules.list.request" }>,
  ): Promise<void> {
    try {
      this.host.emit({
        type: "rules.list.response",
        payload: {
          requestId: msg.requestId,
          checks: await this.rulesService.list(),
          outcomes: [...RULE_OUTCOME_DESCRIPTORS],
          examples: listRuleExamples(),
          error: null,
        },
      });
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to list rules");
      this.host.emit({
        type: "rules.list.response",
        payload: {
          requestId: msg.requestId,
          checks: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async handleRulesUpsertRequest(
    msg: Extract<SessionInboundMessage, { type: "rules.upsert.request" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.rulesService.upsert(msg.check));
  }

  async handleRulesDeleteRequest(
    msg: Extract<SessionInboundMessage, { type: "rules.delete.request" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.rulesService.delete(msg.ruleId));
  }

  async handleRulesReorderRequest(
    msg: Extract<SessionInboundMessage, { type: "rules.reorder.request" }>,
  ): Promise<void> {
    await this.handleWriteRequest(msg, () => this.rulesService.reorder(msg.ruleIds));
  }

  /**
   * Carries out a rule's action instead of sending the message.
   *
   * Every failure answers `declined` rather than an rpc error, because the
   * caller reads that as "I did not take your message, send it yourself". An
   * error here would leave the person having typed something that went nowhere.
   */
  async handleRulesRunOutcomeRequest(
    msg: Extract<SessionInboundMessage, { type: "rules.run_outcome.request" }>,
  ): Promise<void> {
    // Which kinds exist is the runner's business now that there is more than
    // one, and it declines anything it does not have. A newer client can name a
    // kind this daemon has never heard of, and a redirect consumes what was
    // typed — so declining is the difference between a message sending normally
    // and a message disappearing.
    try {
      const outcome = await this.outcomeRunner.run({
        agentId: msg.agentId,
        message: msg.message,
        // The client measured it, so the client formats it: only the app has
        // the rule's trigger to hand at this point, and a daemon re-deriving it
        // from the message would be guessing.
        value: msg.value ?? "",
        outcome: msg.outcome,
        confirmed: msg.confirmed === true,
      });
      this.respondToRunOutcome(msg.requestId, outcome);
    } catch (error) {
      this.logger.warn({ err: error }, "Rule outcome failed");
      this.respondToRunOutcome(msg.requestId, {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private respondToRunOutcome(requestId: string, outcome: RuleOutcomeResult): void {
    this.host.emit({
      type: "rules.run_outcome.response",
      payload: {
        requestId,
        status: outcome.status,
        subagentId: outcome.status === "started" ? outcome.subagentId : null,
        agentId: outcome.status === "started" ? (outcome.agentId ?? null) : null,
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
    msg: RulesWriteRequest,
    write: () => Promise<Rule[]>,
  ): Promise<void> {
    // Derived by swapping the direction segment, which is the whole reason the
    // namespacing doc asks for `.request`/`.response`: the pair is mechanical.
    // This used to append `/response`, and the rename to dots turned that into
    // `rules.upsert.request/response` — a type nothing listens for, so every
    // write answered into the void.
    const responseType = msg.type.replace(/\.request$/, ".response") as
      | "rules.upsert.response"
      | "rules.delete.response"
      | "rules.reorder.response";
    try {
      this.host.emit({
        type: responseType,
        payload: { requestId: msg.requestId, checks: await write(), error: null },
      });
    } catch (error) {
      this.logger.warn({ err: error, type: msg.type }, "Failed to write rule");
      this.host.emit({
        type: responseType,
        payload: {
          requestId: msg.requestId,
          checks: await this.rulesService.list().catch(() => []),
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}
