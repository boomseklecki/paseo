import type { Logger } from "pino";
import type { AgentManager } from "../../agent/agent-manager.js";
import { AsideAction } from "./aside.js";
import { ForkAction } from "./fork.js";
import { StartAction } from "./start.js";
import type { PreSendActionOutcome, PreSendActionRequest } from "./types.js";

/**
 * Every action this daemon can carry out, by kind.
 *
 * A lookup rather than the `if (kind !== "aside")` it replaces, now that there
 * is a second row. What matters more than the dispatch is the default: a kind
 * this build has never heard of is *declined*, not ignored. An action consumes
 * the message instead of sending it, so silently doing nothing would swallow
 * what somebody typed on the way to a destination that does not exist.
 */
export function createPreSendActionRegistry(options: { manager: AgentManager; logger: Logger }): {
  run: (request: PreSendActionRequest) => Promise<PreSendActionOutcome>;
} {
  const actions: Record<
    string,
    { run: (r: PreSendActionRequest) => Promise<PreSendActionOutcome> }
  > = {
    aside: new AsideAction(options),
    fork: new ForkAction(options),
    start: new StartAction(options),
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
