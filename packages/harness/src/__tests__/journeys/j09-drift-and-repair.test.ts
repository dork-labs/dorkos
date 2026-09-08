/**
 * J-09 — drift and repair.
 *
 * A projected repo is left alone for a week and comes back changed by hand: a
 * skill link deleted, a skill renamed, a skill removed outright, the Claude
 * pointer replaced by a link to a file that no longer exists, and the generated
 * Codex hooks file either edited or replaced by a dead link. Then somebody runs
 * `dorkos harness sync`.
 *
 * The journey asserts the two halves separately, because they mean different
 * things to the person:
 *
 * - **`--check` answers, and the answer is complete.** Every stale projection is
 *   in `drifted`, every link whose skill is gone is in `orphans`, a file DorkOS
 *   does not own is in `blocked`, and nothing throws. Before DOR-1843 the two
 *   orphans read as clean and the dead link crashed `checkPlan` with ENOENT.
 * - **`--fix` repairs exactly that and nothing else**, measured as an exact
 *   before/after tree diff.
 *
 * One thing the fix deliberately does NOT repair: a hand-edited `.codex/hooks.json`.
 * Its sidecar no longer matches its bytes, so those bytes are the person's
 * (DOR-1842) — it stays `blocked`, the tree stays unclean, and re-running changes
 * nothing until they move or delete the file. Variant 2 is the recoverable
 * sibling: a DEAD LINK at the same path is nothing to protect, so it is drift and
 * `--fix` replaces it, ending fully clean.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, snapshotTree, writeFileAt, writeJsonAt } from './stage.js';

/** The generated Codex hooks file — the one target this repo's hooks reach. */
const CODEX_HOOKS = '.codex/hooks.json';

/** Its ownership sidecar. */
const CODEX_SIDECAR = `${CODEX_HOOKS}.dorkos-generated`;

/** The scaffolded Claude instruction pointer. */
const CLAUDE_POINTER = '.claude/CLAUDE.md';

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const d of [repo, dorkHome]) if (d) rmSync(d, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/**
 * Stage a two-harness repo with three authored skills and one authored hook,
 * then project it once so the baseline is green.
 */
function stageProjectedRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-j09-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-j09-home-'));

  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
  writeJsonAt(join(repo, '.claude', 'settings.json'), {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] },
  });
  for (const name of ['x', 'old', 'gone']) {
    writeFileAt(join(repo, '.agents', 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }

  const { conflicts } = applyPlan(repo, plan(), { sweepOrphans: true });
  expect(conflicts).toEqual([]);
  expect(checkPlan(repo, plan()).clean).toBe(true);
  for (const name of ['x', 'old', 'gone']) {
    expect(lstatSync(join(repo, '.claude', 'skills', name)).isSymbolicLink()).toBe(true);
  }
  expect(existsSync(join(repo, CODEX_HOOKS))).toBe(true);
  expect(existsSync(join(repo, CODEX_SIDECAR))).toBe(true);
}

/** The plan for the repo as it stands right now. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/**
 * The week of hand edits, minus whatever happens to `.codex/hooks.json` — that
 * is the variant, and each test stages its own.
 */
function driftTheRepo(): void {
  rmSync(join(repo, '.claude', 'skills', 'x'), { force: true }); // link deleted
  renameSync(join(repo, '.agents', 'skills', 'old'), join(repo, '.agents', 'skills', 'new'));
  rmSync(join(repo, '.agents', 'skills', 'gone'), { recursive: true, force: true });
  // The pointer replaced by a link to a file that is not there.
  rmSync(join(repo, CLAUDE_POINTER), { force: true });
  symlinkSync('../docs/CLAUDE.md', join(repo, CLAUDE_POINTER));
}

/** Target paths of a list of actions, sorted, for an exact comparison. */
function targets(actions: { target?: string }[]): string[] {
  return actions.map((a) => a.target ?? '(none)').sort();
}

describe('J-09 — drift and repair', () => {
  it('J-09, AP-01, SK-10: names every stale projection and every dead link, and repairs exactly those', () => {
    stageProjectedRepo();

    // The person edits the generated hooks file. Its sidecar stops matching, so
    // those bytes become theirs.
    const edited = JSON.stringify(
      { ...JSON.parse(readFileSync(join(repo, CODEX_HOOKS), 'utf8')), _mine: true },
      null,
      2
    );
    writeFileSync(join(repo, CODEX_HOOKS), edited);
    driftTheRepo();

    const before = snapshotTree(repo);
    const drift = checkPlan(repo, plan());

    expect(targets(drift.drifted)).toEqual([
      CLAUDE_POINTER,
      '.claude/skills/new',
      '.claude/skills/x',
    ]);
    expect([...drift.orphans].sort()).toEqual(['.claude/skills/gone', '.claude/skills/old']);
    expect(targets(drift.blocked)).toEqual([CODEX_HOOKS]);
    expect(drift.clean).toBe(false);

    const { swept, conflicts } = applyPlan(repo, plan(), { sweepOrphans: true });

    expect([...swept].sort()).toEqual(['.claude/skills/gone', '.claude/skills/old']);
    expect(targets(conflicts)).toEqual([CODEX_HOOKS]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: ['.claude/skills/new', '.claude/skills/x'],
      changed: [CLAUDE_POINTER],
      removed: ['.claude/skills/gone', '.claude/skills/old'],
    });
    // The person's bytes are still exactly their bytes.
    expect(readFileSync(join(repo, CODEX_HOOKS), 'utf8')).toBe(edited);

    // Everything a re-run can fix is fixed. What is left is their file, and it
    // stays theirs until they move it — which is the only way back to clean.
    const after = checkPlan(repo, plan());
    expect(after.drifted).toEqual([]);
    expect(after.orphans).toEqual([]);
    expect(targets(after.blocked)).toEqual([CODEX_HOOKS]);
    expect(after.clean).toBe(false);

    rmSync(join(repo, CODEX_HOOKS), { force: true });
    rmSync(join(repo, CODEX_SIDECAR), { force: true });
    applyPlan(repo, plan(), { sweepOrphans: true });
    expect(checkPlan(repo, plan()).clean).toBe(true);
  });

  it('J-09, AP-05: treats a dead link at the generated hooks file as drift and ends fully clean', () => {
    stageProjectedRepo();

    // Same week, but the hooks file was moved away and a broken link left behind.
    rmSync(join(repo, CODEX_HOOKS), { force: true });
    symlinkSync('hooks.json.bak', join(repo, CODEX_HOOKS));
    driftTheRepo();

    const before = snapshotTree(repo);
    const drift = checkPlan(repo, plan()); // used to throw ENOENT right here

    expect(targets(drift.drifted)).toEqual([
      CLAUDE_POINTER,
      '.claude/skills/new',
      '.claude/skills/x',
      CODEX_HOOKS,
    ]);
    expect([...drift.orphans].sort()).toEqual(['.claude/skills/gone', '.claude/skills/old']);
    expect(drift.blocked).toEqual([]); // nothing to read means nothing to own
    expect(drift.clean).toBe(false);

    const { swept, conflicts } = applyPlan(repo, plan(), { sweepOrphans: true });

    expect([...swept].sort()).toEqual(['.claude/skills/gone', '.claude/skills/old']);
    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: ['.claude/skills/new', '.claude/skills/x'],
      // Not the sidecar: the regenerated bytes are the same bytes, so its
      // digest is unchanged even though it was rewritten.
      changed: [CLAUDE_POINTER, CODEX_HOOKS],
      removed: ['.claude/skills/gone', '.claude/skills/old'],
    });
    // The file landed at the path DorkOS was asked to write, not through the link.
    expect(lstatSync(join(repo, CODEX_HOOKS)).isFile()).toBe(true);
    expect(existsSync(join(repo, '.codex', 'hooks.json.bak'))).toBe(false);
    expect(checkPlan(repo, plan()).clean).toBe(true);
  });
});
