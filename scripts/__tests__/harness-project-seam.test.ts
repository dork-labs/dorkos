/**
 * Drift guard for the harness consent seam (DOR-1849, contract D5 / HK-07).
 *
 * A package's hooks are shell commands a harness runs unattended, so they must
 * not project until a person has allowed those exact commands. That decision is
 * applied in ONE place —
 * `apps/server/src/services/harness/project-with-consent.ts` — which builds the
 * plan with the unapproved packages' hooks left out and reports what it
 * withheld.
 *
 * `project()` from `@dorkos/harness` is the call that goes round it. Called
 * bare, it projects every hook on disk: no gate, no record consulted, no report.
 * That is not hypothetical, it is what shipped. `dorkos harness sync --fix`
 * called it bare and installed hooks people had turned down, and the next
 * trigger to be written — the `.agents/skills` watcher — cannot reuse
 * `runAutoProjection` (whose shape is "a marketplace package changed"), so it is
 * the next thing that would reach for `project()` on its own.
 *
 * The seam is easy to route around and impossible to notice routing around,
 * which is what a guard is for. Reading source rather than types because the
 * hole is a call that compiles perfectly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The trees this rule covers: the server and the CLI, which are the two places a
 * projection is triggered from. `packages/harness` itself is the engine that
 * DEFINES `project()`, and `apps/e2e` drives the built CLI.
 */
const GUARDED_ROOTS = ['apps/server/src/', 'packages/cli/src/'] as const;

/** The seam itself: the one module that decides what consent allows. */
const SEAM_MODULE = 'apps/server/src/services/harness/project-with-consent.ts';

/**
 * Every module allowed to hold the engine's `project`, and why.
 *
 * An entry here is another way to project, so adding one is a decision to argue
 * for in review rather than to type. There are two, and the second is allowed
 * because it is STRICTER than the seam rather than looser: an agent workspace is
 * projected with `allowPluginHooks` denied outright, so no installed package's
 * hooks reach an agent home whatever anybody has approved (contract HK-08). The
 * seam cannot express that — its whole job is to honour an approval — so
 * routing that pass through it would LOOSEN it. The second assertion below pins
 * the deny, so the exemption cannot quietly become a permission.
 */
const ALLOWED_PROJECT_CALLERS: Readonly<Record<string, string>> = {
  [SEAM_MODULE]: 'the consent seam itself',
  'apps/server/src/services/harness/project-agent-workspace.ts':
    'denies every installed package’s hooks unconditionally (HK-08), which is stricter than consent',
};

/** Whether a file lives in a tree this rule covers. */
function isGuarded(path: string): boolean {
  return GUARDED_ROOTS.some((root) => path.startsWith(root));
}

/**
 * Test files are exempt: a suite that pins the ENGINE's behaviour has to reach
 * the engine, and it projects into a temporary directory nobody's agent reads.
 */
function isTest(path: string): boolean {
  return path.includes('/__tests__/') || path.endsWith('.test.ts') || path.endsWith('.test.tsx');
}

/**
 * The local name a file imports `project` from `@dorkos/harness` under, if it
 * does at all.
 *
 * The rule is on the IMPORT rather than on a call, and that is deliberate. A
 * call-shaped rule looks stricter and is weaker: the seam itself reaches the
 * engine through `_internal.project(...)` — an injectable test hook that is the
 * normal shape in this repo — so a watcher could hold the function in an object
 * exactly the same way and never write `project(` at all. Having the import is
 * having the capability, and that is the line worth drawing.
 *
 * Reading the import list is also what keeps this off the many unrelated
 * identifiers this repo spells `project`: a route handler's local, a variable
 * holding a path. `project as defaultProject` is caught through its alias for
 * the same reason — the import list is where the engine's name enters a file,
 * whatever it is called afterwards.
 */
function callsEngineProject(source: string): string | undefined {
  const importBlock = /import\s*\{([^}]*)\}\s*from\s*'@dorkos\/harness'/s.exec(source);
  if (!importBlock) return undefined;
  const binding = /(?:^|,)\s*project(?:\s+as\s+(\w+))?\s*(?=,|$)/m.exec(importBlock[1]!);
  return binding === null ? undefined : (binding[1] ?? 'project');
}

describe('harness projection consent seam', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter((path) => path.length > 0 && existsSync(path));

  it('has the trees it is supposed to be guarding', () => {
    // A `git ls-files` that returned nothing would make every assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter(isGuarded).length).toBeGreaterThan(100);
    for (const path of Object.keys(ALLOWED_PROJECT_CALLERS)) expect(files).toContain(path);
  });

  it('routes every trigger through the seam — nothing else can call project() at all', () => {
    const violations = files
      .filter((path) => isGuarded(path) && !isTest(path) && !(path in ALLOWED_PROJECT_CALLERS))
      .filter((path) => callsEngineProject(readFileSync(path, 'utf8')) !== undefined);

    expect(
      violations,
      `These call \`project()\` from @dorkos/harness directly, so they project every hook on ` +
        `disk with no consent gate and no report of what was withheld (DOR-522, DOR-1849).\n` +
        `Call \`projectWithConsent\` / \`planWithConsent\` from ${SEAM_MODULE} instead.`
    ).toEqual([]);
  });

  it('recognises the allowed callers, so the rule is not passing by finding nothing', () => {
    // The detector is asserted against the files that legitimately do it.
    // Without this, a regex that matched nothing at all would report a clean
    // tree for ever.
    for (const path of Object.keys(ALLOWED_PROJECT_CALLERS)) {
      expect(callsEngineProject(readFileSync(path, 'utf8')), path).toBeDefined();
    }
  });

  it('holds the agent-workspace exemption to the reason it was given', () => {
    // The exemption is "it denies package hooks outright". If that stops being
    // true, an unattended boot pass starts writing shell commands into every
    // agent's home, and this is the only thing standing between the two.
    const source = readFileSync(
      'apps/server/src/services/harness/project-agent-workspace.ts',
      'utf8'
    );
    expect(source).toMatch(/const DENY_ALL_PLUGIN_HOOKS = \(\): boolean => false;/);
    expect(source).toContain('allowPluginHooks: DENY_ALL_PLUGIN_HOOKS');
  });

  it('catches the same call written any of the ways it would really appear', () => {
    const aliased = `import { applyPlan, project as defaultProject } from '@dorkos/harness';\nconst plan = defaultProject(root, { dorkHome });`;
    const plain = `import { project } from '@dorkos/harness';\nproject(root);`;
    const multiline = `import {\n  applyPlan,\n  project,\n} from '@dorkos/harness';\nconst p = project(root);`;
    expect(callsEngineProject(aliased)).toBe('defaultProject');
    expect(callsEngineProject(plain)).toBe('project');
    expect(callsEngineProject(multiline)).toBe('project');

    // Including the shape a call-based rule would miss: the function parked in
    // an injectable seam object and reached as `_internal.project(...)`.
    const parked = `import { project } from '@dorkos/harness';\nexport const _internal = { project };\n_internal.project(root);`;
    expect(callsEngineProject(parked)).toBe('project');

    // And does not fire on the near-misses that share the word.
    const unrelated = `const project = repos.find((r) => r.id === id);\nproject(id);`;
    const imported = `import { applyPlan } from '@dorkos/harness';\nconst projectPath = '/x';`;
    const projectedHooksOnly = `import { projectedHooks } from '@dorkos/harness';\nprojectedHooks(p, root);`;
    expect(callsEngineProject(unrelated)).toBeUndefined();
    expect(callsEngineProject(imported)).toBeUndefined();
    expect(callsEngineProject(projectedHooksOnly)).toBeUndefined();
  });
});
