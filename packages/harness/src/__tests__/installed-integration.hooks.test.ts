import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../engine.js';
import { applyPlan } from '../apply/apply.js';
import { getActionContent } from '../plan/content-map.js';
import type { ProjectionPlan } from '../plan/types.js';
import { withoutEnvPrefix } from './installed-integration.fixtures.js';

let repo = '';

let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * A repo enabling claude-code + codex with two project-installed plugins: one
 * whose `hooks/hooks.json` is written from `hostileHooks`, and one whose hooks
 * are clean. The clean plugin is the containment probe — a malformed file in one
 * package must never cost another package its hooks.
 */
function buildRepoWithTwoHookPlugins(hostileHooks: unknown): {
  repoRoot: string;
  hostileHooksPath: string;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'harness-bad-hooks-'));
  mkdirSync(join(repoRoot, '.agents'), { recursive: true });
  writeFileSync(
    join(repoRoot, '.agents', 'harness.manifest.json'),
    JSON.stringify({ version: 1, harnesses: ['claude-code', 'codex'] }, null, 2)
  );

  for (const name of ['hostile', 'clean']) {
    const plugin = join(repoRoot, '.dork', 'plugins', name);
    mkdirSync(join(plugin, '.dork'), { recursive: true });
    writeFileSync(
      join(plugin, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name,
        version: '1.0.0',
        type: 'plugin',
        description: `${name} test plugin`,
        layers: ['hooks'],
      })
    );
    mkdirSync(join(plugin, 'hooks'), { recursive: true });
  }

  const hostileHooksPath = join(repoRoot, '.dork', 'plugins', 'hostile', 'hooks', 'hooks.json');
  writeFileSync(hostileHooksPath, JSON.stringify(hostileHooks));
  writeFileSync(
    join(repoRoot, '.dork', 'plugins', 'clean', 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'clean.sh' }] }] })
  );

  return { repoRoot, hostileHooksPath };
}

/** Every hook command the plan would merge into `.claude/settings.local.json`. */
function mergedSettingsCommands(plan: ProjectionPlan): string[] {
  const merge = plan.actions.find((a) => a.target === '.claude/settings.local.json');
  const content = merge ? getActionContent(merge) : undefined;
  if (!content) return [];
  const hooks = JSON.parse(content) as Record<string, { hooks?: { command: string }[] }[]>;
  return Object.values(hooks).flatMap((groups) =>
    groups.flatMap((group) => (group.hooks ?? []).map((h) => withoutEnvPrefix(h.command)))
  );
}

describe('installed-plugin projection — a malformed hooks.json cannot take the projection down (DOR-646)', () => {
  it('drops the unusable groups, keeps their readable siblings, and leaves other packages intact', () => {
    // All four shapes the PR #552 differential sweep found, in one file, beside a
    // readable group. Before this fix `project()` threw `TypeError:
    // group.hooks.map is not a function` and NOTHING projected — not the sibling
    // command, not the other package, not the skills or commands of either.
    const built = buildRepoWithTwoHookPlugins({
      Stop: [{ hooks: [{ command: 'good.sh' }] }, { hooks: 'nope' }],
      PreToolUse: [{ hooks: [{ type: 'command' }] }, { hooks: [{ command: 42 }] }, null],
    });
    repo = built.repoRoot;

    const plan = project(repo);
    const result = applyPlan(repo, plan, { sweepOrphans: true });
    expect(result.conflicts).toEqual([]);

    // The readable sibling survives, in the settings merge and the generated
    // Codex hooks file alike; the unreadable event contributes nothing.
    const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8'));
    const stopCommands = settings.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((h) => withoutEnvPrefix(h.command))
    );
    expect(stopCommands).toEqual(expect.arrayContaining(['good.sh', 'clean.sh']));
    expect(settings.hooks.PreToolUse).toBeUndefined();

    const codexHooks = readFileSync(join(repo, '.codex', 'hooks.json'), 'utf8');
    expect(codexHooks).toContain('good.sh');
    expect(codexHooks).toContain('clean.sh');
  });

  // The sweep derives its field list from a WELL-FORMED document at runtime, so a
  // field added to the hook shape later is covered without anyone remembering to
  // extend this test — the argument DOR-535 settled one nesting level up.
  //
  // Its reach is deliberately bounded: it mutates VALUES at existing paths, never
  // KEY NAMES. A hostile key (`__proto__` as an event name, which the sweep would
  // never generate) is a different class and belongs to the adversarial-document
  // cases below, which now cover it.
  describe('non-conformance sweep over every field of a well-formed hooks.json', () => {
    const CANONICAL_HOOKS = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh', timeout: 30 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }],
      },
    };

    /** Values a hostile or sloppy package can put anywhere in a JSON document. */
    const HOSTILE_VALUES = [null, 42, 'nope', true, [], {}] as const;

    /** Every addressable location in a JSON document — each object key and array index. */
    function jsonPaths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
      if (value === null || typeof value !== 'object') return [];
      const entries: [string | number, unknown][] = Array.isArray(value)
        ? value.map((child, index) => [index, child])
        : Object.entries(value);
      return entries.flatMap(([key, child]) => [
        [...prefix, key],
        ...jsonPaths(child, [...prefix, key]),
      ]);
    }

    /** A clone of `doc` with `path` set to `value`, or deleted when `value` is `DELETE`. */
    const DELETE = Symbol('delete');
    function mutate(doc: unknown, path: (string | number)[], value: unknown): unknown {
      const clone = structuredClone(doc) as Record<string | number, unknown>;
      let parent = clone;
      for (const key of path.slice(0, -1)) parent = parent[key] as typeof parent;
      const leaf = path[path.length - 1]!;
      if (value === DELETE) {
        if (Array.isArray(parent)) parent.splice(Number(leaf), 1);
        else delete parent[leaf];
      } else {
        parent[leaf] = value;
      }
      return clone;
    }

    const paths = jsonPaths(CANONICAL_HOOKS);

    it.each(paths.map((path) => [path.join('.'), path] as const))(
      'survives every hostile value at %s',
      (_label, path) => {
        const built = buildRepoWithTwoHookPlugins(CANONICAL_HOOKS);
        repo = built.repoRoot;

        for (const value of [...HOSTILE_VALUES, DELETE]) {
          writeFileSync(
            built.hostileHooksPath,
            JSON.stringify(mutate(CANONICAL_HOOKS, path, value))
          );
          const plan = project(repo);
          // Containment: the other package's hook is planned whatever the
          // hostile package's file says.
          expect(mergedSettingsCommands(plan)).toContain('clean.sh');
        }
      }
    );
  });

  describe('adversarial documents the value sweep cannot generate', () => {
    it('HK-09: projects an event a package named `__proto__`, and pollutes nothing', () => {
      // Assigning a `__proto__` key to a `{}` accumulator hits the inherited
      // setter: the groups vanish with no error and the accumulator's prototype
      // is replaced. Every hop from the reader to the settings merge therefore
      // accumulates onto a null-prototype object. A computed key is used here
      // because the literal `__proto__:` syntax would set the fixture's
      // prototype instead of giving it the property a package's JSON has.
      const built = buildRepoWithTwoHookPlugins({
        Stop: [{ hooks: [{ type: 'command', command: 'real.sh' }] }],
        ['__proto__' as string]: [{ hooks: [{ type: 'command', command: 'sneaky.sh' }] }],
      });
      repo = built.repoRoot;

      const plan = project(repo);
      const commands = mergedSettingsCommands(plan);
      expect(commands).toContain('real.sh');
      expect(commands).toContain('clean.sh');
      // Disclosed by the preview, so projected here too — as an event no harness
      // maps, never as a silently swallowed one.
      expect(commands).toContain('sneaky.sh');

      // Nothing leaked onto the prototype chain, in this process or the file.
      expect(({} as Record<string, unknown>).Stop).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);

      const result = applyPlan(repo, plan, { sweepOrphans: true });
      expect(result.conflicts).toEqual([]);
      const settingsRaw = readFileSync(join(repo, '.claude', 'settings.local.json'), 'utf8');
      expect(settingsRaw).toContain('sneaky.sh');
      expect(JSON.parse(settingsRaw).hooks.Stop).toBeDefined();
    });
  });
});
