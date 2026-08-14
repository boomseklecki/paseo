import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { describe, expect, test } from "vitest";

import type { PushNotificationSender } from "../push/index.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

/**
 * The whole daemon-side path over the wire: a rule on `turn.failed` fires when a
 * turn fails, and the notification carries the rule's own wording.
 *
 * No real provider — the fake one fails a turn on request, which is the point.
 * What only an end-to-end run can show is that the seam reaches the rules at
 * all: the evaluation and the edge trigger are unit-tested, and everything
 * between them and a client is wiring that either connects or does not.
 */
async function seedRule(paseoHomeRoot: string, rule: Record<string, unknown>): Promise<void> {
  const dir = path.join(paseoHomeRoot, ".paseo", "pre-send-checks");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${String(rule.id)}.json`), JSON.stringify(rule), "utf-8");
}

describe("daemon E2E (rule on turn.failed)", () => {
  test("notifies with the rule's message when a turn fails", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-e2e-"));
    // Seeded before the daemon starts, because ensureSeeded only writes the
    // defaults when the directory does not exist at all.
    await seedRule(paseoHomeRoot, {
      id: "any-failure",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn failed and you asked to be told.",
    });

    // Captured rather than sent. The push leg is the one that reaches a phone
    // when nobody is at the machine, and it is worth an assertion precisely
    // because `error` is deliberately *not* push-eligible
    // (`agent-attention-policy.ts`) - so a rule is the only way a failed turn
    // reaches a device at all, and nothing else in the suite says so.
    const pushed: Array<{
      title: string;
      body: string;
      reason: unknown;
      requiredCapability?: string;
    }> = [];
    const pushNotificationSender: PushNotificationSender = {
      send: async (notification, options) => {
        pushed.push({
          title: notification.title,
          body: notification.body,
          reason: notification.data?.reason,
          requiredCapability: options?.requiredCapability,
        });
      },
    };

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    const attention: Array<{ reason: string; body?: string }> = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-e2e" } });
      client.onAgentAttentionRequired((payload) => {
        attention.push({
          reason: payload.reason,
          body: payload.notification?.body,
        });
      });

      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Failing",
      });
      // The workspace is what the notification is attributed to; without one the
      // daemon withholds attention entirely, rule or not.
      expect(agent.workspaceId).not.toBeUndefined();

      await client.sendMessage(agent.id, "Please emit a turn failure");

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !attention.some((entry) => entry.reason === "rule")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      const ruleAttention = attention.filter((entry) => entry.reason === "rule");
      expect(ruleAttention).toHaveLength(1);
      expect(ruleAttention[0]?.body).toBe("That turn failed and you asked to be told.");

      // The built-in error notification is still sent and is a different thing:
      // it says the agent stopped, where the rule says what its author asked to
      // be told. A rule does not replace it.
      expect(attention.some((entry) => entry.reason === "error")).toBe(true);

      // And the built-in one never leaves the machine. Only the rule pushes, so
      // the phone gets exactly one notification and it is the one somebody
      // asked for, in their own words.
      expect(pushed.map((entry) => entry.reason)).toEqual(["rule"]);
      expect(pushed[0]?.title).toBe("A rule fired");
      expect(pushed[0]?.body).toBe("That turn failed and you asked to be told.");

      // And it goes only to a device that can render what it is about. The
      // websocket leg makes this check per connection; a push has none, so it is
      // asked of the store instead.
      expect(pushed[0]?.requiredCapability).toBe("rule_attention");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // The other daemon seam, and the one that answers "where has this
  // conversation got to". Both ride transitions the manager already detects, so
  // the risk worth testing is that they do not fire for each other.
  test("fires a turn.completed rule when a turn succeeds, and not the failure one", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-done-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "any-completion",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn finished.",
    });
    await seedRule(paseoHomeRoot, {
      id: "any-failure",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn failed.",
    });

    const pushed: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender: {
        send: async (notification) => {
          pushed.push(notification.body);
        },
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-done-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Finishing",
      });

      // An ordinary prompt, so the fake provider completes the turn rather than
      // failing it.
      await client.sendMessage(agent.id, "Say hello");

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !pushed.includes("That turn finished.")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Two pushes, and both belong. Unlike `error`, the built-in `finished`
      // attention *is* push-eligible, so a completed turn already reaches a
      // phone carrying the agent's last message. The rule adds a second saying
      // the thing the built-in cannot know to say - and only on the crossing,
      // which is what keeps "context is over 80%" from being every turn from
      // here to the end of the conversation.
      expect(pushed).toContain("That turn finished.");
      expect(pushed).toContain("Hello world");

      // The failure rule is seeded and must stay silent: the seams ride
      // different transitions and must not fire for each other.
      expect(pushed).not.toContain("That turn failed.");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // An action at a daemon seam: the same hidden agent /btw uses, asked without
  // anyone typing. This is the handoff case - write the summary before the
  // conversation compacts - and the whole point is that it happens with nobody
  // at the keyboard.
  test("runs an aside from a daemon seam and attaches it to the conversation", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-aside-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "handoff",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "aside", title: "Handoff", prompt: "Write the handoff." },
    });

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-aside-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Working",
      });

      await client.sendMessage(agent.id, "Say hello");

      let subagents: Awaited<ReturnType<typeof client.listProviderSubagents>>["subagents"] = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && subagents.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        subagents = (await client.listProviderSubagents(agent.id)).subagents;
      }

      // It ran, it belongs to the conversation that triggered it, and it is
      // titled by the rule rather than by the action's default.
      expect(subagents).toHaveLength(1);
      expect(subagents[0]?.parentAgentId).toBe(agent.id);
      expect(subagents[0]?.title).toBe("Handoff");

      // And the parent never took a turn for it: the aside is attached to the
      // conversation without being part of it.
      const timeline = await client.fetchAgentTimeline(agent.id);
      const asked = JSON.stringify(timeline).includes("Write the handoff.");
      expect(asked).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  /**
   * The reason outcomes are a list, end to end.
   *
   * The shipped `handoff-before-compaction` example is exactly this pair, and
   * two things about it can only be seen with a real daemon: that both outcomes
   * run from one crossing, and that the phone is buzzed **once** rather than
   * once per outcome. The second is what a list of outcomes could easily have
   * cost, and no unit test covers it — the announcement is collapsed in the
   * websocket server, above everything the evaluator knows about.
   */
  test("runs both of a rule's outcomes and notifies once", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-both-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "handoff-and-tell-me",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcomes: [
        { kind: "aside", title: "Handoff", prompt: "Write the handoff." },
        { kind: "notify" },
      ],
      message: "The handoff is under subagents.",
    });

    // By reason, because the built-in "your agent finished" notification is
    // push-eligible and lands here too. What is being counted is the rule's.
    const pushed: Array<{ reason: unknown; body: string }> = [];
    const pushNotificationSender: PushNotificationSender = {
      send: async (notification) => {
        pushed.push({ reason: notification.data?.reason, body: notification.body });
      },
    };

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    const attention: string[] = [];
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-both-e2e" } });
      client.onAgentAttentionRequired((payload) => {
        attention.push(payload.reason);
      });

      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Working",
      });

      await client.sendMessage(agent.id, "Say hello");

      let subagents: Awaited<ReturnType<typeof client.listProviderSubagents>>["subagents"] = [];
      const rulePushes = () => pushed.filter((entry) => entry.reason === "rule");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (subagents.length === 0 || rulePushes().length === 0)) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        subagents = (await client.listProviderSubagents(agent.id)).subagents;
      }
      // A second notification would arrive after the first, so waiting only for
      // the first would pass whether or not there is another behind it.
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // The aside half.
      expect(subagents).toHaveLength(1);
      expect(subagents[0]?.title).toBe("Handoff");

      // The notify half, in the rule's own words, exactly once - not once for
      // the aside starting and again for the notify.
      expect(rulePushes().map((entry) => entry.body)).toEqual(["The handoff is under subagents."]);
      expect(attention.filter((reason) => reason === "rule")).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // Fork exists in Paseo as a button on a conversation you are looking at. As an
  // outcome it becomes something a rule can ask for - which is what makes it a
  // shortcut rather than a click.
  test("forks a conversation into a real agent that carries it", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-fork-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "fork-on-failure",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "fork", title: "Second attempt" },
    });

    const pushedFork: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      pushNotificationSender: {
        send: async (notification) => {
          pushedFork.push(String(notification.data?.reason ?? ""));
        },
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-fork-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Original",
      });

      await client.sendMessage(agent.id, "Please emit a turn failure");

      // `entries`, and each wraps its agent - the shape a probe got wrong once
      // already by reading entry.id.
      let forked: Array<{ id: string; title?: string; workspaceId?: string; cwd: string }> = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && forked.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const entries = (await client.fetchAgents({})).entries;
        forked = entries.map((entry) => entry.agent).filter((found) => found.id !== agent.id);
      }

      // A real agent, visible in the list beside its parent - not a hidden
      // subagent. That is the whole difference between fork and aside.
      // It announced itself. A notify says so by existing; a fork happens on a
      // machine nobody is watching, so it raises the same attention rather than
      // succeeding in silence.
      expect(pushedFork).toContain("rule");

      expect(forked).toHaveLength(1);
      expect(forked[0]?.title).toBe("Second attempt");
      expect(forked[0]?.workspaceId).toBe(agent.workspaceId);
      expect(forked[0]?.cwd).toBe(agent.cwd);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // start is fork without the transcript, and the missing transcript is the
  // point: the rule fires because the conversation is full, so carrying it in
  // would carry the very thing that triggered it.
  test("starts a fresh agent carrying none of the conversation", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-start-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "start-fresh",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "start", title: "Continued" },
    });

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-start-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Original",
      });

      await client.sendMessage(agent.id, "Say hello");

      let started: Array<{ id: string; title?: string; workspaceId?: string }> = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && started.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        started = (await client.fetchAgents({})).entries
          .map((entry) => entry.agent)
          .filter((found) => found.id !== agent.id);
      }

      expect(started).toHaveLength(1);
      expect(started[0]?.title).toBe("Continued");
      expect(started[0]?.workspaceId).toBe(agent.workspaceId);

      // The difference from fork, and the reason this outcome exists: its
      // timeline is empty rather than carrying the parent's.
      const timeline = await client.fetchAgentTimeline(started[0]!.id);
      expect(JSON.stringify(timeline)).not.toContain("Hello world");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  // The runaway this guard exists for: a turn.completed rule that starts an
  // agent, whose turn completes, which starts another. The edge trigger cannot
  // see it - every new agent is a new id with nothing remembered - so without a
  // cap this test would not terminate.
  test("stops a creating rule after one generation", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-loop-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "always-start",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      // An opening message, so the agent it makes takes a turn of its own and
      // reaches the very seam that made it.
      outcome: { kind: "start", title: "Spawned", prompt: "Say hello" },
    });

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-loop-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Original",
      });

      await client.sendMessage(agent.id, "Say hello");
      // Long enough that an ungoverned chain would be well past two by now.
      await new Promise((resolve) => setTimeout(resolve, 12_000));

      const all = (await client.fetchAgents({})).entries.map((entry) => entry.agent);
      // The original and exactly one it made. The second generation is refused
      // because the agent asking carries the label the first one stamped.
      expect(all).toHaveLength(2);
      expect(all.filter((found) => found.title === "Spawned")).toHaveLength(1);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 90_000);

  /**
   * The host switch, at a daemon seam.
   *
   * It reads as a daemon-wide off and for a while governed only `message.send`,
   * which is evaluated in the app - so turning rules off on a host left three
   * seams firing, pushes included. The guard is one early return in
   * `fireAgentRuleEvent`, because all three daemon seams funnel through it, and
   * an end-to-end run is the only test that would notice a fourth seam wired up
   * somewhere else.
   */
  test("fires nothing at a daemon seam while the host switch is off", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-off-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "any-completion",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn finished.",
    });

    const pushed: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      preSendChecksEnabled: false,
      pushNotificationSender: {
        send: async (notification) => {
          pushed.push(notification.body);
        },
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-off-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Finishing",
      });

      await client.sendMessage(agent.id, "Say hello");

      // Waited on the built-in notification rather than on a timer, so the turn
      // is known to have completed and reached the seam. Without it the test
      // would pass on a daemon that never got that far.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !pushed.includes("Hello world")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pushed).toContain("Hello world");

      expect(pushed).not.toContain("That turn finished.");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);

  /**
   * And what happens when it goes back on, which is a choice rather than
   * fallout.
   *
   * The guard returns before the edge tracker sees anything, so a condition that
   * stayed true the whole time the switch was off is news again at the first
   * seam after it goes back on. Edge-triggered relative to when you were
   * listening, not to when the condition started. Recording findings while
   * suppressed would mean turning rules on and hearing nothing about the agent
   * that has been over 80% for an hour.
   *
   * The tracker answers an `always` rule once per agent and seam, so the second
   * turn firing is only explicable by the first having been suppressed outright.
   * It also shows the switch is read live: no restart between the two turns.
   */
  test("fires at the first crossing after the switch goes back on", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-reenable-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "any-completion",
      event: "turn.completed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "notify" },
      message: "That turn finished.",
    });

    const pushed: string[] = [];
    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      preSendChecksEnabled: false,
      pushNotificationSender: {
        send: async (notification) => {
          pushed.push(notification.body);
        },
      },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-reenable-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Finishing",
      });

      await client.sendMessage(agent.id, "Say hello");
      const firstDeadline = Date.now() + 20_000;
      while (Date.now() < firstDeadline && !pushed.includes("Hello world")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(pushed).not.toContain("That turn finished.");

      await client.patchDaemonConfig({ preSendChecksEnabled: true });

      // The seam rides the manager's attention transition, and the manager
      // raises nothing while an agent already requires attention
      // (`agent-manager.ts`, `checkAndSetAttention`). The first turn left it
      // needing some, so without this the second turn completes and reaches no
      // seam at all - which would fail this test for a reason that has nothing
      // to do with the switch. Clearing it is what looking at the agent does.
      await client.clearAgentAttention(agent.id);

      await client.sendMessage(agent.id, "Say hello");
      const secondDeadline = Date.now() + 20_000;
      while (Date.now() < secondDeadline && !pushed.includes("That turn finished.")) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      expect(pushed).toContain("That turn finished.");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 90_000);

  // schedule shipped dead: it was missing from the runnable outcome kinds, so
  // the evaluator refused it at every seam while the registry, the descriptor
  // and a shipped example all claimed it worked. Only its delay parser had a
  // test. This is the test whose absence allowed that.
  test("creates a schedule from a rule", async () => {
    const logger = pino({ level: "silent" });
    const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-rule-sched-e2e-"));
    await seedRule(paseoHomeRoot, {
      id: "retry-later",
      event: "turn.failed",
      trigger: "always",
      measurement: "always",
      operator: "gte",
      disposition: "redirect",
      outcome: { kind: "schedule", title: "Retry", delay: "10m", prompt: "Try that again." },
    });

    const daemon = await createTestPaseoDaemon({
      agentClients: createTestAgentClients(),
      paseoHomeRoot,
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "rule-sched-e2e" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd: paseoHomeRoot,
        title: "Failing",
      });

      await client.sendMessage(agent.id, "Please emit a turn failure");

      let schedules: Awaited<ReturnType<typeof client.scheduleList>>["schedules"] = [];
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && schedules.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        schedules = (await client.scheduleList()).schedules;
      }

      // An ordinary schedule, which is the point: it lands in the same list any
      // other schedule does, and can be cancelled by someone who never knew a
      // rule made it.
      expect(schedules).toHaveLength(1);
      expect(schedules[0]?.name).toBe("Retry");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
    }
  }, 60_000);
});
