import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { ScheduleService } from "../../schedule/service.js";
import type { RuleOutcomeResult, RuleOutcomeRequest } from "./types.js";
import { promptUsesRuleToken, renderRulePrompt } from "./types.js";

/**
 * Says the one thing no other outcome can say: later.
 *
 * Everything else acts now — warn now, notify now, fork now. A rule that wants
 * to wait has had no way to express it, and waiting is the right answer more
 * often than it sounds: a turn that failed on a rate limit wants retrying in ten
 * minutes, not immediately, and an idle conversation wants nudging tomorrow
 * rather than at 2am because that is when the sweep noticed.
 *
 * Built on the schedule service rather than a timer of its own, so a scheduled
 * follow-up is an ordinary schedule: visible in the schedules list, editable,
 * and cancellable by someone who did not know a rule created it.
 */
export class ScheduleOutcome {
  private readonly manager: AgentManager;
  private readonly scheduleService: ScheduleService;
  private readonly logger: Logger;

  constructor(options: {
    manager: AgentManager;
    scheduleService: ScheduleService;
    logger: Logger;
  }) {
    this.manager = options.manager;
    this.scheduleService = options.scheduleService;
    this.logger = options.logger.child({ module: "rules", outcome: "schedule" });
  }

  async run(request: RuleOutcomeRequest): Promise<RuleOutcomeResult> {
    const parent = this.manager.getAgent(request.agentId);
    if (!parent) {
      return { status: "declined", reason: "No such agent" };
    }

    const delayMs = parseDelay(request.outcome.delay);
    if (delayMs === null) {
      return {
        status: "declined",
        reason: `Could not read '${String(request.outcome.delay ?? "")}' as a delay`,
      };
    }

    const prompt = readPrompt(request);
    if (!prompt) {
      // A schedule with nothing to say would wake the agent up to tell it
      // nothing, which is worse than not scheduling at all.
      return { status: "declined", reason: "This rule has nothing to schedule" };
    }

    try {
      const schedule = await this.scheduleService.create({
        name: request.outcome.title?.trim() || "Scheduled by a rule",
        prompt,
        cadence: { type: "every", everyMs: delayMs },
        // Back to the conversation that triggered it. A schedule that opened a
        // new agent would be `start` with a delay, and that is a different rule.
        target: { type: "agent", agentId: request.agentId },
        // Once unless the rule says otherwise. A rule firing on a crossing that
        // quietly created a repeating schedule is how someone ends up with an
        // agent talking to itself every ten minutes for a week.
        maxRuns: request.outcome.repeat === "true" ? null : 1,
      });

      this.logger.info(
        { agentId: request.agentId, scheduleId: schedule.id, everyMs: delayMs },
        "Scheduled a follow-up",
      );

      return { status: "started", subagentId: schedule.id };
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

const DELAY_UNITS_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Reads `10m`, `2h`, `30s`, `1d`.
 *
 * Its own small parser rather than a dependency, and deliberately strict: a
 * delay that cannot be read is refused rather than defaulted, because every
 * default here is wrong. Guessing minutes turns a typo into an agent waking up
 * at the wrong time, and guessing zero turns it into one waking immediately —
 * which is the thing the outcome exists not to do.
 */
export function parseDelay(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^\s*(\d+)\s*([smhd])\s*$/i.exec(value);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = DELAY_UNITS_MS[match[2]!.toLowerCase()];
  if (!unit || !Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  return amount * unit;
}

function readPrompt(request: RuleOutcomeRequest): string {
  const template = request.outcome.prompt?.trim();
  const message = request.message.trim();
  if (!template) {
    return message;
  }
  return promptUsesRuleToken(template) ? renderRulePrompt(template, request) : template;
}
