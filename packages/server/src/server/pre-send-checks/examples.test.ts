import { describe, expect, test } from "vitest";
import {
  isPlainOutcomeKind,
  PreSendCheckExampleSchema,
} from "@getpaseo/protocol/pre-send-checks/types";
import { PRE_SEND_CHECK_EXAMPLES, listPreSendCheckExamples } from "./examples.js";
import { PRE_SEND_OUTCOME_DESCRIPTORS } from "./outcomes/descriptors.js";

describe("pre-send check examples", () => {
  test("every shipped example is a valid example", () => {
    for (const example of PRE_SEND_CHECK_EXAMPLES) {
      expect(() => PreSendCheckExampleSchema.parse(example)).not.toThrow();
    }
  });

  // Two examples under one id would make the app's translation lookup ambiguous
  // and give two rows the same key.
  test("example ids are unique", () => {
    const ids = PRE_SEND_CHECK_EXAMPLES.map((example) => example.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // An example is a template, so carrying an id inside the rule would be one the
  // app has to remember to discard before saving.
  test("no example carries a rule id", () => {
    for (const example of PRE_SEND_CHECK_EXAMPLES) {
      expect(example.rule).not.toHaveProperty("id");
    }
  });

  test("what ships is offered by a daemon that has the runners for it", () => {
    const offered = listPreSendCheckExamples();

    expect(offered.map((example) => example.id)).toEqual(
      PRE_SEND_CHECK_EXAMPLES.map((example) => example.id),
    );
    expect(offered.some((example) => example.rule.outcomes[0]?.kind ?? "" === "aside")).toBe(true);
  });

  // Installing an example whose outcome the daemon declines would redirect a
  // message into nothing, with the person's text coming back unsent and no sign
  // of why the rule they just chose did nothing.
  test("drops an example naming an outcome this daemon cannot perform", () => {
    const offered = listPreSendCheckExamples(PRE_SEND_CHECK_EXAMPLES, []);

    expect(
      offered.every((example) => isPlainOutcomeKind(example.rule.outcomes[0]?.kind ?? "")),
    ).toBe(true);
    expect(offered.length).toBeGreaterThan(0);
  });

  // A warn or a block asks nothing of the daemon beyond evaluating it, so it is
  // offered whatever runners the daemon has.
  test("keeps every plain example whatever the daemon can do", () => {
    const plain = PRE_SEND_CHECK_EXAMPLES.filter((example) =>
      isPlainOutcomeKind(example.rule.outcomes[0]?.kind ?? ""),
    );

    expect(listPreSendCheckExamples(PRE_SEND_CHECK_EXAMPLES, [])).toEqual(plain);
  });

  test("every outcome an example names is one this daemon describes", () => {
    const kinds = PRE_SEND_OUTCOME_DESCRIPTORS.map((descriptor) => descriptor.kind);

    for (const example of PRE_SEND_CHECK_EXAMPLES) {
      const kind = example.rule.outcomes[0]?.kind ?? "";
      if (!isPlainOutcomeKind(kind)) {
        expect(kinds).toContain(kind);
      }
    }
  });
});
