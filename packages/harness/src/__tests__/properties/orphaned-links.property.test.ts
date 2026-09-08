/**
 * Property tests for the engine's link inventory (T0 P2 + P2b).
 *
 * Both run off the shared generator in `arb-repo.ts`, which stages hostile
 * occupants including a dead symlink at a `generate`, `scaffold`, or `symlink`
 * target.
 *
 * - **P2 — inventory ⇔ ownership.** After `applyPlan(..., { sweepOrphans: true })`
 *   every path under `.claude/skills` and `.agents/skills` that matches the
 *   engine's ownership predicate — a `__` symlink, or a symlink whose link text
 *   points into `.agents/skills/` — resolves to a source the CURRENT plan names.
 *   Then the sources are moved under the engine's feet (an authored skill is
 *   deleted or renamed) and the same claim is made again. A link left pointing at
 *   nothing is the failure, and its path is in the counterexample. This is the
 *   property that catches SK-10.
 * - **P2b — `checkPlan` never throws.** For every generated tree, before and
 *   after an apply, dead links included. This is the property that catches AP-05.
 *
 * The predicate is restated here from the engine's rule rather than imported, so
 * a test cannot agree with a bug by sharing its code.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { existsSync, lstatSync, readdirSync, readlinkSync, renameSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { arbRepo, PROPERTY_TIMEOUT_MS, RUNS, withRepo } from './arb-repo.js';

/** The two directories the engine projects skill links into. */
const SKILL_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** Where authored skills live — the only place a non-namespaced link may point. */
const AUTHORED_SKILLS_DIR = '.agents/skills';

/** Whether a path resolves to something that exists (a dead link does not). */
function resolves(abs: string): boolean {
  return existsSync(abs);
}

/**
 * Whether an entry in a skill projection dir is one the engine manages: a
 * symlink carrying the `__` namespace marker, or a symlink whose text points
 * into `.agents/skills/`. A real directory is authored content, and a link
 * pointing anywhere else is the person's own.
 */
function isManagedLink(repoRoot: string, dir: string, entry: string): boolean {
  const dirAbs = join(repoRoot, dir);
  const abs = join(dirAbs, entry);
  if (!lstatSync(abs).isSymbolicLink()) return false;
  if (entry.includes('__')) return true;
  const inside = relative(join(repoRoot, AUTHORED_SKILLS_DIR), resolve(dirAbs, readlinkSync(abs)));
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}

/**
 * Assert that every managed link in the tree is named by the plan and resolves.
 *
 * @param repoRoot - the staged repository.
 * @param plan - the plan that was just applied.
 * @returns how many managed links were examined (so a vacuous pass is visible).
 */
function expectNoOrphans(repoRoot: string, plan: ProjectionPlan): number {
  const planned = new Set(
    plan.actions.filter((a) => a.kind === 'symlink' && a.target).map((a) => a.target as string)
  );
  let examined = 0;
  for (const dir of SKILL_DIRS) {
    const dirAbs = join(repoRoot, dir);
    if (!existsSync(dirAbs)) continue;
    for (const entry of readdirSync(dirAbs)) {
      if (!isManagedLink(repoRoot, dir, entry)) continue;
      examined += 1;
      const path = `${dir}/${entry}`;
      expect({ path, planned: planned.has(path), resolves: resolves(join(dirAbs, entry)) }).toEqual(
        {
          path,
          planned: true,
          resolves: true,
        }
      );
    }
  }
  return examined;
}

describe('P2 — every managed link resolves to a source the current plan names', () => {
  it(
    'leaves no orphaned link behind, before or after a skill is deleted or renamed',
    () => {
      let examined = 0;
      fc.assert(
        fc.property(arbRepo(), fc.boolean(), (spec, rename) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const firstPlan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, firstPlan, { sweepOrphans: true });
            examined += expectNoOrphans(repoRoot, firstPlan);

            // Move a source out from under the projection, the way a person does.
            if (spec.skills.length > 0) {
              const from = join(repoRoot, '.agents', 'skills', spec.skills[0]);
              if (rename)
                renameSync(from, join(repoRoot, '.agents', 'skills', `${spec.skills[0]}2`));
              else rmSync(from, { recursive: true, force: true });
            }

            const secondPlan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, secondPlan, { sweepOrphans: true });
            examined += expectNoOrphans(repoRoot, secondPlan);
          });
        }),
        RUNS
      );
      // The property is only worth its green if it looked at links at all.
      expect(examined).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('P2b — checkPlan never throws', () => {
  it(
    'returns a drift result for every generated tree, dead links included',
    () => {
      let deadGenerateTargets = 0;
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome, dangling }) => {
            const plan = project(repoRoot, { dorkHome });

            // Before any apply: the tree is raw and the dead links are in place.
            const before = checkPlan(repoRoot, plan);

            // A dead link at a target the plan writes is DRIFT — there is nothing
            // to read there, so no ownership question arises and `--fix` replaces it.
            if (
              dangling &&
              plan.actions.some(
                (a) =>
                  a.target === dangling.path && (a.kind === 'generate' || a.kind === 'scaffold')
              )
            ) {
              deadGenerateTargets += 1;
              expect(before.drifted.some((a) => a.target === dangling.path)).toBe(true);
            }

            // And after: still an answer, never an exception.
            applyPlan(repoRoot, plan, { sweepOrphans: true });
            expect(() => checkPlan(repoRoot, plan)).not.toThrow();
          });
        }),
        RUNS
      );
      // Assert the generator actually produced the hostile shape under test.
      expect(deadGenerateTargets).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT_MS
  );
});
