/**
 * DOR-1941 — an orphan inside a folder DorkOS may not write in.
 *
 * DOR-1882 closed every write-path shape: all four writing kinds write only on
 * a difference, and a folder that is a file, unfollowable, unreadable or
 * unwritable blocks that one action in both modes with the same reason. **The
 * deletion half had no such gate.** `rmSync` needs the write bit on the PARENT
 * directory, and no probe covered a sweep target, because an orphan is by
 * definition not in the plan and so never meets one.
 *
 * Measured on the built dist at base `0d3b4192e`: a dead link inside a mode-0555
 * `.claude/skills` gave `checkPlan` `clean: false` and `orphans:
 * ['.claude/skills/gone']` — a promise — and then `applyPlan` threw EACCES out
 * of `sweepAuthoredOrphans`, AFTER the action loop had already written. A
 * half-swept tree, over a permission both modes could have read first.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

/** Whether this machine can stage a folder that lists but may not be written in. */
const CAN_MAKE_READ_ONLY = process.platform !== 'win32' && process.getuid?.() !== 0;

const relaxed: string[] = [];
const staged: string[] = [];

afterEach(() => {
  for (const dir of relaxed.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone
    }
  }
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository holding one dead `.claude/skills` link inside a read-only folder.
 *
 * The link is a real orphan — its skill is gone, so no plan action names it —
 * and the folder around it lists perfectly and refuses a write, which is what
 * `rmSync` needs and what nothing had asked.
 *
 * @returns the repository root and its dork home.
 */
function stageReadOnlyOrphan(): { repo: string; dorkHome: string } {
  const repo = mkdtempSync(join(tmpdir(), 'harness-ro-orphan-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-ro-orphan-home-'));
  staged.push(repo, dorkHome);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# agents\n');
  const skills = join(repo, '.claude', 'skills');
  mkdirSync(skills, { recursive: true });
  symlinkSync(join('..', '..', '.agents', 'skills', 'gone'), join(skills, 'gone'));
  chmodSync(skills, 0o555);
  relaxed.push(skills);
  return { repo, dorkHome };
}

describe('AP-07, AP-11 — a removal DorkOS may not make', () => {
  it.skipIf(!CAN_MAKE_READ_ONLY)('is not promised by --check', () => {
    // Seeded defect: take the probe out of `findOrphanedAuthoredLinks`. The
    // path comes back in `orphans` and `removals`, which is a promise the very
    // next `--fix` cannot keep.
    const { repo, dorkHome } = stageReadOnlyOrphan();

    const drift = checkPlan(repo, project(repo, { dorkHome }));

    expect({ orphans: drift.orphans, removals: drift.removals }).toEqual({
      orphans: [],
      removals: [],
    });
    expect(drift.warnings).toEqual([
      '`.claude/skills/gone` would be removed, and DorkOS may not write in `.claude/skills` ' +
        '(permission denied), so it was left exactly as it is. Fix the folder’s permissions, ' +
        'then re-run.',
    ]);
  });

  it.skipIf(!CAN_MAKE_READ_ONLY)('does not throw out of a --fix', () => {
    // The half that cost a tree: the sweeps run AFTER the action loop, so an
    // EACCES there is not a failed run, it is a partly applied one.
    const { repo, dorkHome } = stageReadOnlyOrphan();
    const plan = project(repo, { dorkHome });

    const result = applyPlan(repo, plan, { sweepOrphans: true });

    expect(result.swept).toEqual([]);
    expect(result.warnings).toEqual(checkPlan(repo, plan).warnings);
  });

  it.skipIf(!CAN_MAKE_READ_ONLY)('removes it once the folder is writable again', () => {
    // The way out really works: the sentence tells a person to fix the
    // permissions, and a run after that takes the link.
    const { repo, dorkHome } = stageReadOnlyOrphan();
    chmodSync(join(repo, '.claude', 'skills'), 0o755);

    const result = applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    expect(result.swept).toEqual(['.claude/skills/gone']);
    expect(result.warnings).toEqual([]);
  });
});
