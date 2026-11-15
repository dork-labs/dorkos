/**
 * DOR-4394: a cloned project's `opencode.json` must not switch off DorkOS's
 * asks. OpenCode decides from the agent's rules, then the session's, and the
 * last match wins. So DorkOS's asks ride on every session, and a subagent
 * whose own rules would skip them is refused as a `task`.
 *
 * Rulesets below are shaped like the pinned 1.19.3 sidecar's `GET /agent`
 * answer: OpenCode's defaults, then DorkOS's injected config, then the agent's.
 */
import { describe, expect, it } from 'vitest';
import {
  dorkosSessionRules,
  holdsDorkosAsks,
  sessionRulesToAdd,
  type OpenCodeRule,
} from '../session-rules.js';

const DATA = '/demo/home/.local/share/opencode';
const DORKOS_SESSION_RULES = dorkosSessionRules(DATA);
const holds = (rules: OpenCodeRule[], tolerated: OpenCodeRule[] = []) =>
  holdsDorkosAsks(rules, DATA, tolerated);
const toAdd = (
  session: OpenCodeRule[] | undefined,
  agents: Parameters<typeof sessionRulesToAdd>[1]
) => sessionRulesToAdd(session, agents, DATA);

const rule = (permission: string, pattern: string, action: OpenCodeRule['action']) => ({
  permission,
  pattern,
  action,
});

/** OpenCode's permissive defaults, then DorkOS's injected top-level config. */
const RESOLVED_BASE: OpenCodeRule[] = [
  rule('*', '*', 'allow'),
  rule('read', '*', 'allow'),
  ...DORKOS_SESSION_RULES,
];

const agent = (name: string, mode: 'primary' | 'subagent' | 'all', extra: OpenCodeRule[] = []) => ({
  name,
  mode,
  permission: [...RESOLVED_BASE, ...extra],
});

describe('DorkOS’s asks as a session ruleset', () => {
  it('asks for every key DorkOS guards, and keeps its secret-file denies', () => {
    expect(DORKOS_SESSION_RULES).toEqual(
      expect.arrayContaining([
        rule('bash', '*', 'ask'),
        rule('edit', '*', 'ask'),
        rule('webfetch', '*', 'ask'),
        rule('grep', '*', 'ask'),
        rule('glob', '*', 'ask'),
        rule('read', '*', 'ask'),
        rule('read', '*.env', 'deny'),
        rule('external_directory', '*', 'ask'),
      ])
    );
    // The sidecar's own tool output stays readable without an ask.
    expect(DORKOS_SESSION_RULES.at(-2)).toEqual(
      rule('external_directory', `${DATA}/tool-output/*`, 'allow')
    );
  });

  it('holds on DorkOS’s own rules, and not once an allow comes after them', () => {
    expect(holds(DORKOS_SESSION_RULES)).toBe(true);
    expect(holds([...DORKOS_SESSION_RULES, rule('bash', '*', 'allow')])).toBe(false);
    expect(holds([...DORKOS_SESSION_RULES, rule('bash', 'git *', 'allow')])).toBe(false);
    // A whole-agent `permission: "allow"` is a wildcard rule over every key.
    expect(holds([...DORKOS_SESSION_RULES, rule('*', '*', 'allow')])).toBe(false);
    // Stricter is fine.
    expect(holds([...DORKOS_SESSION_RULES, rule('bash', '*', 'deny')])).toBe(true);
    expect(holds([])).toBe(false);
  });

  // Security's rows (DOR-4394): every key DorkOS guards, at every level a project
  // can reach. Each is what the sidecar resolves for that project config.
  it.each([
    ['bash', rule('bash', '*', 'allow')],
    ['edit', rule('edit', '*', 'allow')],
    ['webfetch', rule('webfetch', '*', 'allow')],
    ['external_directory', rule('external_directory', '*', 'allow')],
    ['a folder outside', rule('external_directory', '/elsewhere/*', 'allow')],
    ['tools: { bash: true }', rule('bash', '*', 'allow')],
    ['permission: "allow"', rule('*', '*', 'allow')],
  ])('does not hold once %s is allowed after DorkOS’s rules', (_label, loosened) => {
    expect(holds([...DORKOS_SESSION_RULES, loosened])).toBe(false);
  });

  it('tolerates OpenCode’s own scratch folder only where asked to', () => {
    const scratch = rule('external_directory', '/tmp/opencode/*', 'allow');
    expect(holds([...DORKOS_SESSION_RULES, scratch])).toBe(false);
    expect(holds([...DORKOS_SESSION_RULES, scratch], [scratch])).toBe(true);
  });
});

describe('what a session needs before a turn (DOR-4394)', () => {
  it('puts DorkOS’s asks on a session that has none, as an older one does', () => {
    const added = toAdd(undefined, [agent('build', 'primary')]);
    expect(added).toEqual(DORKOS_SESSION_RULES);
  });

  it('adds nothing to a session that already holds them, with safe subagents', () => {
    expect(
      toAdd(DORKOS_SESSION_RULES, [agent('build', 'primary'), agent('general', 'subagent')])
    ).toEqual([]);
  });

  it('refuses a project subagent whose own rules let bash skip the ask', () => {
    const added = toAdd(DORKOS_SESSION_RULES, [
      agent('build', 'primary', [rule('bash', '*', 'allow')]),
      agent('runner', 'subagent', [rule('bash', '*', 'allow')]),
      agent('helper', 'all', [rule('edit', '*', 'allow')]),
      agent('general', 'subagent'),
    ]);
    // `task` can start any agent by name, primaries too (Security M1, live), so
    // every agent that would skip DorkOS's asks is refused as a task target.
    expect(added).toEqual([
      rule('task', 'build', 'deny'),
      rule('task', 'runner', 'deny'),
      rule('task', 'helper', 'deny'),
    ]);
  });

  it('refuses a primary agent as a task target when its rules skip the ask (Security M1)', () => {
    expect(
      toAdd(DORKOS_SESSION_RULES, [agent('lead', 'primary', [rule('bash', '*', 'allow')])])
    ).toEqual([rule('task', 'lead', 'deny')]);
    // An untouched built-in primary is kept.
    expect(toAdd(DORKOS_SESSION_RULES, [agent('build', 'primary')])).toEqual([]);
  });

  it('keeps OpenCode’s built-in explore, which reaches only its own scratch folder', () => {
    const explore = agent('explore', 'subagent', [
      rule('external_directory', '/tmp/opencode/*', 'allow'),
    ]);
    expect(toAdd(DORKOS_SESSION_RULES, [explore])).toEqual([]);
  });

  it('refuses a subagent whose project config reaches outside the folder', () => {
    const reach = agent('reach', 'subagent', [rule('external_directory', '*', 'allow')]);
    expect(toAdd(DORKOS_SESSION_RULES, [reach])).toEqual([rule('task', 'reach', 'deny')]);
  });

  it('does not refuse the same subagent twice', () => {
    const current = [...DORKOS_SESSION_RULES, rule('task', 'runner', 'deny')];
    expect(toAdd(current, [agent('runner', 'subagent', [rule('bash', '*', 'allow')])])).toEqual([]);
  });
});
