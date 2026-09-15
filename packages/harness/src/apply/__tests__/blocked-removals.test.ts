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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { GENERATED_COMMAND_MARKER } from '../../plan/installed-projector.js';
import { applyPlan, checkPlan } from '../apply.js';
import { applyGlobalPlan, checkGlobalPlan } from '../global-apply.js';
import { projectGlobal } from '../../plan/global-projector.js';
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

describe('AP-07, AP-11 — the wrapper directory a tidy-up cannot take', () => {
  /**
   * A repository whose one generated command wrapper is an orphan, inside a
   * `.claude/commands` that lists perfectly and refuses a write.
   *
   * The wrapper FILE's own folder (`.claude/commands/acme`) is writable, so the
   * file sweep takes it — and the tidy-up that follows removes the emptied
   * `acme` directory, which writes `.claude/commands`. That second write met no
   * probe at all: `--check` promised the file, `--fix` deleted it and then threw
   * EACCES on the directory, after which sweeps five and six never ran.
   *
   * @param wrapper - whether to stage the wrapper file, or leave `acme` empty.
   * @returns the repository root and its dork home.
   */
  function stageReadOnlyCommandsDir(wrapper: 'file' | 'empty'): {
    repo: string;
    dorkHome: string;
  } {
    const repo = mkdtempSync(join(tmpdir(), 'harness-ro-commands-repo-'));
    const dorkHome = mkdtempSync(join(tmpdir(), 'harness-ro-commands-home-'));
    staged.push(repo, dorkHome);
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code'],
    });
    writeFileAt(join(repo, 'AGENTS.md'), '# agents\n');
    const acme = join(repo, '.claude', 'commands', 'acme');
    mkdirSync(acme, { recursive: true });
    if (wrapper === 'file') {
      writeFileAt(join(acme, 'ship.md'), `${GENERATED_COMMAND_MARKER}\n\n# ship\n`);
    }
    chmodSync(join(repo, '.claude', 'commands'), 0o555);
    relaxed.push(join(repo, '.claude', 'commands'));
    return { repo, dorkHome };
  }

  it.skipIf(!CAN_MAKE_READ_ONLY)('does not throw after taking the file inside it', () => {
    // Seeded defect: leave the tidy-up unprobed. `--fix` removes `ship.md`,
    // then `rmSync` on the emptied `acme` raises EACCES out of the middle of
    // the apply — the two sweeps after this one never run, and the tree is
    // half swept (DOR-1941 F1).
    const { repo, dorkHome } = stageReadOnlyCommandsDir('file');
    const plan = project(repo, { dorkHome });

    const result = applyPlan(repo, plan, { sweepOrphans: true });

    expect(result.swept).toEqual(['.claude/commands/acme/ship.md']);
    expect(existsSync(join(repo, '.claude', 'commands', 'acme'))).toBe(true);
    expect(result.warnings).toEqual([
      '`.claude/commands/acme` would be removed, and DorkOS may not write in ' +
        '`.claude/commands` (permission denied), so it was left exactly as it is. Fix the ' +
        'folder’s permissions, then re-run.',
    ]);
  });

  it.skipIf(!CAN_MAKE_READ_ONLY)('says so before the run, not after it', () => {
    const { repo, dorkHome } = stageReadOnlyCommandsDir('file');
    const plan = project(repo, { dorkHome });

    const drift = checkPlan(repo, plan);

    expect(drift.warnings).toEqual(applyPlan(repo, plan, { sweepOrphans: true }).warnings);
  });

  it.skipIf(!CAN_MAKE_READ_ONLY)('names an already-empty wrapper directory too', () => {
    // The degenerate case, and the one that was completely silent: nothing to
    // sweep at all, so the finder answered `[]`, `--check` said the tree was
    // clean — and the tidy-up still threw on the way past.
    const { repo, dorkHome } = stageReadOnlyCommandsDir('empty');
    const plan = project(repo, { dorkHome });

    const drift = checkPlan(repo, plan);

    expect(drift.orphans).toEqual([]);
    expect(drift.warnings).toEqual([
      expect.stringContaining('`.claude/commands/acme` would be removed'),
    ]);
    expect(() => applyPlan(repo, plan, { sweepOrphans: true })).not.toThrow();
  });
});

describe('AP-07 — a blocked removal is not a clean tree', () => {
  it.skipIf(!CAN_MAKE_READ_ONLY)('answers clean: false, the way a blocked write does', () => {
    // Seeded defect: leave the blocked-removal count out of `clean`. The
    // terminal then prints "No drift — every projection already matches the
    // plan" over a stale projection DorkOS can see and has decided not to
    // remove, which is the sentence AP-07 exists to make true.
    const { repo, dorkHome } = stageReadOnlyOrphan();
    // Everything else settled first, so `clean` is answering about the blocked
    // removal and nothing else.
    chmodSync(join(repo, '.claude', 'skills'), 0o755);
    applyPlan(repo, project(repo, { dorkHome }));
    chmodSync(join(repo, '.claude', 'skills'), 0o555);

    const drift = checkPlan(repo, project(repo, { dorkHome }));

    expect({ drifted: drift.drifted.length, blocked: drift.blocked.length }).toEqual({
      drifted: 0,
      blocked: 0,
    });
    expect(drift.clean).toBe(false);
  });
});

describe('AP-07 — the sweep warnings belong to a sweep', () => {
  it.skipIf(!CAN_MAKE_READ_ONLY)('says nothing when this run sweeps nothing', () => {
    // `applyPlan` without `sweepOrphans` removes nothing at all, so a sentence
    // about what it declined to remove would be about a run that never
    // happened. `--check` still previews it, because previewing is what it is
    // for.
    const { repo, dorkHome } = stageReadOnlyOrphan();
    const plan = project(repo, { dorkHome });

    expect(applyPlan(repo, plan).warnings).toEqual([]);
    expect(checkPlan(repo, plan).warnings.length).toBe(1);
  });
});

describe('AP-07 global — a link DorkOS may not remove from a home directory', () => {
  /**
   * A dork home holding one link whose package is gone, inside a
   * `<dorkHome>/skills` that lists and refuses a write.
   *
   * The global sweep had the same hole the project sweeps did (F5): `rmSync`
   * needs the parent's write bit, `findGlobalOrphans` asked nothing, and
   * `checkGlobalPlan` promised the removal that `applyGlobalPlan` then threw on.
   *
   * @returns the dork home and the roots the plan is built from.
   */
  function stageReadOnlyGlobalSkills(): { dorkHome: string; skills: string } {
    const dorkHome = mkdtempSync(join(tmpdir(), 'harness-ro-global-'));
    staged.push(dorkHome);
    const skills = join(dorkHome, 'skills');
    mkdirSync(skills, { recursive: true });
    // A link whose package was uninstalled: its text resolves inside
    // `<dorkHome>/plugins`, which is what makes it ours to sweep.
    symlinkSync(join(dorkHome, 'plugins', 'gone', 'skills', 'x'), join(skills, 'gone__x'));
    mkdirSync(join(dorkHome, 'plugins'), { recursive: true });
    chmodSync(skills, 0o555);
    relaxed.push(skills);
    return { dorkHome, skills };
  }

  it.skipIf(!CAN_MAKE_READ_ONLY)('is neither promised nor thrown on', () => {
    const { dorkHome, skills } = stageReadOnlyGlobalSkills();
    const roots = { dorkHome };
    const plan = projectGlobal({ roots, harnesses: [] });

    const drift = checkGlobalPlan(plan, roots);

    expect(drift.orphans).toEqual([]);
    expect(drift.warnings).toEqual([
      `\`${join(skills, 'gone__x')}\` would be removed, and DorkOS may not write in ` +
        `\`${skills}\` (permission denied), so it was left exactly as it is. Fix the ` +
        `folder’s permissions, then re-run.`,
    ]);
    expect(drift.clean).toBe(false);

    const applied = applyGlobalPlan(plan, roots, { sweepOrphans: true });
    expect(applied.swept).toEqual([]);
    expect(applied.warnings).toEqual(drift.warnings);
  });

  it.skipIf(!CAN_MAKE_READ_ONLY)('takes the link once the folder is writable again', () => {
    const { dorkHome, skills } = stageReadOnlyGlobalSkills();
    chmodSync(skills, 0o755);
    const roots = { dorkHome };

    const applied = applyGlobalPlan(projectGlobal({ roots, harnesses: [] }), roots, {
      sweepOrphans: true,
    });

    expect(applied.swept).toEqual([join(skills, 'gone__x')]);
    expect(applied.warnings).toEqual([]);
  });
});

describe('AP-07 — the tidy-up reads what the sweep really took', () => {
  /**
   * A wrapper file the sweep may NOT take, inside a wrapper directory that the
   * tidy-up may take.
   *
   * `.claude/commands` is writable, so `rmSync` on `acme` itself would succeed;
   * `.claude/commands/acme` is 0555, so it lists perfectly and refuses to give
   * up `ship.md`. The two permissions pull in opposite directions, which is what
   * makes this the case that tells the filtered orphan list from the raw one: a
   * directory is only emptied by entries the sweep ACTUALLY removes, and
   * `ship.md` is not one of them.
   *
   * A mutant reading the unfiltered list calls `acme` emptied, finds its own
   * parent writable, and calls `rmSync(acme, { recursive: true })` on a
   * directory that still holds a file it may not unlink. It survived all 773
   * tests in this package.
   *
   * @returns the repository root and its dork home.
   */
  function stageUnremovableWrapper(): { repo: string; dorkHome: string } {
    const repo = mkdtempSync(join(tmpdir(), 'harness-ro-wrapper-repo-'));
    const dorkHome = mkdtempSync(join(tmpdir(), 'harness-ro-wrapper-home-'));
    staged.push(repo, dorkHome);
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code'],
    });
    writeFileAt(join(repo, 'AGENTS.md'), '# agents\n');
    const acme = join(repo, '.claude', 'commands', 'acme');
    mkdirSync(acme, { recursive: true });
    writeFileAt(join(acme, 'ship.md'), `${GENERATED_COMMAND_MARKER}\n\n# ship\n`);
    chmodSync(acme, 0o555);
    relaxed.push(acme);
    return { repo, dorkHome };
  }

  it.skipIf(!CAN_MAKE_READ_ONLY)('leaves a directory whose file it could not take', () => {
    const { repo, dorkHome } = stageUnremovableWrapper();
    const plan = project(repo, { dorkHome });

    const result = applyPlan(repo, plan, { sweepOrphans: true });

    // Nothing removed, nothing thrown, and both paths still on disk.
    expect(result.swept).toEqual([]);
    expect({
      wrapper: existsSync(join(repo, '.claude', 'commands', 'acme', 'ship.md')),
      dir: existsSync(join(repo, '.claude', 'commands', 'acme')),
    }).toEqual({ wrapper: true, dir: true });

    // One sentence, naming the file that would have gone and the folder that
    // would not give it up.
    expect(result.warnings).toEqual([
      '`.claude/commands/acme/ship.md` would be removed, and DorkOS may not write in ' +
        '`.claude/commands/acme` (permission denied), so it was left exactly as it is. Fix the ' +
        'folder’s permissions, then re-run.',
    ]);
    expect(checkPlan(repo, plan).warnings).toEqual(result.warnings);
  });
});
