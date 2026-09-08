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
 * separately below, plus the two that are about the plan rather than the entry:
 * a link the plan still names is drift for `applySymlink`, and a LIVE link the
 * plan no longer names (a harness left the manifest) is a projection somebody may
 * still be using, not litter.
 *
 * The clauses on the entry itself: the entry must be a **symlink** (a real directory is
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

/** Rewrite the staged repo's manifest to enable exactly these harnesses. */
function setHarnesses(harnesses: string[]): void {
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), { version: 1, harnesses });
}

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
    // which sweep happened to run first. The authored finder passes it over and
    // the installed one claims it, so `--check` names it ONCE — the whole point
    // of one owner per path, now that both finders answer `orphans` (DOR-1889).
    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([
      '.claude/skills/my__helper',
    ]);

    // And the installed sweep does take it, exactly once.
    expect(syncWithSweep()).toEqual(['.claude/skills/my__helper']);
    expect(existsSync(join(repo, '.claude', 'skills', 'my__helper'))).toBe(false);
  });
});

describe('what the orphan sweep refuses to touch, on the plan side', () => {
  it('a LIVE projection the plan stopped naming — a harness left the manifest', () => {
    // Turning Claude Code off in the manifest stops DorkOS projecting INTO it. It
    // does not make the links already there litter: they resolve, the person may
    // still be running `claude` in this repo, and deleting a working projection
    // because a plan no longer mentions it is exactly the overreach HK-11 was.
    stageProjectedRepo(['keep']);
    const link = join(repo, '.claude', 'skills', 'keep');
    setHarnesses(['codex']);

    expect(checkPlan(repo, project(repo, { dorkHome })).orphans).toEqual([]);
    expect(syncWithSweep()).toEqual([]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(link)).toBe(true); // still resolves
  });

  it('a DEAD link at a target the plan still names — that is drift, not an orphan', () => {
    // The link text points at a skill that is gone while a source of its own name
    // exists, so both descriptions fit. The plan's keep-set decides: `applySymlink`
    // repairs it, and naming it an orphan too would report one path twice and
    // invite the sweep to delete what the same run is about to fix.
    stageProjectedRepo(['keep']);
    const link = join(repo, '.claude', 'skills', 'keep');
    rmSync(link, { force: true });
    linkAt('.claude/skills/keep', '../../.agents/skills/somewhere-else');

    const drift = checkPlan(repo, project(repo, { dorkHome }));
    expect(drift.orphans).toEqual([]);
    expect(drift.drifted.map((a) => a.target)).toEqual(['.claude/skills/keep']);

    expect(syncWithSweep()).toEqual([]);
    expect(existsSync(link)).toBe(true); // repaired, not swept
    expect(checkPlan(repo, project(repo, { dorkHome })).clean).toBe(true);
  });
});

describe('when .claude/skills cannot be read at all', () => {
  it('is no orphans and no crash — a file where the directory should be', () => {
    // `checkPlan` reads this directory before it can say anything, and ENOTDIR out
    // of a drift report helps nobody. A person whose `.claude/skills` is a file
    // has a different problem, and a stack trace is not how they hear about it.
    stageProjectedRepo([]);
    rmSync(join(repo, '.claude', 'skills'), { recursive: true, force: true });
    writeFileAt(join(repo, '.claude', 'skills'), 'not a directory\n');

    const drift = checkPlan(repo, project(repo, { dorkHome }));

    expect(drift.orphans).toEqual([]);
    expect(syncWithSweep()).toEqual([]);
    expect(readFileSync(join(repo, '.claude', 'skills'), 'utf8')).toBe('not a directory\n');
  });
});
