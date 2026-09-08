/**
 * Drift guard for the harness consent seam (DOR-1849, contract D5 / HK-07).
 *
 * A package's hooks are shell commands a harness runs unattended, so they must
 * not project until a person has allowed those exact commands. That decision is
 * applied in ONE place — `../project-with-consent.ts` — which builds the plan
 * with the unapproved packages' hooks left out and reports what it withheld.
 *
 * `project()` from `@dorkos/harness` is the way round it. Held at all, it
 * projects every hook on disk: no gate, no record consulted, no report. That is
 * not hypothetical, it is what shipped. `dorkos harness sync --fix` called it
 * bare and installed hooks people had turned down, and the next trigger to be
 * written — the `.agents/skills` watcher (DOR-1850) — cannot reuse
 * `runAutoProjection`, whose shape is "a marketplace package changed", so it is
 * the next thing that would reach for `project()` on its own.
 *
 * ## Why it lives here rather than in `scripts/__tests__`
 *
 * It was there first, and there it ran in no job that a guarded change
 * triggers. `scripts/` belongs to no workspace package, so `turbo test` never
 * reaches it; the one workflow that does (`scripts-test.yml`) filters on paths
 * that include neither `apps/server/src/**` nor `packages/cli/src/**`, and has
 * no `merge_group:` trigger, so it can never be a required check. A watcher PR
 * touching only `apps/server/src` would have gone green past a guard written
 * for exactly that PR.
 *
 * In `@dorkos/server`'s own suite it rides `turbo test`. On a PR leg that is
 * affected-only, so a CLI-only change does not run it here — the **merge queue's
 * full monorepo sweep** is what makes it decisive, and that sweep is a required
 * check. It walks both trees whichever package it runs from.
 *
 * The seam is easy to route around and impossible to notice routing around,
 * which is what a guard is for. It reads SOURCE rather than types, because the
 * hole is an import that compiles perfectly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The repo root, six levels above this file (`apps/server/src/services/harness/__tests__`). */
const ROOT = path.resolve(import.meta.dirname, '../../../../../..');

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
 * routing that pass through it would LOOSEN it. An assertion below pins the
 * deny, so the exemption cannot quietly become a permission.
 */
const ALLOWED_PROJECT_CALLERS: Readonly<Record<string, string>> = {
  [SEAM_MODULE]: 'the consent seam itself',
  'apps/server/src/services/harness/project-agent-workspace.ts':
    'denies every installed package’s hooks unconditionally (HK-08), which is stricter than consent',
};

/** Whether a file lives in a tree this rule covers. */
function isGuarded(file: string): boolean {
  return GUARDED_ROOTS.some((root) => file.startsWith(root));
}

/**
 * Test files are exempt: a suite that pins the ENGINE's behaviour has to reach
 * the engine, and it projects into a temporary directory nobody's agent reads.
 */
function isTest(file: string): boolean {
  return file.includes('/__tests__/') || file.endsWith('.test.ts') || file.endsWith('.test.tsx');
}

/** The package specifier, either quote style. */
const SPEC = String.raw`['"]@dorkos/harness['"]`;

/**
 * Every brace list that binds names out of `@dorkos/harness`, in each of the
 * three shapes this repo actually writes.
 *
 * Global, so a file with several import statements is read whole. The first
 * version of this ran one `.exec` and stopped at the first block, which in a
 * file importing types separately from values meant reading half of it.
 *
 * The list is `[^{}]*` rather than `[^}]*`, and that one character is the
 * difference between catching a dynamic import inside a function body and
 * missing it: greedy `[^}]*` starts at the FUNCTION's opening brace, swallows
 * `const {` on its way, and hands back a "list" whose `project` no longer starts
 * a list item. Measured — the CLI's own idiom, written that way, walked past the
 * first version of this guard.
 */
const BRACED_BINDINGS = new RegExp(
  // `import { … } from '@dorkos/harness'` and `export { … } from '@dorkos/harness'`
  String.raw`(?:import|export)\s*\{([^{}]*)\}\s*from\s*${SPEC}` +
    // `const { … } = await import('@dorkos/harness')`, and the `require` form
    String.raw`|\{([^{}]*)\}\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*${SPEC}\s*\)`,
  'g'
);

/** Every name the whole module is bound to, so `<ns>.project` can be looked for. */
const NAMESPACE_BINDINGS = new RegExp(
  // `import * as harness from '@dorkos/harness'`
  String.raw`import\s*\*\s*as\s+(\w+)\s*from\s*${SPEC}` +
    // `const harness = await import('@dorkos/harness')`, and the `require` form
    String.raw`|(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:import|require)\s*\(\s*${SPEC}\s*\)`,
  'g'
);

/**
 * The `project` binding inside one brace list, under whichever name it takes.
 *
 * `project as defaultProject` is the import spelling and `project: defaultProject`
 * the destructuring one, so both aliases are read. The `(?:^|,)` anchor and the
 * `(?=,|$)` lookahead together are what keep this off `projectedHooks`: the name
 * has to start a list item and finish one.
 */
const PROJECT_IN_LIST = /(?:^|,)\s*project(?:\s*:\s*(\w+)|\s+as\s+(\w+))?\s*(?=,|$)/m;

/**
 * The local names a file can reach the engine's `project` through, if any.
 *
 * The rule is on HOLDING the function, not on calling it, and that is
 * deliberate. A call-shaped rule looks stricter and is weaker: the seam itself
 * reaches the engine through `_internal.project(...)`, an injectable test hook
 * that is the normal shape in this repo, so a watcher could park the function in
 * an object exactly the same way and never write `project(` at all. Having the
 * import is having the capability, and that is the line worth drawing.
 *
 * A NAMESPACE binding is the one exception, and it has to be: `import * as
 * harness` is a legitimate way to reach `applyPlan` and says nothing on its own.
 * There the property access is the evidence, so `harness.project` counts —
 * called or merely handed to something else — while `harness.projectedHooks`
 * does not.
 *
 * @param source - The file's text.
 * @returns Every local name bound to the engine's `project`, in the order found.
 */
export function engineProjectBindings(source: string): string[] {
  const found: string[] = [];

  for (const match of source.matchAll(BRACED_BINDINGS)) {
    const list = match[1] ?? match[2];
    if (list === undefined) continue;
    const binding = PROJECT_IN_LIST.exec(list);
    if (binding) found.push(binding[1] ?? binding[2] ?? 'project');
  }

  for (const match of source.matchAll(NAMESPACE_BINDINGS)) {
    const namespace = match[1] ?? match[2];
    if (namespace === undefined) continue;
    const reach = new RegExp(String.raw`(?<![.\w])${namespace}\s*\.\s*project(?![\w])`);
    if (reach.test(source)) found.push(`${namespace}.project`);
  }

  return found;
}

describe('harness projection consent seam', () => {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.ts', '*.tsx'],
    { encoding: 'utf8', cwd: ROOT }
  )
    .trim()
    .split('\n')
    .filter((file) => file.length > 0 && existsSync(path.join(ROOT, file)));

  it('has the trees it is supposed to be guarding', () => {
    // A `git ls-files` that returned nothing, or a repo root resolved one level
    // wrong, would make every assertion below vacuously true.
    expect(files.length).toBeGreaterThan(100);
    for (const root of GUARDED_ROOTS) {
      expect(files.filter((file) => file.startsWith(root)).length).toBeGreaterThan(50);
    }
    for (const file of Object.keys(ALLOWED_PROJECT_CALLERS)) expect(files).toContain(file);
  });

  it('HK-07: routes every trigger through the seam — nothing else can reach project()', () => {
    const violations = files
      .filter((file) => isGuarded(file) && !isTest(file) && !(file in ALLOWED_PROJECT_CALLERS))
      .filter(
        (file) => engineProjectBindings(readFileSync(path.join(ROOT, file), 'utf8')).length > 0
      );

    expect(
      violations,
      `These can reach \`project()\` from @dorkos/harness directly, so they project every hook ` +
        `on disk with no consent gate and no report of what was withheld (DOR-522, DOR-1849).\n` +
        `Call \`projectWithConsent\` / \`planWithConsent\` from ${SEAM_MODULE} instead.`
    ).toEqual([]);
  });

  it('recognises the allowed callers, so the rule is not passing by finding nothing', () => {
    // The detector is asserted against the files that legitimately do it.
    // Without this, a regex that matched nothing at all would report a clean
    // tree for ever.
    for (const file of Object.keys(ALLOWED_PROJECT_CALLERS)) {
      expect(engineProjectBindings(readFileSync(path.join(ROOT, file), 'utf8')), file).not.toEqual(
        []
      );
    }
  });

  it('holds the agent-workspace exemption to the reason it was given', () => {
    // The exemption is "it denies package hooks outright". If that stops being
    // true, an unattended boot pass starts writing shell commands into every
    // agent's home, and this is the only thing standing between the two.
    const source = readFileSync(
      path.join(ROOT, 'apps/server/src/services/harness/project-agent-workspace.ts'),
      'utf8'
    );
    expect(source).toMatch(/const DENY_ALL_PLUGIN_HOOKS = \(\): boolean => false;/);
    expect(source).toContain('allowPluginHooks: DENY_ALL_PLUGIN_HOOKS');
  });

  it('catches every way this repo actually writes an import', () => {
    // Four forms, all of them real here: the CLI's whole `harness` namespace is
    // written in `await import(...)`, and a re-export or a `* as` binding hands
    // the same function on just as effectively as a static named import.
    expect(engineProjectBindings(`import { applyPlan, project } from '@dorkos/harness';`)).toEqual([
      'project',
    ]);
    expect(
      engineProjectBindings(`import { project as defaultProject } from "@dorkos/harness";`)
    ).toEqual(['defaultProject']);
    expect(
      engineProjectBindings(`import {\n  applyPlan,\n  project,\n} from '@dorkos/harness';`)
    ).toEqual(['project']);
    expect(engineProjectBindings(`const { project } = await import('@dorkos/harness');`)).toEqual([
      'project',
    ]);
    // Inside a function body, beside another binding — the shape that walked
    // past the first version of this guard.
    expect(
      engineProjectBindings(
        `export async function reproject(root: string): Promise<void> {\n  const { project, applyPlan } = await import('@dorkos/harness');\n  applyPlan(root, project(root));\n}`
      )
    ).toEqual(['project']);
    expect(
      engineProjectBindings(`const { project: p } = await import("@dorkos/harness");\np(root);`)
    ).toEqual(['p']);
    expect(engineProjectBindings(`export { project } from '@dorkos/harness';`)).toEqual([
      'project',
    ]);
    expect(
      engineProjectBindings(
        `import * as harness from '@dorkos/harness';\nconst plan = harness.project(root);`
      )
    ).toEqual(['harness.project']);
    expect(
      engineProjectBindings(
        `const harness = await import("@dorkos/harness");\nexport const _internal = { project: harness.project };`
      )
    ).toEqual(['harness.project']);

    // A second import block does not hide behind the first.
    expect(
      engineProjectBindings(
        `import type { HarnessId } from '@dorkos/harness';\nimport { project } from '@dorkos/harness';`
      )
    ).toEqual(['project']);

    // And the shape a call-based rule would miss: parked in a seam object and
    // reached as `_internal.project(...)`, never written as `project(`.
    expect(
      engineProjectBindings(
        `import { project } from '@dorkos/harness';\nexport const _internal = { project };\n_internal.project(root);`
      )
    ).toEqual(['project']);
  });

  it('does not fire on the near-misses that share the word', () => {
    // A `project` that is not the engine's, an import of a different export,
    // and the namespace binding that never reaches `.project`.
    expect(
      engineProjectBindings(`const project = repos.find((r) => r.id === id);\nproject(id);`)
    ).toEqual([]);
    expect(
      engineProjectBindings(`import { applyPlan } from '@dorkos/harness';\nconst p = '/x';`)
    ).toEqual([]);
    expect(
      engineProjectBindings(`import { projectedHooks } from '@dorkos/harness';\nprojectedHooks(p);`)
    ).toEqual([]);
    expect(
      engineProjectBindings(
        `import * as harness from '@dorkos/harness';\nharness.projectedHooks(plugins, root);`
      )
    ).toEqual([]);
    expect(
      engineProjectBindings(`import { project } from './local-thing.js';\nproject(x);`)
    ).toEqual([]);
  });
});
