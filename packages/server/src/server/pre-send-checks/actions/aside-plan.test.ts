import { describe, expect, it } from "vitest";
import { ASIDE_REPLAY_CONFIRM_TOKENS, estimateTokens, planAside } from "./aside-plan.js";

const LARGE = (ASIDE_REPLAY_CONFIRM_TOKENS + 1000) * 4;
const SMALL = 400;

describe("planAside", () => {
  it("resumes when the provider kept the conversation", () => {
    expect(planAside({ canResume: true, transcriptChars: LARGE, confirmed: false })).toEqual({
      decision: "run",
      route: "resume",
    });
  });

  // Nothing to warn about: the expensive part is already cached, so the question
  // costs what it looks like it costs however long the conversation is.
  it("never asks before resuming, however large the conversation", () => {
    expect(
      planAside({ canResume: true, transcriptChars: LARGE * 10, confirmed: false }).decision,
    ).toBe("run");
  });

  it("replays without asking when the transcript is small", () => {
    expect(planAside({ canResume: false, transcriptChars: SMALL, confirmed: false })).toEqual({
      decision: "run",
      route: "replay",
    });
  });

  it("asks before replaying a large transcript", () => {
    const plan = planAside({ canResume: false, transcriptChars: LARGE, confirmed: false });
    expect(plan.decision).toBe("confirm");
    expect(plan).toMatchObject({ route: "replay" });
    if (plan.decision === "confirm") {
      expect(plan.estimatedTokens).toBeGreaterThan(ASIDE_REPLAY_CONFIRM_TOKENS);
    }
  });

  it("proceeds once the caller has confirmed", () => {
    expect(planAside({ canResume: false, transcriptChars: LARGE, confirmed: true })).toEqual({
      decision: "run",
      route: "replay",
    });
  });

  // The boundary is worth pinning because the threshold is the whole feature of
  // this function: one token either side changes whether someone is interrupted.
  it("does not ask exactly at the threshold", () => {
    expect(
      planAside({
        canResume: false,
        transcriptChars: ASIDE_REPLAY_CONFIRM_TOKENS * 4,
        confirmed: false,
      }).decision,
    ).toBe("run");
  });
});

describe("estimateTokens", () => {
  it("rounds up so a short transcript is never estimated at zero", () => {
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(0)).toBe(0);
  });
});
