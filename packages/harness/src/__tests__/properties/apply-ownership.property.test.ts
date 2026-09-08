/**
 * Property tests for the apply stage's ownership rules (T0 P3 + P4).
 *
 * The generator lives in `arb-repo.ts` — a whole small repository with authored
 * skills, plugins, authored hooks, a random enabled-harness subset, and hostile
 * occupants (a hand-written file at a generated hook target, a real directory at
 * a skill link target, a dead symlink at one of the engine's targets). Each
 * generated repo is materialised into a real temp dir, projected, and applied for
 * real; nothing here is mocked.
 *
 * - **P3 — a conflict never destroys.** Every occupant the person staged holds
 *   the same bytes after apply, and every one of them is named: as a `conflict`
 *   when the plan wanted to write that path and could not, and as `leftAlone`
 *   when the plan never wanted it.
 * - **P4 — the sweep touches only what the engine wrote.** After an apply, some
 *   sources are deleted and the repo is re-projected and applied with the sweep
 *   on: every path the sweep removed was written by an earlier apply in this
 *   run, no unowned file is ever removed, and a generated file and its
 *   `.dorkos-generated` sidecar are swept together or not at all. Ownership —
 *   not the manifest — is the whole guard, so an OWNED file whose harness has
 *   left the manifest is swept; that named case lives in
 *   `apply/__tests__/generated-ownership.test.ts`.
 *
 * P2 (no orphan survives) and P2b (`checkPlan` never throws) run off the same
 * generator in `orphaned-links.property.test.ts`.
 *
 * The seed is fixed so a failure is reproducible; fast-check prints it (and the
 * shrunk counterexample) in the failure message.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import { COPILOT_HOOKS_TARGET } from '../../generate/hooks.js';
import { diffSnapshots, existsOnDisk, readText, snapshotTree } from '../journeys/stage.js';
import {
  arbRepo,
  isAdoptableLegacy,
  occupantContent,
  PERSON_LINK_PATH,
  PROPERTY_TIMEOUT_MS,
  RUNS,
  SIDECAR_SUFFIX,
  TARGET_HARNESS,
  withRepo,
} from './arb-repo.js';

describe('P3 — a conflict never destroys what somebody else wrote', () => {
  it(
    'leaves every staged occupant byte-identical and names it in conflicts',
    () => {
      fc.assert(
        fc.property(arbRepo(), (spec) => {
          withRepo(spec, ({ repoRoot, dorkHome, occupantAbs }) => {
            const plan = project(repoRoot, { dorkHome });
            const { conflicts, applied, leftAlone } = applyPlan(repoRoot, plan, {
              sweepOrphans: true,
            });
            const conflictTargets = new Set(conflicts.map((c) => c.target));
            const leftAloneTargets = new Set(leftAlone);

            if (
              spec.occupant &&
              occupantAbs &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
            ) {
              // Unowned and not the engine's own legacy output: the file is the
              // person's. Untouched, and reported — as a conflict when the plan
              // wanted that path, as left alone when not.
              const target = spec.occupant.target;
              expect(readText(occupantAbs)).toBe(occupantContent(target, spec.occupant.shape));
              expect(applied.some((a) => a.target === target)).toBe(false);
              const planned = plan.actions.some(
                (a) => a.kind === 'generate' && a.target === target
              );
              expect({ target, planned, named: true }).toEqual({
                target,
                planned,
                named: planned ? conflictTargets.has(target) : leftAloneTargets.has(target),
              });
              // Never both, so a person is told one thing about one file.
              expect(conflictTargets.has(target) && leftAloneTargets.has(target)).toBe(false);
            }

            if (
              spec.dirOccupant &&
              spec.skills.length > 0 &&
              spec.harnesses.includes('claude-code')
            ) {
              const rel = `.claude/skills/${spec.skills[0]}`;
              expect(readText(join(repoRoot, rel, 'precious.md'))).toBe('# do not delete\n');
              expect(conflictTargets.has(rel)).toBe(true);
            }
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});

describe('P4 — the sweep removes only what an earlier apply wrote', () => {
  it(
    'never sweeps a path it did not write, a disabled harness, or a file without its sidecar',
    () => {
      fc.assert(
        fc.property(arbRepo(), fc.boolean(), (spec, dropPlugins) => {
          withRepo(spec, ({ repoRoot, dorkHome }) => {
            const before = snapshotTree(repoRoot);
            const firstPlan = project(repoRoot, { dorkHome });
            applyPlan(repoRoot, firstPlan, { sweepOrphans: true });
            const afterFirst = snapshotTree(repoRoot);

            // The ledger: everything the first apply created or rewrote, plus any
            // occupant the generator staged as already engine-owned (a matching
            // sidecar) — the engine may legitimately sweep its own file, and a
            // no-op rewrite leaves no trace in the diff.
            const { added, changed } = diffSnapshots(before, afterFirst);
            const ledger = new Set([...added, ...changed]);
            if (spec.occupant?.sidecar === 'matching') {
              ledger.add(spec.occupant.target);
              ledger.add(`${spec.occupant.target}${SIDECAR_SUFFIX}`);
            }
            if (spec.widowedSidecar) ledger.add(`${COPILOT_HOOKS_TARGET}${SIDECAR_SUFFIX}`);
            // Deliberately NO exception for the generated dead `.claude/skills`
            // link: the FIRST apply sweeps it, so it can never appear in the second
            // apply's `swept` and an entry for it would be a licence nothing uses.
            // The person's own dead link gets no exception either — that is the
            // point of staging it.

            // Remove sources, so the second pass has orphans to sweep.
            if (dropPlugins) {
              rmSync(join(repoRoot, '.dork', 'plugins'), { recursive: true, force: true });
            } else if (spec.skills.length > 0) {
              rmSync(join(repoRoot, '.agents', 'skills', spec.skills[0]), {
                recursive: true,
                force: true,
              });
            }

            const secondPlan = project(repoRoot, { dorkHome });
            const { swept } = applyPlan(repoRoot, secondPlan, { sweepOrphans: true });
            const sweptSet = new Set(swept);
            // The one path the generator guarantees the engine does NOT own — and
            // may not adopt either, so it must survive every sweep.
            const unowned =
              spec.occupant &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
                ? spec.occupant.target
                : undefined;

            for (const path of swept) {
              expect({ path, inLedger: ledger.has(path) }).toEqual({ path, inLedger: true });

              const base = path.endsWith(SIDECAR_SUFFIX)
                ? path.slice(0, -SIDECAR_SUFFIX.length)
                : path;
              if (!TARGET_HARNESS[base]) continue;

              // Ownership is the whole guard: an unowned file is never swept.
              expect({ path, unowned }).not.toEqual({ path, unowned: base });

              // A generated file and its sidecar go together — except a widowed
              // sidecar, which the sweep may take on its own precisely because
              // there is no file left to pair it with.
              expect(sweptSet.has(`${base}${SIDECAR_SUFFIX}`)).toBe(true);
              const filePresent = existsOnDisk(join(repoRoot, base));
              expect({ base, fileSwept: sweptSet.has(base) }).toEqual({
                base,
                fileSwept: sweptSet.has(base) || !filePresent,
              });
            }

            // Nothing the person owns is ever gone, and it still holds their bytes.
            if (
              spec.occupant &&
              spec.occupant.sidecar !== 'matching' &&
              !isAdoptableLegacy(spec.occupant)
            ) {
              const abs = join(repoRoot, spec.occupant.target);
              expect({ path: spec.occupant.target, present: existsOnDisk(abs) }).toEqual({
                path: spec.occupant.target,
                present: true,
              });
              expect(readText(abs)).toBe(
                occupantContent(spec.occupant.target, spec.occupant.shape)
              );
            }

            // Their own dead link is dead, is a symlink, and sits in a projection
            // dir — and points somewhere DorkOS has no claim over, so it stays.
            if (spec.personLink) {
              expect({
                path: PERSON_LINK_PATH,
                present: existsOnDisk(join(repoRoot, PERSON_LINK_PATH)),
              }).toEqual({ path: PERSON_LINK_PATH, present: true });
            }
          });
        }),
        RUNS
      );
    },
    PROPERTY_TIMEOUT_MS
  );
});
