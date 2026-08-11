import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { ScheduleService } from "../../schedule/service.js";
import { AsideOutcome } from "./aside.js";
import { ForkOutcome } from "./fork.js";
import { ScheduleOutcome } from "./schedule.js";
import { StartOutcome } from "./start.js";
import type { PreSendOutcomeResult, PreSendOutcomeRequest } from "./types.js";

/**
 * Every action this daemon can carry out, by kind.
 *
 * A lookup rather than the `if (kind !== "aside")` it replaces, now that there
 * is a second row. What matters more than the dispatch is the default: a kind
 * this build has never heard of is *declined*, not ignored. An action consumes
 * the message instead of sending it, so silently doing nothing would swallow
 * what somebody typed on the way to a destination that does not exist.
 */
export function createPreSendOutcomeRegistry(options: {
  manager: AgentManager;
  scheduleService: ScheduleService;
  logger: Logger;
}): {
  run: (request: PreSendOutcomeRequest) => Promise<PreSendOutcomeResult>;
} {
  const actions: Record<
    string,
    { run: (r: PreSendOutcomeRequest) => Promise<PreSendOutcomeResult> }
  > = {
    aside: new AsideOutcome(options),
    fork: new ForkOutcome(options),
    start: new StartOutcome(options),
    schedule: new ScheduleOutcome(options),
  };

  return {
    run: async (request) => {
      const action = actions[request.action.kind];
      if (!action) {
        return { status: "declined", reason: `Unknown action '${request.action.kind}'` };
      }
      return action.run(request);
    },
  };
}
