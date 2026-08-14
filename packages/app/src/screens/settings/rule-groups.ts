import type { Rule } from "@getpaseo/protocol/rules/types";
import type { RuleTranslate } from "@/composer/rules";

/**
 * Rules live one directory per daemon, so "this rule on three hosts" is the same
 * rule written into three stores. This module is the other half of that: turning
 * what several hosts each returned back into one list a person can read.
 *
 * Pure on purpose. The interesting parts — which host order wins, what counts as
 * two hosts disagreeing, and what a save has to write and delete — are all
 * decisions that deserve a test that needs no daemon and no DOM.
 */

export interface RuleHostRules {
  serverId: string;
  serverName: string;
  /**
   * `null` when this host has not produced a list: disconnected, too old to serve
   * the verb, or still loading. Never `[]` for those — an empty array is a host
   * that answered and has no rules, and the two must not be confused when the
   * answer decides whether a rule is missing from a host or merely unknown there.
   */
  rules: readonly Rule[] | null;
}

export interface RuleGroup {
  id: string;
  /**
   * The version shown in the list and loaded into the editor: the one from the
   * first host that carries it. When the hosts disagree, editing and saving this
   * one writes it to all of them, which is how drift is resolved — there is no
   * separate reconcile action because saving already is one.
   */
  rule: Rule;
  /** The hosts carrying this rule, in host order. */
  serverIds: string[];
  /** The same, named, so a row can say where a rule lives without a lookup. */
  serverNames: string[];
  /** True when the hosts carrying it do not agree on its content. */
  differs: boolean;
}

/**
 * One list from several.
 *
 * Hosts are walked in the order given and each host's rules in the order that
 * host returned them, appending ids not seen yet. So the first host's
 * arrangement leads and any rule only the later hosts have follows it — stable,
 * and it does not reshuffle when a host goes offline and its rules drop out.
 *
 * A host whose rules are `null` contributes nothing rather than removing
 * anything: not knowing what a host holds is not the same as knowing it holds
 * nothing.
 */
export function groupRules(hosts: readonly RuleHostRules[]): RuleGroup[] {
  const groups = new Map<string, RuleGroup>();
  const fingerprints = new Map<string, string>();

  for (const host of hosts) {
    for (const rule of host.rules ?? []) {
      const existing = groups.get(rule.id);
      if (!existing) {
        groups.set(rule.id, {
          id: rule.id,
          rule,
          serverIds: [host.serverId],
          serverNames: [host.serverName],
          differs: false,
        });
        fingerprints.set(rule.id, fingerprintRule(rule));
        continue;
      }
      existing.serverIds.push(host.serverId);
      existing.serverNames.push(host.serverName);
      if (fingerprints.get(rule.id) !== fingerprintRule(rule)) {
        existing.differs = true;
      }
    }
  }

  return [...groups.values()];
}

/**
 * What a save has to do to put a rule on exactly the chosen hosts.
 *
 * `write` is every target, not only the new ones — a host that already has the
 * rule still needs the edit. `remove` is what was deselected. There is no
 * transaction across hosts and there cannot be one, so a caller runs these and
 * reports what each host did rather than pretending the set moved at once.
 */
export interface RuleSavePlan {
  write: string[];
  remove: string[];
}

export function planRuleSave(input: {
  currentServerIds: readonly string[];
  targetServerIds: readonly string[];
}): RuleSavePlan {
  const targets = new Set(input.targetServerIds);
  return {
    write: [...targets],
    remove: input.currentServerIds.filter((serverId) => !targets.has(serverId)),
  };
}

export interface RuleHostOutcome {
  serverId: string;
  serverName: string;
  error: string | null;
}

/**
 * What to say when a fan-out only partly worked.
 *
 * `null` when everything succeeded, so a caller can treat a message as the
 * failure signal. The successes are named alongside the failures because the
 * successful writes are not rolled back and the person needs to know the rule is
 * now live on some hosts and not others — a message that only listed what broke
 * would read as though nothing had happened.
 */
export function describeRuleOutcomes(
  outcomes: readonly RuleHostOutcome[],
  t: RuleTranslate,
): string | null {
  const failed = outcomes.filter((outcome) => outcome.error);
  if (failed.length === 0) {
    return null;
  }
  const succeeded = outcomes.filter((outcome) => !outcome.error);
  const parts = failed.map((outcome) =>
    t("settings.rules.hostFailed", {
      host: outcome.serverName,
      reason: outcome.error,
    }),
  );
  if (succeeded.length > 0) {
    parts.unshift(
      t("settings.rules.hostsSucceeded", {
        hosts: succeeded.map((outcome) => outcome.serverName).join(", "),
      }),
    );
  }
  return parts.join(" ");
}

/**
 * The content of a rule with its position left out.
 *
 * `order` is assigned per host by index over that host's own rules, so two hosts
 * carrying different subsets hold different numbers for the same rule as a matter
 * of course. Counting that as disagreement would mark every multi-host group as
 * drifted and make the badge meaningless.
 *
 * Keys are sorted at every depth because these are JSON files on disk that
 * different daemon versions may have written in different key orders, and a
 * difference nobody can see is not a difference.
 */
function fingerprintRule(rule: Rule): string {
  const { order: _order, ...rest } = rule;
  return stableStringify(rest);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
