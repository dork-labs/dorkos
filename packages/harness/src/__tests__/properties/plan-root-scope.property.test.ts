/**
 * Property tests for where a plan is allowed to point (T0 P8, P8b, P8c).
 *
 * `plans/harness-sync-test-plan.md` has carried a line reading "P8 scope" since
 * the plan was written, and **there was never a test called P8**: the properties
 * directory covered P2, P2b, P3, P4, P6, P7, P9a and P9b, and nothing else. A
 * property that is narrowed on paper and never executed is worth nothing, so
 * this file writes the first P8 there has ever been, in its narrowed form, and
 * puts its two global siblings beside it.
 *
 * - **P8 project scope.** Every action in a plan built by `project()` carries
 *   `scope` absent or `'project'`, its `target` and `source` are repo-relative
 *   POSIX strings, and each resolves inside `repoRoot`. No path built from a
 *   `dorkHome` appears in any of them — asserted against a dork home that really
 *   holds a package, so the claim is about a plan that has SEEN one.
 * - **P8b global roots.** Every action in a plan built by `buildGlobalPlan`
 *   carries `scope: 'global'` and an absolute target, that target resolves
 *   inside one of the plan's declared roots, and a root passed as ABSENT gets
 *   nothing beneath it. The counterexample prints the offending target and the
 *   root set.
 * - **P8c global kinds.** No entry in a global plan is `generate`, `scaffold` or
 *   `merge`. The rule "never generate at user scope" has no other enforcement in
 *   the suite, and `buildPlan` running every stage unconditionally is the
 *   ordinary way it would be lost.
 *
 * P8b and P8c run on hand-built inputs and touch no disk at all, which is what
 * `buildGlobalPlan` being pure buys.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { project } from '../../engine.js';
import { buildGlobalPlan, type GlobalPlanRoots } from '../../plan/global-projector.js';
import { HARNESS_IDS, type HarnessId } from '../../manifest/schema.js';
import type { InstalledPlugin, InstalledSkill } from '../../sources/installed.js';
import type { ProjectionAction } from '../../plan/types.js';
import { arbRepo, PROPERTY_TIMEOUT_MS, RUNS, withRepo } from './arb-repo.js';

/** Whether `child` is `root` or sits inside it, one path segment at a time. */
function isInside(child: string, root: string): boolean {
  const c = resolve(child);
  const r = resolve(root);
  return c === r || c.startsWith(r + sep);
}

/** Every path an action can carry, with the field it came from. */
function pathsOf(action: ProjectionAction): { field: 'source' | 'target'; value: string }[] {
  const out: { field: 'source' | 'target'; value: string }[] = [];
  if (action.source !== undefined) out.push({ field: 'source', value: action.source });
  if (action.target !== undefined) out.push({ field: 'target', value: action.target });
  return out;
}

/**
 * Put one globally installed package into a generated repo's dork home.
 *
 * P8 is about a project plan keeping every path repo-relative, and a plan that
 * never saw a global package cannot break that rule however hard it tries. This
 * is what makes "no path built from a `dorkHome` appears" an assertion rather
 * than a tautology: the scan enumerates this package on every run, its drop is
 * in the plan, and every path in that plan still has to be the repository's.
 */
function stageGlobalPackage(dorkHome: string): void {
  const dir = join(dorkHome, 'plugins', 'globex');
  mkdirSync(join(dir, '.dork'), { recursive: true });
  writeFileSync(
    join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: 'globex', version: '1.0.0', type: 'plugin', description: 'globex' })
  );
  const skillDir = join(dir, 'skills', 'greet');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: greet\ndescription: A greeting\nschedule:\n  cron: '0 9 * * *'\n---\nSay hello.\n`
  );
}

describe('P8 — a project plan never leaves the repository', () => {
  it(
    'keeps every action repo-relative and inside repoRoot, with no dorkHome path anywhere',
    () => {
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            stageGlobalPackage(dorkHome);
            const plan = project(repoRoot, { dorkHome });

            const offenders: { name: string; field: string; value: string; why: string }[] = [];
            for (const action of [...plan.actions, ...plan.drops]) {
              if (action.scope !== undefined && action.scope !== 'project') {
                offenders.push({
                  name: action.name,
                  field: 'scope',
                  value: String(action.scope),
                  why: 'a project plan may only carry scope absent or "project"',
                });
              }
              for (const { field, value } of pathsOf(action)) {
                if (isAbsolute(value)) {
                  offenders.push({ name: action.name, field, value, why: 'absolute' });
                  continue;
                }
                if (value.includes('\\')) {
                  offenders.push({ name: action.name, field, value, why: 'not POSIX' });
                }
                if (!isInside(join(repoRoot, value), repoRoot)) {
                  offenders.push({ name: action.name, field, value, why: 'escapes repoRoot' });
                }
                if (isInside(join(repoRoot, value), dorkHome)) {
                  offenders.push({ name: action.name, field, value, why: 'built from dorkHome' });
                }
              }
            }
            expect({ repoRoot, offenders }).toEqual({ repoRoot, offenders: [] });
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

/** A path segment safe on every filesystem the suite runs on. */
const arbSegment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/);

/** A kebab-case package or skill name, the shape `PackageNameSchema` accepts. */
const arbName = fc.stringMatching(/^[a-z][a-z0-9]{0,5}(-[a-z0-9]{1,5})?$/);

/** One hand-built global package, with the paths the scanner would have spelled. */
function packageFrom(
  dorkHome: string,
  name: string,
  skills: readonly { name: string; hasSchedule: boolean; usesPluginRoot: boolean }[]
): InstalledPlugin {
  const absDir = `${join(dorkHome, 'plugins', name)}`;
  return {
    name,
    type: 'plugin',
    location: { scope: 'global', absDir },
    skills: skills.map((s): InstalledSkill => ({
      name: s.name,
      sourceDir: `${absDir}/skills/${s.name}`,
      usesPluginRoot: s.usesPluginRoot,
      hasSchedule: s.hasSchedule,
    })),
    commands: [],
    layers: [],
  };
}

/** What one generated global case holds: the roots, the packages, the enabled tools. */
interface GlobalCase {
  roots: GlobalPlanRoots;
  /** A user-level directory the case did NOT declare, so nothing may be planned under it. */
  undeclared: string[];
  packages: InstalledPlugin[];
  harnesses: HarnessId[];
}

/**
 * A whole global planning input, generated: a dork home, a user root that is
 * sometimes declared and sometimes not, some packages, some enabled tools.
 *
 * No filesystem at all. `buildGlobalPlan` takes its packages as an argument,
 * which is the entire reason these two properties can be a few thousand cases
 * of pure arithmetic rather than a few thousand temp directories.
 */
function arbGlobalCase(): fc.Arbitrary<GlobalCase> {
  return fc
    .record({
      homeSegments: fc.array(arbSegment, { minLength: 1, maxLength: 3 }),
      userSegments: fc.array(arbSegment, { minLength: 1, maxLength: 3 }),
      declareAgents: fc.boolean(),
      declareClaude: fc.boolean(),
      packages: fc.uniqueArray(
        fc.record({
          name: arbName,
          skills: fc.uniqueArray(
            fc.record({
              name: arbName,
              hasSchedule: fc.boolean(),
              usesPluginRoot: fc.boolean(),
            }),
            { selector: (s) => s.name, maxLength: 4 }
          ),
        }),
        { selector: (p) => p.name, maxLength: 4 }
      ),
      harnesses: fc.subarray([...HARNESS_IDS]),
    })
    .map(({ homeSegments, userSegments, declareAgents, declareClaude, packages, harnesses }) => {
      const dorkHome = resolve(sep, ...homeSegments, '.dork');
      const agentsSkillsDir = resolve(sep, ...userSegments, '.agents', 'skills');
      const claudeSkillsDir = resolve(sep, ...userSegments, '.claude', 'skills');
      const roots: GlobalPlanRoots = {
        dorkHome,
        ...(declareAgents ? { agentsSkillsDir } : {}),
        ...(declareClaude ? { claudeSkillsDir } : {}),
      };
      return {
        roots,
        undeclared: [
          ...(declareAgents ? [] : [agentsSkillsDir]),
          ...(declareClaude ? [] : [claudeSkillsDir]),
        ],
        packages: packages.map((p) => packageFrom(dorkHome, p.name, p.skills)),
        harnesses,
      };
    });
}

/** Every root a plan declared, in the order the type lists them. */
function declaredRoots(roots: GlobalPlanRoots): string[] {
  return [roots.dorkHome, roots.agentsSkillsDir, roots.claudeSkillsDir].filter(
    (r): r is string => r !== undefined
  );
}

describe('P8b — a global plan stays inside the roots it was given', () => {
  it(
    'carries scope global and an absolute target inside a declared root, and nothing under an absent one',
    () => {
      fc.assert(
        fc.property(arbGlobalCase(), ({ roots, undeclared, packages, harnesses }) => {
          const plan = buildGlobalPlan({ roots, packages, harnesses });
          const rootSet = declaredRoots(roots);

          const offenders: { name: string; target?: string; why: string }[] = [];
          for (const action of [...plan.actions, ...plan.drops]) {
            if (action.scope !== 'global') {
              offenders.push({ name: action.name, why: `scope was ${String(action.scope)}` });
            }
            if (action.target === undefined) continue;
            if (!isAbsolute(action.target)) {
              offenders.push({ name: action.name, target: action.target, why: 'not absolute' });
              continue;
            }
            if (!rootSet.some((root) => isInside(action.target as string, root))) {
              offenders.push({
                name: action.name,
                target: action.target,
                why: 'outside every declared root',
              });
            }
            for (const absent of undeclared) {
              if (isInside(action.target, absent)) {
                offenders.push({
                  name: action.name,
                  target: action.target,
                  why: `beneath the undeclared root ${absent}`,
                });
              }
            }
          }
          // The counterexample names the paths AND the roots, because a target
          // that escaped is only readable beside the set it was supposed to
          // stay inside.
          expect({ offenders, roots: rootSet, absent: undeclared }).toEqual({
            offenders: [],
            roots: rootSet,
            absent: undeclared,
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('P8c — a global plan never generates', () => {
  it(
    'emits only symlink, native or drop entries, whatever packages and tools it is given',
    () => {
      fc.assert(
        fc.property(arbGlobalCase(), ({ roots, packages, harnesses }) => {
          const plan = buildGlobalPlan({ roots, packages, harnesses });
          const forbidden = [...plan.actions, ...plan.drops]
            .filter((a) => a.kind === 'generate' || a.kind === 'scaffold' || a.kind === 'merge')
            .map((a) => ({ kind: a.kind, name: a.name, target: a.target }));
          expect(forbidden).toEqual([]);
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
