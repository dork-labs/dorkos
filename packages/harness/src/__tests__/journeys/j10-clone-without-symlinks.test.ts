/**
 * J-10 — a teammate clones the repo, and their checkout cannot make symlinks.
 *
 * The projected `.claude/skills/<name>` links are committed like any other file
 * (git stores a symlink as a blob holding its target path, mode `120000`). A
 * clone whose `core.symlinks` is off — the Git for Windows default without
 * Developer Mode — materializes each of those blobs as a PLAIN FILE whose
 * contents are the link text. Nothing is broken about the repository; the
 * checkout simply could not make the link.
 *
 * `git clone -c core.symlinks=false` reproduces that byte-for-byte on macOS and
 * Linux, which is why this journey can run everywhere rather than only on the
 * Windows leg (`.github/workflows/harness-windows.yml`, which runs the whole
 * package for real).
 *
 * The journey asserts three things, and the first is the seeded defect:
 *
 * - **`--check` calls it a conflict, and says why in one line.** Before this
 *   test, `checkPlan` compared "is there a symlink here?", found a file, and
 *   reported every authored link as `drifted` — i.e. "run `--fix` to apply".
 *   The person then ran `--fix`, which reported the same paths as conflicts with
 *   NO reason at all, and changed nothing. Told to re-run the command that just
 *   refused, twice, with no mention of symlinks anywhere.
 * - **`--fix` changes nothing.** The files are the person's checkout, and the
 *   engine never writes over them (measured as an exact before/after tree diff).
 * - **A normal clone is clean and `--fix` is a no-op** (AP-06). The link text is
 *   relative, so where the clone lives does not matter — asserted directly on
 *   the link text, which is the property that makes a clone portable at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { SYMLINKS_OFF_REASON } from '../../apply/symlink-occupants.js';
import { diffSnapshots, snapshotTree, writeFileAt, writeJsonAt } from './stage.js';

/** The two authored skills this repo carries, and the links they project to. */
const SKILLS = ['alpha', 'beta'] as const;

/** Where each authored skill's Claude Code projection lands. */
const LINKS = SKILLS.map((name) => `.claude/skills/${name}`);

let origin = '';
let clone = '';

afterEach(() => {
  for (const d of [origin, clone]) if (d) rmSync(d, { recursive: true, force: true });
  origin = '';
  clone = '';
});

/**
 * Run a git command in `cwd` and return its stdout, failing the test with git's
 * own stderr when it does not exit 0 — a silent git failure would otherwise
 * stage an empty clone and every assertion below would be about nothing.
 */
function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', input });
  expect(
    { command: `git ${args[0]}`, status: result.status },
    result.stderr || result.stdout
  ).toEqual({ command: `git ${args[0]}`, status: 0 });
  return result.stdout.trim();
}

/**
 * Stage a two-skill repo and project it, so the two `.claude/skills` links
 * exist on disk.
 */
function stageProjectedRepo(): void {
  origin = mkdtempSync(join(tmpdir(), 'harness-j10-origin-'));

  writeJsonAt(join(origin, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });
  writeFileAt(join(origin, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
  for (const name of SKILLS) {
    writeFileAt(join(origin, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }

  const plan = project(origin);
  // Nothing zero-subject: the journey is about these two links, so prove the
  // plan really carries them before asserting anything about a clone.
  expect(
    plan.actions
      .filter((a) => a.kind === 'symlink')
      .map((a) => a.target)
      .sort()
  ).toEqual(LINKS);
  const { conflicts } = applyPlan(origin, plan, { sweepOrphans: true });
  expect(conflicts).toEqual([]);
  expect(checkPlan(origin, plan).clean).toBe(true);
  for (const link of LINKS) {
    expect(lstatSync(join(origin, link)).isSymbolicLink()).toBe(true);
  }
}

/**
 * Commit the projected repo, with the two skill links stored as symlinks.
 *
 * Built with git plumbing rather than `add` + `commit`, for one reason that only
 * shows up on Windows: a Windows directory link is a JUNCTION, and git sees a
 * junction as a DIRECTORY. `git add --all` there walks into it and commits the
 * skill's files a second time, so the tree holds no symlink at all and every
 * clone below proves nothing. Measured on a `windows-latest` runner (DOR-1855) —
 * `git ls-files --stage` reported zero entries in mode 120000.
 *
 * Writing the index entry by hand is exact and platform-independent: a symlink
 * in git is a blob holding the target path at mode 120000, which is precisely
 * what a POSIX `git add` of these links produces. `write-tree` + `commit-tree`
 * then build the commit from the index without git refreshing it against a
 * working tree that (on Windows) disagrees with it.
 */
function commitProjectedRepo(): void {
  git(origin, ['init', '--quiet', '--initial-branch=main']);
  // Everything except the links, which are staged by hand below.
  git(origin, ['add', '--all', '--', '.', ':(exclude).claude/skills']);
  for (const [i, link] of LINKS.entries()) {
    const blob = git(origin, ['hash-object', '-w', '--stdin'], `../../.agents/skills/${SKILLS[i]}`);
    expect(blob).toMatch(/^[0-9a-f]{40,64}$/);
    git(origin, ['update-index', '--add', '--cacheinfo', `120000,${blob},${link}`]);
  }
  const tree = git(origin, ['write-tree']);
  const commit = git(origin, [
    '-c',
    'user.email=test@dorkos.ai',
    '-c',
    'user.name=Harness Journey',
    'commit-tree',
    tree,
    '-m',
    'projected',
  ]);
  git(origin, ['update-ref', 'refs/heads/main', commit]);

  // The committed tree really holds two symlinks. Without this the clones below
  // could be cloning two ordinary files and every assertion would still "pass".
  const listed = git(origin, ['ls-tree', '-r', 'refs/heads/main', '--', '.claude/skills']);
  expect(listed.split('\n').filter((l) => l.startsWith('120000'))).toHaveLength(LINKS.length);
}

/** Clone the staged repo into a fresh temp dir, with extra `git -c` settings. */
function cloneOrigin(...config: string[]): string {
  const parent = mkdtempSync(join(tmpdir(), 'harness-j10-clone-'));
  const dest = join(parent, 'checkout');
  git(parent, [...config.flatMap((c) => ['-c', c]), 'clone', '--quiet', origin, dest]);
  return parent;
}

/** Target paths of a list of actions, sorted, for an exact comparison. */
function targets(actions: { target?: string }[]): string[] {
  return actions.map((a) => a.target ?? '(none)').sort();
}

describe('J-10 — a clone whose checkout cannot make symlinks', () => {
  it('reports every authored link as a conflict that names symlinks, and writes nothing', () => {
    stageProjectedRepo();
    commitProjectedRepo();
    const parent = cloneOrigin('core.symlinks=false');
    clone = parent;
    const checkout = join(parent, 'checkout');

    // The precondition the whole journey rests on: git wrote plain files
    // holding the link text, exactly as a Windows checkout without Developer
    // Mode does.
    for (const [i, link] of LINKS.entries()) {
      expect(lstatSync(join(checkout, link)).isFile()).toBe(true);
      expect(readFileSync(join(checkout, link), 'utf8')).toBe(`../../.agents/skills/${SKILLS[i]}`);
    }

    const before = snapshotTree(checkout);
    const drift = checkPlan(checkout, project(checkout));

    // Not `drifted`: a re-run cannot fix this, and telling the person to run
    // `--fix` is telling them to watch it refuse.
    expect(drift.drifted).toEqual([]);
    expect(targets(drift.blocked)).toEqual(LINKS);
    expect(drift.orphans).toEqual([]);
    expect(drift.clean).toBe(false);
    for (const action of drift.blocked) {
      expect(action.reason).toBe(SYMLINKS_OFF_REASON);
    }
    // The one line has to be usable on its own: it says symlinks are off and
    // gives the command that turns them on.
    expect(SYMLINKS_OFF_REASON).toContain('git config core.symlinks true');

    const { applied, conflicts } = applyPlan(checkout, project(checkout), { sweepOrphans: true });

    expect(targets(conflicts)).toEqual(LINKS);
    for (const action of conflicts) expect(action.reason).toBe(SYMLINKS_OFF_REASON);
    expect(applied.filter((a) => a.kind === 'symlink')).toEqual([]);
    // Their checkout, untouched — not one byte, not one path.
    expect(diffSnapshots(before, snapshotTree(checkout))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('is clean in a normal clone, and the committed link text is relative (AP-06)', () => {
    stageProjectedRepo();
    commitProjectedRepo();
    const parent = cloneOrigin();
    clone = parent;
    const checkout = join(parent, 'checkout');

    for (const [i, link] of LINKS.entries()) {
      const text = readlinkSync(join(checkout, link));
      // The property that makes a clone portable: no absolute path survived the
      // commit, so the link resolves wherever the teammate put the checkout.
      // TRUE ON WINDOWS TOO, and measured there (DOR-1855) — what differs is
      // only how the separators are SPELLED. Git stores `../../…` in the blob
      // and Windows hands back `..\..\…`, so the text is compared with its
      // separators normalized and the relative-ness is compared as it stands.
      expect(isAbsolute(text)).toBe(false);
      expect(text.split('\\').join('/')).toBe(`../../.agents/skills/${SKILLS[i]}`);
      // Line endings are normalized because git's own `core.autocrlf` is on by
      // default on Windows and rewrites this file on checkout (measured on a
      // windows-latest runner, DOR-1855). What the assertion is about is that
      // the skill is READABLE THROUGH THE LINK, not how the checkout spells a
      // newline.
      expect(readFileSync(join(checkout, link, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n')).toBe(
        `# ${SKILLS[i]}\n`
      );
    }

    const before = snapshotTree(checkout);
    expect(checkPlan(checkout, project(checkout)).clean).toBe(true);

    const { conflicts, swept } = applyPlan(checkout, project(checkout), { sweepOrphans: true });
    expect(conflicts).toEqual([]);
    expect(swept).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(checkout))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('keeps every planned path forward-slashed, so a Windows plan reads the same', () => {
    stageProjectedRepo();
    const plan = project(origin);
    const paths = plan.actions.flatMap((a) => [a.source, a.target].filter((p) => p !== undefined));
    // Windows `path.join`/`path.relative` produce backslashes; the plan's own
    // strings are repo-relative POSIX paths on every platform, and the Windows
    // leg compares them against these same literals.
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((p) => p.includes('\\'))).toEqual([]);
  });
});
