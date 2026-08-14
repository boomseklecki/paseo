import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentManager } from "../../agent/agent-manager.js";
import type { CreateScheduleInput } from "@getpaseo/protocol/schedule/types";
import type { ScheduleService } from "../../schedule/service.js";
import { parseDelay, ScheduleOutcome } from "./schedule.js";
import type { RuleOutcomeRequest } from "./types.js";

function harness() {
  const created: CreateScheduleInput[] = [];
  const outcome = new ScheduleOutcome({
    manager: {
      getAgent: () => ({ id: "agent-1", labels: {} }),
    } as unknown as AgentManager,
    scheduleService: {
      create: async (input: CreateScheduleInput) => {
        created.push(input);
        return { id: "schedule-1" };
      },
    } as unknown as ScheduleService,
    logger: pino({ level: "silent" }),
  });
  return { created, outcome };
}

function request(overrides: Partial<RuleOutcomeRequest> = {}): RuleOutcomeRequest {
  return {
    agentId: "agent-1",
    message: "",
    value: "always",
    outcome: { kind: "schedule", delay: "10m", prompt: "try again" },
    confirmed: false,
    ...overrides,
  };
}

describe("ScheduleOutcome", () => {
  // The outcome's whole content is "later", and an `every` cadence otherwise
  // fires once on creation before it starts waiting - so a rule asking to retry
  // in ten minutes would retry now, which is the loop it was written to avoid.
  test("waits the delay rather than firing on creation", async () => {
    const { created, outcome } = harness();

    await outcome.run(request());

    expect(created[0]?.runOnCreate).toBe(false);
    expect(created[0]?.cadence).toEqual({ type: "every", everyMs: 600_000 });
  });

  test("marks what it creates, so the turn it fires can be told apart", async () => {
    const { created, outcome } = harness();

    await outcome.run(request());

    expect(created[0]?.createdByRule).toBe(true);
  });

  // One generation, the cap `start` and `fork` keep. This is the same agent
  // throughout, so nothing on it says where the turn came from: the seam reads
  // the run and says so, and without this the schedule's turn ends, reaches the
  // seam, and schedules another.
  test("will not schedule from a turn a rule scheduled", async () => {
    const { created, outcome } = harness();

    const result = await outcome.run(request({ causedByRuleSchedule: true }));

    expect(result.status).toBe("declined");
    expect(created).toEqual([]);
  });
});

describe("parseDelay", () => {
  test("reads the units a person would type", () => {
    expect(parseDelay("30s")).toBe(30_000);
    expect(parseDelay("10m")).toBe(600_000);
    expect(parseDelay("2h")).toBe(7_200_000);
    expect(parseDelay("1d")).toBe(86_400_000);
  });

  test("tolerates spacing and case", () => {
    expect(parseDelay(" 10 M ")).toBe(600_000);
  });

  // Every default here is wrong: guessing minutes turns a typo into an agent
  // waking at the wrong time, and guessing zero turns it into one waking now,
  // which is the thing this outcome exists not to do.
  test("refuses anything it cannot read rather than defaulting", () => {
    for (const value of ["", "soon", "10", "m", "-5m", "0m", "1w", "1.5h", null, undefined, 600]) {
      expect(parseDelay(value)).toBeNull();
    }
  });
});
