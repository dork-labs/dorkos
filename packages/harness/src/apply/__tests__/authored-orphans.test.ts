/**
 * The authored-skill orphan sweep (SK-10).
 *
 * Delete or rename `.agents/skills/<x>` and the projection `.claude/skills/<x>`
 * is left pointing at nothing. No plan action names it any more — the source is
 * gone — so nothing used to notice: `--check` called the tree clean and the
 * sweep, keyed on the `__` namespace marker, never looked at it. Claude Code
 * cannot follow a dead link, so the person was left with a broken skill and a
 * command telling them everything was fine.
 *
 * The sweep's predicate is deliberately narrow, and each clause is refused
 * separately below: the entry must be a **symlink** (a real directory is
 * somebody's content), its link text must resolve **into `.agents/skills/`** (a
 * link into a vendored directory elsewhere is the person's own), its target must
 * be **gone** (a live link is a projection), and it must NOT carry `__` (that is
 * `sweepInstalledOrphans`' job, and letting both claim one path would sweep and
 * report it twice).
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** A claude-code repo with the named authored skills, projected and applied. */
function stageProjectedRepo(skills: string[]): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-orphan-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-orphan-home-'));
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n');
  for (const name of skills) {
    writeFileAt(join(repo, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
  for (const name of skills) {
    expect(lstatSync(join(repo, '.claude', 'skills', name)).isSymbolicLink()).toBe(true);
  }
}

/** Put a symlink at `rel` pointing wherever `linkText` says. */
function linkAt(rel: string, linkText: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  symlinkSync(linkText, abs);
}

/** Project and apply with the sweep on, returning what it swept. */
function syncWithSweep(): string[] {
  return applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true }).swept;
}

describe('an authored skill that is gone', () => {
  it('is named by --check and pruned by --fix', () => {
    stageProjectedRepo(['keep', 'gone']);
    rmSync(join(repo, '.agents', 'skills', 'gone'), { recursive: true, force: true });

    const drift = checkPlan(repo, project(repo, { dorkHome }));
    expect(drift.orphans).toEqual(['.claude/skills/gone']);
    expect(drift.clean).toBe(false);

    expect(syncWithSweep()).toEqual(['.claude/skills/gone']);
    expect(existsSync(join(repo, '.claude', 'skills', 'gone'))).toBe(false);
    // Only the orphan: the live projection beside it is untouched.
    expect(lstatSync(join(repo, '.claude', 'skills', 'keep')).isSymbolicLink()).toBe(true);
    expect(checkPlan(repo, project(repo, { dorkHome })).clean).toBe(true);
  });

  it('leaves a live projection alone, sweep after sweep', () => {
    stageProjectedRepo(['keep']);
    expect(syncWithSweep()).toEqual([]);
    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([]);
  });
});

describe('what the orphan sweep refuses to touch', () => {
  it('a real directory somebody put in .claude/skills', () => {
    stageProjectedRepo([]);
    writeFileAt(join(repo, '.claude', 'skills', 'mine', 'SKILL.md'), '# mine\n');

    expect(syncWithSweep()).toEqual([]);
    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([]);
    expect(readFileSync(join(repo, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe(
      '# mine\n'
    );
  });

  it('a dead link the person made themselves, pointing outside .agents/skills', () => {
    // Someone links a skill in from a vendored checkout and the checkout moves.
    // That link is theirs to fix; DorkOS never wrote it and never removes it.
    stageProjectedRepo([]);
    linkAt('.claude/skills/vendored', '../../vendor/skills/vendored');

    expect(syncWithSweep()).toEqual([]);
    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([]);
    expect(lstatSync(join(repo, '.claude', 'skills', 'vendored')).isSymbolicLink()).toBe(true);
  });

  it("a dead __ link, which is the installed sweep's to take", () => {
    // An authored skill NAMED with `__` projects to a path that looks managed
    // (DOR-1844). Deleted, its dead link matches both sweeps' shapes — and one
    // path may only have one owner, or it is swept and reported twice.
    stageProjectedRepo(['my__helper']);
    rmSync(join(repo, '.agents', 'skills', 'my__helper'), { recursive: true, force: true });

    // Asked BEFORE any sweep, so the answer is about the predicate and not about
    // which sweep happened to run first. `--check` stays quiet about `__` links,
    // as it always has for an uninstalled plugin's — that asymmetry is older than
    // this rule and is not what SK-10 is about.
    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([]);

    // And the installed sweep does take it, exactly once.
    expect(syncWithSweep()).toEqual(['.claude/skills/my__helper']);
    expect(existsSync(join(repo, '.claude', 'skills', 'my__helper'))).toBe(false);
  });
});
