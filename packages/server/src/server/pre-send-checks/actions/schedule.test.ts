import { describe, expect, test } from "vitest";
import { parseDelay } from "./schedule.js";

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
