/**
 * P7 — provenance implies gitignore (contract AP-09).
 *
 * `EPHEMERAL_GITIGNORE_PATTERNS` declared, for a year, which paths a projected
 * repo must keep out of git — and nothing ever read it. This repo mirrored the
 * list in its own `.gitignore` by hand, so the engine looked correct here and
 * left every other repo to find out for itself: a fresh project with one
 * installed plugin came out of `--fix` with `.claude/skills/<pkg>__<skill>`
 * untracked and no word said about it (reproduced 2026-09-08 with the built CLI).
 *
 * Two claims, over the shared generator in `arb-repo.ts` — which now also stages
 * a random root `.gitignore` covering a random subset of the patterns, or no git
 * checkout at all:
 *
 * - **P7a.** Every ephemeral target the plan writes is covered by SOMETHING: a
 *   pattern the engine declares, or a self-ignoring `.gitignore` sitting on disk
 *   in the target's own directory. A path neither covers is one the contract
 *   cannot keep, whatever any repo's `.gitignore` says.
 * - **P7b.** `missingGitignoreLines` and the tree agree: it is empty only when
 *   every one of those targets is already covered by THIS repo, and it is
 *   non-empty whenever one is not.
 *
 * The ephemeral rule is restated here from the contract rather than imported, so
 * the property cannot agree with a bug by sharing the module's own idea of which
 * paths matter. The pattern MATCHER is imported: a second glob implementation in
 * a test would only be a second thing to get wrong, and it is pinned directly in
 * `apply/__tests__/gitignore.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { gitignorePatternMatches, missingGitignoreLines } from '../../apply/gitignore.js';
import { EPHEMERAL_GITIGNORE_PATTERNS } from '../../sources/resolve-roots.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { arbRepo, PROPERTY_TIMEOUT_MS, RUNS, withRepo } from './arb-repo.js';

/**
 * Every path this plan writes whose provenance makes it ephemeral: an installed
 * or adopted projection, and the install directory it reads.
 *
 * The engine's own rule covers two more families (the generated hooks files and
 * their sidecars, whose provenance is `authored`, and the install root itself);
 * they are deliberately NOT restated here, because P7's claim is the
 * provenance one and the extra families can only ever make the missing list
 * longer — which neither claim below is disturbed by.
 */
function ephemeralTargets(plan: ProjectionPlan): string[] {
  const paths = new Set<string>();
  for (const action of plan.actions) {
    if (action.provenance === 'authored') continue;
    if (action.source) paths.add(action.source);
    if (action.target && action.kind !== 'native') paths.add(action.target);
  }
  return [...paths];
}

/**
 * Whether a `.gitignore` in the target's OWN directory ignores it — read off
 * disk after the apply, not off the plan, because the promise is about the file
 * git will consult.
 */
function selfIgnoredOnDisk(repoRoot: string, target: string): boolean {
  const slash = target.lastIndexOf('/');
  if (slash === -1) return false;
  const abs = join(repoRoot, target.slice(0, slash), '.gitignore');
  if (!existsSync(abs)) return false;
  const name = target.slice(slash + 1);
  return readFileSync(abs, 'utf8')
    .split('\n')
    .some((line) => gitignorePatternMatches(line, name));
}

/** Whether the repo's own root `.gitignore` covers a path. */
function coveredByRepo(repoRoot: string, target: string): boolean {
  const abs = join(repoRoot, '.gitignore');
  if (!existsSync(abs)) return false;
  return readFileSync(abs, 'utf8')
    .split('\n')
    .some((line) => gitignorePatternMatches(line, target));
}

describe('P7 — every ephemeral projection has a way to stay out of git', () => {
  it(
    'is covered by a declared pattern or by a self-ignoring .gitignore beside it',
    () => {
      let examined = 0;
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const plan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, plan, { sweepOrphans: true });

            for (const target of ephemeralTargets(plan)) {
              examined += 1;
              const declared = EPHEMERAL_GITIGNORE_PATTERNS.some((pattern) =>
                gitignorePatternMatches(pattern, target)
              );
              expect({
                target,
                covered: declared || selfIgnoredOnDisk(repoRoot, target),
              }).toEqual({ target, covered: true });
            }
          });
        }),
        RUNS
      );
      // A green that looked at nothing is not a green.
      expect(examined).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'reports missing lines exactly when this repo does not already cover them',
    () => {
      let reported = 0;
      let silent = 0;
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const plan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, plan, { sweepOrphans: true });

            const missing = missingGitignoreLines(repoRoot, plan);
            if (spec.gitignore === null) {
              // Not a git checkout: nothing to say, and saying it anyway would be
              // telling somebody to edit a file that decides nothing.
              expect(missing).toEqual([]);
              return;
            }

            const uncovered = ephemeralTargets(plan).filter(
              (target) => !coveredByRepo(repoRoot, target) && !selfIgnoredOnDisk(repoRoot, target)
            );
            if (missing.length === 0) {
              silent += 1;
              expect(uncovered).toEqual([]);
            } else {
              reported += 1;
              // Every line offered is one the engine declares, never an invention.
              for (const line of missing) {
                expect({
                  line,
                  declared: (EPHEMERAL_GITIGNORE_PATTERNS as readonly string[]).includes(line),
                }).toEqual({ line, declared: true });
              }
            }
            if (uncovered.length > 0) expect(missing.length).toBeGreaterThan(0);
          });
        }),
        RUNS
      );
      // Both sides of the claim were actually reached.
      expect(reported).toBeGreaterThan(0);
      expect(silent).toBeGreaterThan(0);
    },
    PROPERTY_TIMEOUT_MS
  );
});
