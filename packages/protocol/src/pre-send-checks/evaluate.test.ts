import { describe, expect, it } from "vitest";

import { evaluatePreSendChecks, firstRunnablePreSendOutcome } from "./evaluate.js";
import {
  isTextTrigger,
  PRE_SEND_TEXT_TRIGGERS,
  PRE_SEND_TRIGGER_UNITS,
  PRE_SEND_TRIGGERS,
} from "./types.js";
import type { PreSendCheckRule, PreSendMeasurementContext } from "./types.js";

function context(overrides: Partial<PreSendMeasurementContext> = {}): PreSendMeasurementContext {
  return {
    "agent.idleSeconds": null,
    "agent.contextUsedPercent": null,
    "agent.sessionCostUsd": null,
    message: "",
    ...overrides,
  };
}

function rule(overrides: Partial<PreSendCheckRule> = {}): PreSendCheckRule {
  return {
    id: "test-rule",
    measurement: "agent.idleSeconds",
    operator: "gte",
    threshold: 100,
    disposition: "block",
    ...overrides,
  };
}

describe("evaluatePreSendChecks operators", () => {
  const cases: Array<{
    operator: string;
    below: boolean;
    at: boolean;
    above: boolean;
  }> = [
    { operator: "gt", below: false, at: false, above: true },
    { operator: "gte", below: false, at: true, above: true },
    { operator: "lt", below: true, at: false, above: false },
    { operator: "lte", below: true, at: true, above: false },
  ];

  for (const { operator, below, at, above } of cases) {
    it(`${operator} fires below/at/above threshold as ${below}/${at}/${above}`, () => {
      const rules = [rule({ operator })];
      const fired = (idleSeconds: number) =>
        evaluatePreSendChecks(rules, context({ "agent.idleSeconds": idleSeconds })).disposition ===
        "block";

      expect(fired(99)).toBe(below);
      expect(fired(100)).toBe(at);
      expect(fired(101)).toBe(above);
    });
  }
});

describe("evaluatePreSendChecks measurements", () => {
  it("reads contextUsedPercent", () => {
    const rules = [rule({ measurement: "agent.contextUsedPercent", threshold: 80 })];
    expect(
      evaluatePreSendChecks(rules, context({ "agent.contextUsedPercent": 81 })).disposition,
    ).toBe("block");
    expect(
      evaluatePreSendChecks(rules, context({ "agent.contextUsedPercent": 79 })).disposition,
    ).toBe("allow");
  });

  it("reads sessionCostUsd", () => {
    const rules = [rule({ measurement: "agent.sessionCostUsd", threshold: 5 })];
    expect(
      evaluatePreSendChecks(rules, context({ "agent.sessionCostUsd": 5.01 })).disposition,
    ).toBe("block");
    expect(
      evaluatePreSendChecks(rules, context({ "agent.sessionCostUsd": 4.99 })).disposition,
    ).toBe("allow");
  });
});

describe("evaluatePreSendChecks findings", () => {
  it("reports the tripped rule with the value that tripped it", () => {
    const evaluation = evaluatePreSendChecks(
      [
        rule({
          id: "cold",
          disposition: "warn",
          message: "Idle for {{duration}}.",
        }),
      ],
      context({ "agent.idleSeconds": 250 }),
    );

    // A rule written in the old vocabulary reports a finding in the new one,
    // which is the whole of what the normaliser buys the evaluator.
    expect(evaluation.findings).toEqual([
      {
        ruleId: "cold",
        trigger: "agent.idleSeconds",
        disposition: "warn",
        value: 250,
        operand: 100,
        message: "Idle for {{duration}}.",
        outcomes: [{ kind: "warn" }],
      },
    ]);
  });

  it("reports a null message when the rule carries none", () => {
    const evaluation = evaluatePreSendChecks([rule()], context({ "agent.idleSeconds": 250 }));
    expect(evaluation.findings[0]?.message).toBeNull();
  });

  it("keeps findings in rule order", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "first", disposition: "warn" }), rule({ id: "second" })],
      context({ "agent.idleSeconds": 250 }),
    );
    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["first", "second"]);
  });
});

describe("evaluatePreSendChecks aggregation", () => {
  it("allows with no findings when nothing trips", () => {
    const evaluation = evaluatePreSendChecks([rule()], context({ "agent.idleSeconds": 1 }));
    expect(evaluation).toEqual({ disposition: "allow", findings: [] });
  });

  it("warns when only warn rules trip", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ disposition: "warn" })],
      context({ "agent.idleSeconds": 250 }),
    );
    expect(evaluation.disposition).toBe("warn");
  });

  it("blocks when a block rule trips after a warn rule", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "a", disposition: "warn" }), rule({ id: "b", disposition: "block" })],
      context({ "agent.idleSeconds": 250 }),
    );
    expect(evaluation.disposition).toBe("block");
  });

  it("blocks when a block rule trips before a warn rule", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "a", disposition: "block" }), rule({ id: "b", disposition: "warn" })],
      context({ "agent.idleSeconds": 250 }),
    );
    expect(evaluation.disposition).toBe("block");
  });
});

// Every one of these is a rule the evaluator cannot read. It must cost that rule
// and let the send through, rather than blocking on a config it does not
// understand.
describe("evaluatePreSendChecks fails open", () => {
  const tripping = context({ "agent.idleSeconds": 250 });

  const unreadable: Array<[string, PreSendCheckRule, PreSendMeasurementContext]> = [
    ["unknown measurement", rule({ measurement: "agent.phaseOfMoon" }), tripping],
    ["unknown operator", rule({ operator: "grt" }), tripping],
    ["unknown disposition", rule({ disposition: "explode" }), tripping],
    ["non-finite threshold", rule({ threshold: Number.NaN }), tripping],
    ["non-numeric threshold", rule({ threshold: "100" as unknown as number }), tripping],
    ["unmeasured value", rule(), context()],
    ["non-finite value", rule(), context({ "agent.idleSeconds": Number.NaN })],
  ];

  for (const [name, unreadableRule, measurements] of unreadable) {
    it(`skips a rule with an ${name}`, () => {
      expect(evaluatePreSendChecks([unreadableRule], measurements)).toEqual({
        disposition: "allow",
        findings: [],
      });
    });
  }

  it("does not let an unreadable rule suppress a later valid one", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ id: "bad", measurement: "agent.phaseOfMoon" }), rule({ id: "good" })],
      tripping,
    );
    expect(evaluation.disposition).toBe("block");
    expect(evaluation.findings.map((finding) => finding.ruleId)).toEqual(["good"]);
  });

  it("allows an empty rule list", () => {
    expect(evaluatePreSendChecks([], tripping)).toEqual({
      disposition: "allow",
      findings: [],
    });
  });
});

// The three cases that pinned the shipped cold-prompt-cache rule moved to the
// server's seeder test, where they now assert against the file the daemon actually
// writes rather than a constant this package no longer owns.

function trigger(overrides: Partial<PreSendCheckRule> = {}): PreSendCheckRule {
  return {
    id: "aside",
    measurement: "message",
    operator: "startsWith",
    text: "/btw",
    disposition: "redirect",
    action: { kind: "aside" },
    ...overrides,
  };
}

describe("text triggers", () => {
  it("fires on a message that starts with the trigger", () => {
    const evaluation = evaluatePreSendChecks(
      [trigger()],
      context({ message: "/btw what is this" }),
    );
    expect(evaluation.disposition).toBe("redirect");
    expect(evaluation.findings[0]?.outcomes).toEqual([{ kind: "aside" }]);
    expect(evaluation.findings[0]?.value).toBe("/btw what is this");
  });

  it("ignores leading whitespace and case", () => {
    expect(
      evaluatePreSendChecks([trigger()], context({ message: "  /BTW quick one" })).disposition,
    ).toBe("redirect");
  });

  // Anchored on purpose: a message merely mentioning the trigger is a message
  // about asides, not an aside.
  it("does not fire when the trigger appears mid-message", () => {
    expect(
      evaluatePreSendChecks([trigger()], context({ message: "explain how /btw works" }))
        .disposition,
    ).toBe("allow");
  });

  it("matches anywhere for contains", () => {
    const rules = [trigger({ operator: "contains" })];
    expect(
      evaluatePreSendChecks(rules, context({ message: "explain how /btw works" })).disposition,
    ).toBe("redirect");
  });

  // A redirect consumes the message rather than sending it, so anything that
  // makes the redirect unperformable has to fall back to an ordinary send. Each
  // of these would otherwise swallow what was typed.
  it("declines a redirect whose action kind is unknown", () => {
    const rules = [trigger({ action: { kind: "teleport" } })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  it("declines a redirect carrying no action at all", () => {
    const rules = [trigger({ action: undefined })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  it("declines a trigger with empty text rather than matching everything", () => {
    const rules = [trigger({ text: "" })];
    expect(evaluatePreSendChecks(rules, context({ message: "anything" })).disposition).toBe(
      "allow",
    );
  });

  it("skips a text measurement compared with a numeric operator", () => {
    const rules = [trigger({ operator: "gte" })];
    expect(evaluatePreSendChecks(rules, context({ message: "/btw hi" })).disposition).toBe("allow");
  });

  // A redirect takes the message somewhere else, so the reasons to hold a send
  // back have nothing left to act on.
  it("outranks a block that also matched", () => {
    const rules = [trigger(), rule({ id: "cold", disposition: "block" })];
    const evaluation = evaluatePreSendChecks(
      rules,
      context({ message: "/btw hi", "agent.idleSeconds": 999 }),
    );
    expect(evaluation.disposition).toBe("redirect");
    expect(evaluation.findings).toHaveLength(2);
  });
});

/**
 * The reason outcomes are a list: one condition usually deserves more than one
 * answer, and writing the condition twice to get two answers means keeping two
 * copies of it in step by hand.
 */
describe("a rule with several outcomes", () => {
  const both = rule({
    trigger: "message",
    measurement: "message",
    operator: "startsWith",
    value: "/btw",
    outcomes: [{ kind: "warn" }, { kind: "aside", title: "Aside" }],
  });

  // "block OR block + ask on the side" - the combination this feature was asked
  // for by name.
  it("keeps every outcome on the finding", () => {
    const evaluation = evaluatePreSendChecks([both], context({ message: "/btw quick one" }));

    expect(evaluation.findings[0]?.outcomes).toEqual([
      { kind: "warn" },
      { kind: "aside", title: "Aside" },
    ]);
  });

  // One send goes one place, so the rule's disposition is whichever outcome
  // decides the most - the same resolution two separate rules already got.
  it("takes its disposition from the most severe outcome", () => {
    expect(evaluatePreSendChecks([both], context({ message: "/btw" })).disposition).toBe(
      "redirect",
    );
  });

  // Dropping the whole rule would mean an app one version ahead silently
  // disarming a rule on every older host it is assigned to.
  it("carries out the half this build understands", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ outcomes: [{ kind: "teleport" }, { kind: "warn" }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.disposition).toBe("warn");
    expect(evaluation.findings[0]?.outcomes).toEqual([{ kind: "warn" }]);
  });

  it("skips a rule whose every outcome is unreadable", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ outcomes: [{ kind: "teleport" }, { kind: "levitate" }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.findings).toEqual([]);
  });
});

describe("firstRunnablePreSendOutcome", () => {
  // A send goes one place, and the findings arrive in the arrangement someone
  // chose, so the first is an answer a person can predict.
  it("takes the first runnable outcome across the findings in order", () => {
    const evaluation = evaluatePreSendChecks(
      [
        rule({ id: "warns", order: 0, outcomes: [{ kind: "warn" }] }),
        rule({ id: "asks", order: 1, outcomes: [{ kind: "warn" }, { kind: "aside" }] }),
        rule({ id: "forks", order: 2, outcomes: [{ kind: "fork" }] }),
      ],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(firstRunnablePreSendOutcome(evaluation.findings)).toEqual({ kind: "aside" });
  });

  it("answers null when nothing that tripped asked for a runner", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ outcomes: [{ kind: "warn" }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(firstRunnablePreSendOutcome(evaluation.findings)).toBeNull();
  });
});

/**
 * Wording moved onto the outcome because on the rule it was shared by outcomes
 * that do not all use it: a rule whose only outcome was an `aside` still offered
 * a Message box, and the composer redirects before it ever renders one.
 */
describe("wording on the outcome", () => {
  it("takes the sentence from the outcome that decided the disposition", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ outcomes: [{ kind: "block", wording: "Too cold." }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.findings[0]?.message).toBe("Too cold.");
  });

  // Not the first outcome, and not any outcome: the one whose result is what a
  // person will actually see.
  it("ignores the wording of an outcome that did not decide", () => {
    const evaluation = evaluatePreSendChecks(
      [
        rule({
          outcomes: [
            { kind: "warn", wording: "Only a warning." },
            { kind: "block", wording: "Held." },
          ],
        }),
      ],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.disposition).toBe("block");
    expect(evaluation.findings[0]?.message).toBe("Held.");
  });

  // A rule written before wording moved still says what its author wrote.
  it("falls back to the retiring rule-level message", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ message: "From the old field.", outcomes: [{ kind: "block" }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.findings[0]?.message).toBe("From the old field.");
  });

  // Blank is absent: a field someone cleared should fall through to the
  // translated default rather than firing an empty toast.
  it("treats blank wording as none", () => {
    const evaluation = evaluatePreSendChecks(
      [rule({ outcomes: [{ kind: "block", wording: "   " }] })],
      context({ "agent.idleSeconds": 250 }),
    );

    expect(evaluation.findings[0]?.message).toBeNull();
  });
});

/**
 * The guarantee the reshape bought.
 *
 * Before it, `PreSendTrigger` was declared and referenced nowhere: a trigger
 * added to `PRE_SEND_TRIGGERS` compiled clean, was offered by the editor, saved
 * into a rule, and then fell through three separate defaults — the evaluator's
 * switch, the unit formatter, and the app's wording table. Most of that is now a
 * type error, which no test can assert. What a test *can* pin is the half that
 * stays a runtime concern: every declared trigger is readable, and one nobody
 * declared is skipped rather than thrown on.
 */
describe("every declared trigger is wired end to end", () => {
  it("gives each trigger a unit", () => {
    for (const declared of PRE_SEND_TRIGGERS) {
      expect(PRE_SEND_TRIGGER_UNITS[declared]).toBeTypeOf("string");
    }
  });

  // The list that used to be written out twice.
  it("derives the text triggers from the unit table", () => {
    expect([...PRE_SEND_TEXT_TRIGGERS]).toEqual([
      "agent.lastError",
      "agent.provider",
      "agent.model",
      "message",
    ]);
    expect(isTextTrigger("message")).toBe(true);
    expect(isTextTrigger("agent.idleSeconds")).toBe(false);
  });

  // Every numeric trigger reads the value put under its own key, and reads
  // nothing when the key is absent. One loop rather than three near-identical
  // cases, because the whole point is that they no longer differ.
  it("reads each numeric trigger from its own key", () => {
    for (const declared of PRE_SEND_TRIGGERS) {
      if (PRE_SEND_TRIGGER_UNITS[declared] === "text" || declared === "always") {
        continue;
      }
      const numeric = rule({
        trigger: declared,
        measurement: declared,
        operator: "gte",
        value: 10,
      });

      expect(evaluatePreSendChecks([numeric], context({ [declared]: 11 })).disposition).toBe(
        "block",
      );
      expect(evaluatePreSendChecks([numeric], context({ [declared]: 9 })).disposition).toBe(
        "allow",
      );
      expect(evaluatePreSendChecks([numeric], context()).disposition).toBe("allow");
    }
  });

  // Fail open: a rule from a newer daemon costs that rule and nothing else.
  it("skips a trigger this build never declared", () => {
    const unknown = rule({ trigger: "agent.phaseOfMoon", measurement: "agent.phaseOfMoon" });

    expect(
      evaluatePreSendChecks([unknown], context({ "agent.phaseOfMoon": 500 })).findings,
    ).toEqual([]);
  });

  // A numeric rule pointed at the text trigger gets nothing rather than NaN.
  it("does not read a string as a number", () => {
    const crossed = rule({ trigger: "message", measurement: "message", operator: "gte", value: 1 });

    expect(evaluatePreSendChecks([crossed], context({ message: "hello" })).findings).toEqual([]);
  });
});
