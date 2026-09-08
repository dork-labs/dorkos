/**
 * P9a — a `native` action names a source that is really there.
 *
 * `native` is the plan saying "the harness reads this file where it already
 * sits, so nothing is written". It is the only kind with no target to check
 * afterwards, which is exactly why it drifted: four separate claims were made
 * about files that need not exist — `AGENTS.md` for Codex/Cursor/OpenCode,
 * `.claude/settings.json` for Claude Code hooks, `.claude/commands` for Claude
 * Code commands, and an installed skill's `.agents/skills` link when no harness
 * planned one (`meta/harness-sync-capabilities.md` §14 item 5, all reproduced
 * 2026-09-07).
 *
 * The property is the general form of all four: over generated repositories —
 * with and without each of those files — every `native` action carries a
 * `source`, and that source exists in the tree. It fails on the unfixed engine.
 *
 * `arbRepo()` is shared with the ownership properties (`./arb-repo.ts`).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { existsOnDisk } from '../journeys/stage.js';
import { arbRepo, withRepo, RUNS } from './arb-repo.js';

describe('P9a — every `native` action points at a source on disk', () => {
  it('never claims a harness reads a file the repository does not have', () => {
    // Counted, not assumed: a property whose subject can be empty on every run
    // proves nothing, so the natives seen across the whole sweep are tallied and
    // the tally is asserted after it.
    let nativesSeen = 0;
    let reposWithNatives = 0;

    fc.assert(
      fc.property(arbRepo(), (spec) => {
        withRepo(spec, ({ repoRoot, dorkHome }) => {
          const plan = project(repoRoot, { dorkHome });
          const natives = plan.actions.filter((a) => a.kind === 'native');
          nativesSeen += natives.length;
          if (natives.length > 0) reposWithNatives += 1;

          for (const action of natives) {
            const source = action.source;
            expect({
              harness: action.harness,
              artifact: action.artifact,
              name: action.name,
              hasSource: source !== undefined,
            }).toEqual({
              harness: action.harness,
              artifact: action.artifact,
              name: action.name,
              hasSource: true,
            });
            expect({
              harness: action.harness,
              artifact: action.artifact,
              source,
              exists: existsOnDisk(join(repoRoot, source as string)),
            }).toEqual({
              harness: action.harness,
              artifact: action.artifact,
              source,
              exists: true,
            });
          }
        });
      }),
      RUNS
    );

    expect(reposWithNatives).toBeGreaterThan(0);
    expect(nativesSeen).toBeGreaterThan(0);
  });
});
