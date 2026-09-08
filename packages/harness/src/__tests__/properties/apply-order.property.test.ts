/**
 * Property test for the determinism half of AP-10 (T0 P10).
 *
 * "Two concurrent applies converge" rests on a claim nothing had ever checked:
 * that the ORDER the actions land in does not change where the tree ends up.
 * If it did, the atomic writes and the in-process lock would be beside the
 * point — two writers interleaving one plan would end somewhere neither of them
 * would have reached alone, and nothing about the end state would be knowable.
 *
 * Two shapes, because they fail differently:
 *
 * - **P10a — a shuffled plan.** The same actions in a random order leave the
 *   same tree as the planner's order. Action object identity is preserved
 *   through the shuffle, which is what keeps the deterministic-bytes side table
 *   (`plan/content-map.ts`) resolving.
 * - **P10b — a split plan.** Cutting the actions into two halves and applying
 *   them one after the other leaves the same tree as applying them all at once.
 *   This is the one that models the real hazard: a writer that got through half
 *   its plan before another writer started on the whole of it.
 *
 * The orphan sweep is off throughout, and that is not a dodge: a sweep reads the
 * plan it is given as the whole truth, so a HALF plan would legitimately prune
 * the other half's projections. Sweep behaviour is P4's subject
 * (`apply-ownership.property.test.ts`); this is about the writes.
 *
 * The generator is the shared `arbRepo()`, hostile occupants and all, so a
 * conflict, a dead link and a hand-written file at a generated target are in
 * the mix — the states where an order dependency would be easiest to introduce.
 *
 * **What it takes to red this, said honestly.** Nothing in today's apply stage
 * does: every action's outcome depends on ITS OWN target and on nothing another
 * action did, which is precisely the invariant here — so this is a standing
 * guard rather than a reproduction. Its teeth were measured instead: an apply
 * that stops after three actions (`if (applied.length >= 3) break;` in
 * `applyPlan`) fails both properties and prints the shrunk repo that shows it.
 * A future coupling — a blocked-target check recomputed mid-loop, a write that
 * assumes another action created its directory, a second action writing the
 * same path — reds here the same way.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { project } from '../../engine.js';
import { applyPlan } from '../../apply/apply.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { scrubbedSnapshot } from '../journeys/stage.js';
import { arbRepo, PROPERTY_TIMEOUT_MS, RUNS, withRepo } from './arb-repo.js';

/** The same plan with its actions in a given order (identity preserved). */
function reordered(plan: ProjectionPlan, order: number[]): ProjectionPlan {
  return { ...plan, actions: order.map((i) => plan.actions[i]!) };
}

describe('P10 — where a plan lands does not depend on the order it lands in', () => {
  it(
    'leaves the same tree whatever order the actions are applied in',
    () => {
      let mostActions = 0;
      fc.assert(
        fc.property(arbRepo(), fc.nat(), (spec, seed) => {
          let baseline: Record<string, string> | undefined;

          // The two runs are two identically generated repos, because applying a
          // plan twice to ONE repo would only re-prove idempotence.
          for (const shuffle of [false, true]) {
            withRepo(spec, ({ repoRoot, dorkHome }) => {
              const plan = project(repoRoot, { dorkHome });
              mostActions = Math.max(mostActions, plan.actions.length);
              const order = plan.actions.map((_, i) => i);
              if (shuffle) {
                // A deterministic shuffle from the generated seed, so a failing
                // case replays exactly.
                for (let i = order.length - 1; i > 0; i--) {
                  const j = (seed * 31 + i * 17) % (i + 1);
                  [order[i], order[j]] = [order[j]!, order[i]!];
                }
              }
              applyPlan(repoRoot, reordered(plan, order), { sweepOrphans: false });
              const tree = scrubbedSnapshot(repoRoot);
              if (baseline === undefined) baseline = tree;
              else expect(tree).toEqual(baseline);
            });
          }
        }),
        RUNS
      );
      // A run whose plans were all one action long would prove nothing about order.
      expect(mostActions).toBeGreaterThan(4);
    },
    PROPERTY_TIMEOUT_MS
  );

  it(
    'leaves the same tree when one writer applies half the plan before the rest',
    () => {
      let realCuts = 0;
      fc.assert(
        fc.property(arbRepo(), fc.nat(), (spec, cutSeed) => {
          let baseline: Record<string, string> | undefined;

          for (const split of [false, true]) {
            withRepo(spec, ({ repoRoot, dorkHome }) => {
              const plan = project(repoRoot, { dorkHome });
              if (!split) {
                applyPlan(repoRoot, plan, { sweepOrphans: false });
              } else {
                const cut = plan.actions.length === 0 ? 0 : cutSeed % (plan.actions.length + 1);
                if (cut > 0 && cut < plan.actions.length) realCuts++;
                applyPlan(
                  repoRoot,
                  { ...plan, actions: plan.actions.slice(0, cut) },
                  { sweepOrphans: false }
                );
                applyPlan(
                  repoRoot,
                  { ...plan, actions: plan.actions.slice(cut) },
                  { sweepOrphans: false }
                );
              }
              const tree = scrubbedSnapshot(repoRoot);
              if (baseline === undefined) baseline = tree;
              else expect(tree).toEqual(baseline);
            });
          }
        }),
        RUNS
      );
      // A run that only ever cut at 0 or at the end never split anything.
      expect(realCuts).toBeGreaterThan(4);
    },
    PROPERTY_TIMEOUT_MS
  );
});
