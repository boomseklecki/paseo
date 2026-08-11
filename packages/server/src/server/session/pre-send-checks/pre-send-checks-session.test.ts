import { describe, expect, it } from "vitest";
import pino from "pino";
import type { PreSendCheckRule } from "@getpaseo/protocol/pre-send-checks/types";
import { PreSendChecksSession, type PreSendOutcomeRunner } from "./pre-send-checks-session.js";
import { createStub } from "../../test-utils/class-mocks.js";
import { findByType } from "../../test-utils/session-stubs.js";
import type { SessionOutboundMessage } from "../../messages.js";
import type { PreSendOutcomeResult } from "../../pre-send-checks/outcomes/types.js";
import type { PreSendChecksService } from "../../pre-send-checks/service.js";

const RULE: PreSendCheckRule = {
  id: "cold-prompt-cache",
  measurement: "agent.idleSeconds",
  operator: "gte",
  threshold: 3600,
  disposition: "block",
};

// The port is one method, so a test that wants an action to behave a certain
// way writes the object. This is what not importing AsideOutcome buys.
function runner(run: PreSendOutcomeRunner["run"]): PreSendOutcomeRunner {
  return { run };
}

const DECLINE_EVERYTHING = runner(async () => ({
  status: "declined" as const,
  reason: "not called",
}));

function makeSession(
  service: { [K in keyof PreSendChecksService]?: unknown },
  outcomeRunner: PreSendOutcomeRunner = DECLINE_EVERYTHING,
) {
  const emitted: SessionOutboundMessage[] = [];
  const session = new PreSendChecksSession({
    host: { emit: (message) => emitted.push(message) },
    preSendChecksService: createStub<PreSendChecksService>(service),
    outcomeRunner,
    logger: pino({ level: "silent" }),
  });
  return { session, emitted };
}

describe("PreSendChecksSession", () => {
  it("answers a list with the rules and the outcomes this daemon can run", async () => {
    const { session, emitted } = makeSession({ list: async () => [RULE] });

    await session.handlePreSendChecksListRequest({
      type: "rules.list.request",
      requestId: "r1",
    });

    const response = findByType(emitted, "rules.list.response");
    expect(response?.payload.checks).toEqual([RULE]);
    expect(response?.payload.error).toBeNull();
    expect(response?.payload.outcomes?.map((outcome) => outcome.kind)).toContain("aside");
    // Examples ride the same response as the outcomes, so one screen is one round
    // trip rather than two.
    expect(response?.payload.examples?.length).toBeGreaterThan(0);
  });

  // A failure has to lose the suggestions along with the rules: offering an
  // example while claiming the rules are unreadable invites a save into a
  // daemon that just said it could not read its own directory.
  it("offers no examples when the rules could not be read", async () => {
    const { session, emitted } = makeSession({
      list: async () => {
        throw new Error("disk gone");
      },
    });

    await session.handlePreSendChecksListRequest({
      type: "rules.list.request",
      requestId: "r1",
    });

    expect(findByType(emitted, "rules.list.response")?.payload.examples).toBeUndefined();
  });

  // The distinction the whole subsystem is arranged around: an empty list means
  // send freely, a failure does not, and a client has to be able to tell them
  // apart. Reporting the failure as an rpc_error would lose that.
  it("reports a failed list as an error rather than as no rules", async () => {
    const { session, emitted } = makeSession({
      list: async () => {
        throw new Error("disk gone");
      },
    });

    await session.handlePreSendChecksListRequest({
      type: "rules.list.request",
      requestId: "r1",
    });

    const response = findByType(emitted, "rules.list.response");
    expect(response?.payload.checks).toEqual([]);
    expect(response?.payload.error).toBe("disk gone");
    expect(findByType(emitted, "rpc_error")).toBeUndefined();
  });

  it("answers each write with the whole resulting list", async () => {
    const { session, emitted } = makeSession({
      upsert: async () => [RULE],
      delete: async () => [],
      reorder: async () => [RULE],
    });

    await session.handlePreSendChecksUpsertRequest({
      type: "rules.upsert.request",
      requestId: "r1",
      check: RULE,
    });
    await session.handlePreSendChecksDeleteRequest({
      type: "rules.delete.request",
      requestId: "r2",
      ruleId: RULE.id,
    });
    await session.handlePreSendChecksReorderRequest({
      type: "rules.reorder.request",
      requestId: "r3",
      ruleIds: [RULE.id],
    });

    expect(findByType(emitted, "rules.upsert.response")?.payload.checks).toEqual([RULE]);
    expect(findByType(emitted, "rules.delete.response")?.payload.checks).toEqual([]);
    expect(findByType(emitted, "rules.reorder.response")?.payload.checks).toEqual([RULE]);
  });

  // A client that blanked its list because a save failed would stop gating
  // sends over an unrelated failure.
  it("keeps the readable rules in the response when a write fails", async () => {
    const { session, emitted } = makeSession({
      upsert: async () => {
        throw new Error("read-only filesystem");
      },
      list: async () => [RULE],
    });

    await session.handlePreSendChecksUpsertRequest({
      type: "rules.upsert.request",
      requestId: "r1",
      check: RULE,
    });

    const response = findByType(emitted, "rules.upsert.response");
    expect(response?.payload.checks).toEqual([RULE]);
    expect(response?.payload.error).toBe("read-only filesystem");
  });

  it("still answers a failed write when the rules cannot be read either", async () => {
    const { session, emitted } = makeSession({
      delete: async () => {
        throw new Error("write failed");
      },
      list: async () => {
        throw new Error("read failed too");
      },
    });

    await session.handlePreSendChecksDeleteRequest({
      type: "rules.delete.request",
      requestId: "r1",
      ruleId: RULE.id,
    });

    const response = findByType(emitted, "rules.delete.response");
    expect(response?.payload.checks).toEqual([]);
    expect(response?.payload.error).toBe("write failed");
  });

  it("passes a run_outcome through to the runner and reports what it started", async () => {
    const seen: unknown[] = [];
    const { session, emitted } = makeSession(
      {},
      runner(async (request) => {
        seen.push(request);
        return { status: "started", subagentId: "sub-1" };
      }),
    );

    await session.handlePreSendChecksRunOutcomeRequest({
      type: "rules.run_outcome.request",
      requestId: "r1",
      agentId: "agent-1",
      message: "/btw what does this flag do",
      outcome: { kind: "aside" },
      confirmed: true,
    });

    expect(seen).toEqual([
      {
        agentId: "agent-1",
        message: "/btw what does this flag do",
        // A client that predates `{{value}}` sends none, and the token then
        // substitutes to nothing - which is what it did before it existed.
        value: "",
        outcome: { kind: "aside" },
        confirmed: true,
      },
    ]);
    const response = findByType(emitted, "rules.run_outcome.response");
    expect(response?.payload.status).toBe("started");
    expect(response?.payload.subagentId).toBe("sub-1");
  });

  it("carries a confirmation request back with what it would cost", async () => {
    const { session, emitted } = makeSession(
      {},
      runner(async () => ({
        status: "needs_confirmation",
        reason: "the transcript would be replayed",
        estimatedTokens: 51_000,
      })),
    );

    await session.handlePreSendChecksRunOutcomeRequest({
      type: "rules.run_outcome.request",
      requestId: "r1",
      agentId: "agent-1",
      message: "/btw",
      outcome: { kind: "aside" },
    });

    const response = findByType(emitted, "rules.run_outcome.response");
    expect(response?.payload.status).toBe("needs_confirmation");
    expect(response?.payload.estimatedTokens).toBe(51_000);
    expect(response?.payload.subagentId).toBeNull();
  });

  // A redirect consumes what was typed, so a kind this daemon cannot perform has
  // to come back as declined - which the caller reads as "send it yourself".
  // Which kinds exist moved into the runner when a second one turned up, so the
  // subsystem asks and reports what it hears rather than knowing the list.
  it("reports the runner's decline of a kind it does not have", async () => {
    const seen: string[] = [];
    const { session, emitted } = makeSession(
      {},
      runner(async (request) => {
        seen.push(request.outcome.kind);
        return { status: "declined", reason: `Unknown outcome '${request.outcome.kind}'` };
      }),
    );

    await session.handlePreSendChecksRunOutcomeRequest({
      type: "rules.run_outcome.request",
      requestId: "r1",
      agentId: "agent-1",
      message: "hello",
      outcome: { kind: "teleport" },
    });

    expect(seen).toEqual(["teleport"]);
    const response = findByType(emitted, "rules.run_outcome.response");
    expect(response?.payload.status).toBe("declined");
    expect(response?.payload.reason).toBe("Unknown outcome 'teleport'");
  });

  // Failed rather than declined, and never an rpc_error: the caller must not
  // send the text on, or the aside arrives at the agent as an instruction.
  it("reports a throwing action as failed", async () => {
    const { session, emitted } = makeSession(
      {},
      runner(async () => {
        throw new Error("provider refused");
      }),
    );

    await session.handlePreSendChecksRunOutcomeRequest({
      type: "rules.run_outcome.request",
      requestId: "r1",
      agentId: "agent-1",
      message: "/btw",
      outcome: { kind: "aside" },
    });

    const response = findByType(emitted, "rules.run_outcome.response");
    expect(response?.payload.status).toBe("failed");
    expect(response?.payload.reason).toBe("provider refused");
    expect(findByType(emitted, "rpc_error")).toBeUndefined();
  });

  it("does not let a declined outcome carry a subagent id", async () => {
    const declined: PreSendOutcomeResult = { status: "declined", reason: "No such agent" };
    const { session, emitted } = makeSession(
      {},
      runner(async () => declined),
    );

    await session.handlePreSendChecksRunOutcomeRequest({
      type: "rules.run_outcome.request",
      requestId: "r1",
      agentId: "gone",
      message: "/btw",
      outcome: { kind: "aside" },
    });

    const response = findByType(emitted, "rules.run_outcome.response");
    expect(response?.payload.subagentId).toBeNull();
    expect(response?.payload.estimatedTokens).toBeNull();
  });
});
