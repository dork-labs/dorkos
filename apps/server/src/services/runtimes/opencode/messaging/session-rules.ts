/**
 * DorkOS's asks, kept on every OpenCode session so a project's own config
 * cannot switch them off (DOR-4394).
 *
 * DorkOS injects its ask config at the top level (`OPENCODE_CONFIG_CONTENT`),
 * but OpenCode decides an ask from the agent's resolved rules, then the
 * session's, and the last match wins. A cloned project's `opencode.json`
 * could therefore turn bash, edits or fetches back to `allow` for the agent
 * that runs the turn: under `agent.<name>`, under the older `mode.<name>`, or
 * by naming its own agent as `default_agent`. Live on the pinned 1.19.3, each
 * of those ran bash with no ask, so DorkOS's shell check never saw it.
 *
 * Two things close it:
 *
 * - **The session carries DorkOS's asks.** Session rules come after every
 *   agent's, so they win whichever agent runs the turn.
 * - **An unsafe task target is refused.** `task` starts whichever agent it
 *   names, a primary one included, and that child session keeps only its
 *   parent's denies, not its asks. So any agent whose own rules would skip the
 *   ask gets a `task` deny, which also passes down to anything it would start.
 *
 * @module services/runtimes/opencode/messaging/session-rules
 */
import { OPENCODE_SIDECAR_CONFIG } from '../server-manager.js';

/** One OpenCode permission rule, as a session or an agent stores it. */
export interface OpenCodeRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

/** An agent as `GET /agent` resolves it: its kind and its whole ruleset. */
export interface OpenCodeAgentRules {
  name: string;
  mode: 'primary' | 'subagent' | 'all';
  permission: readonly OpenCodeRule[];
}

/** DorkOS's injected asks, as rules, in the order the sidecar resolves them. */
export const DORKOS_SESSION_RULES: readonly OpenCodeRule[] = Object.entries(
  OPENCODE_SIDECAR_CONFIG.permission
).flatMap(([permission, value]) =>
  typeof value === 'string'
    ? [{ permission, pattern: '*', action: value }]
    : Object.entries(value).map(([pattern, action]) => ({ permission, pattern, action }))
);

/**
 * Every rule DorkOS keeps on a session: its injected asks, then a reach
 * outside the session's folder, which DorkOS's folder grants answer
 * (`directory-grants.ts`). OpenCode asks for that by default, so a project
 * could turn it to `allow`. The sidecar's own tool output and plans stay open,
 * as OpenCode leaves them, so reading its own output never asks.
 *
 * @param dataDir - The sidecar's data folder (`resolveOpenCodeDataDir`).
 */
export function dorkosSessionRules(dataDir: string): OpenCodeRule[] {
  return [
    ...DORKOS_SESSION_RULES,
    { permission: 'external_directory', pattern: '*', action: 'ask' },
    { permission: 'external_directory', pattern: `${dataDir}/tool-output/*`, action: 'allow' },
    { permission: 'external_directory', pattern: `${dataDir}/plans/*`, action: 'allow' },
  ];
}

/** OpenCode's own scratch folder, which its built-in `explore` subagent may reach. */
const OPENCODE_SCRATCH: OpenCodeRule = {
  permission: 'external_directory',
  pattern: '/tmp/opencode/*',
  action: 'allow',
};

/** OpenCode's wildcard match on a permission name: `*` stands for anything. */
function matchesKey(rulePermission: string, key: string): boolean {
  const pattern = rulePermission.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${pattern}$`).test(key);
}

/** The index of the last rule `test` accepts, or -1. */
function lastIndexWhere(
  rules: readonly OpenCodeRule[],
  test: (r: OpenCodeRule) => boolean
): number {
  for (let i = rules.length - 1; i >= 0; i--) if (test(rules[i]!)) return i;
  return -1;
}

function sameRule(a: OpenCodeRule, b: OpenCodeRule): boolean {
  return a.permission === b.permission && a.pattern === b.pattern && a.action === b.action;
}

/**
 * Whether a ruleset still ends in DorkOS's asks for every key it guards: for
 * each, DorkOS's own `*` rule is there, and nothing after it that applies to
 * the key allows more than DorkOS's own rules do. Stricter rules are fine.
 *
 * @param rules - A session's or an agent's resolved rules, oldest first.
 * @param dataDir - The sidecar's data folder.
 * @param tolerated - Allows OpenCode itself adds that count as DorkOS's own.
 */
export function holdsDorkosAsks(
  rules: readonly OpenCodeRule[],
  dataDir: string,
  tolerated: readonly OpenCodeRule[] = []
): boolean {
  const mine = [...dorkosSessionRules(dataDir), ...tolerated];
  return [...new Set(mine.map((r) => r.permission))].every((key) => {
    const own = mine.filter((r) => r.permission === key);
    const anchor = lastIndexWhere(rules, (r) => sameRule(r, own[0]!));
    if (anchor < 0) return false;
    return rules
      .slice(anchor + 1)
      .filter((r) => matchesKey(r.permission, key))
      .every((r) => r.action !== 'allow' || own.some((mine) => sameRule(mine, r)));
  });
}

/**
 * The rules a session needs added before a turn: DorkOS's asks when it does
 * not hold them yet (a new or older session), and a `task` deny for each
 * subagent whose own rules would skip them. Empty when nothing is missing.
 * OpenCode only ever appends to a session's rules, so this never repeats one.
 *
 * @param session - The session's stored rules, if any.
 * @param agents - The project's agents, as the sidecar resolves them.
 * @param dataDir - The sidecar's data folder.
 */
export function sessionRulesToAdd(
  session: readonly OpenCodeRule[] | undefined,
  agents: readonly OpenCodeAgentRules[],
  dataDir: string
): OpenCodeRule[] {
  const current = session ?? [];
  const added = holdsDorkosAsks(current, dataDir) ? [] : dorkosSessionRules(dataDir);
  for (const agent of agents) {
    // Any agent, whatever its mode: `task` starts whichever agent it is named,
    // a primary one too, and that child keeps only its parent's denies.
    if (holdsDorkosAsks(agent.permission, dataDir, [OPENCODE_SCRATCH])) continue;
    const refusal: OpenCodeRule = { permission: 'task', pattern: agent.name, action: 'deny' };
    const last = lastIndexWhere(
      current,
      (r) => matchesKey(r.permission, 'task') && (r.pattern === agent.name || r.pattern === '*')
    );
    if (current[last]?.action !== 'deny') added.push(refusal);
  }
  return added;
}
