/**
 * J-14 — a harness the person adds later.
 *
 * A repo has been syncing to Claude Code and Codex for a month. Somebody on the
 * team starts using Cursor, so a `.cursor/` appears in the tree. Nothing else
 * changes.
 *
 * Before this journey existed, that was the end of the story: detection ran once,
 * when the manifest was scaffolded, and `scaffoldManifest` is write-if-absent —
 * so Cursor was never enabled, never projected to, and never mentioned. The
 * repo's own `dorkos harness sync --check` said "No drift" (contract TR-11,
 * reproduced against the built CLI 2026-09-08).
 *
 * The journey asserts the three beats a person lives through:
 *
 * 1. **Noticed.** The plan carries Cursor with the path that gave it away, and
 *    the tree is still clean — a harness somebody runs elsewhere is not drift,
 *    and a notice that changed an exit code would be a failing command nobody
 *    can clear.
 * 2. **Enabled, minimally.** `--enable cursor` adds one array element and moves
 *    no other byte, and the SAME run projects the Cursor targets.
 * 3. **Quiet again.** A second check is clean and says nothing about Cursor.
 *
 * Every write is measured as an exact before/after tree diff, so a stray file is
 * a red rather than an unnoticed side effect.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { enableHarnessInManifest } from '../../scaffold/enable-harness.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, snapshotTree, writeFileAt } from './stage.js';
import { stageRepo, type StagedRepo } from './stage-repo.js';

/** The manifest, exactly as a person would have hand-written it. */
const MANIFEST_BODY = `{
  "version": 1,
  "harnesses": [
    "claude-code",
    "codex"
  ],
  "claudeOnlySkills": []
}
`;

let staged: StagedRepo | undefined;
let repo = '';
let dorkHome = '';

afterEach(() => {
  staged?.cleanup();
  staged = undefined;
  repo = '';
  dorkHome = '';
});

/** The plan for the repo as it stands right now. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/** Stage a two-harness repo, project it once, and assert the baseline is clean. */
function stageSyncedRepo(): void {
  staged = stageRepo({
    manifest: { harnesses: ['claude-code', 'codex'], claudeOnlySkills: [] },
    agents: { agentsMd: true, skills: ['demo'] },
    claude: { settingsHooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } },
  });
  repo = staged.root;
  dorkHome = staged.dorkHome;

  // The manifest the DSL writes is the one this journey asserts the exact bytes
  // of after `--enable` inserts into it — an assertion about formatting, so it
  // has to read the formatting the fixture really staged.
  expect(readFileSync(join(repo, '.agents', 'harness.manifest.json'), 'utf8')).toBe(MANIFEST_BODY);

  expect(applyPlan(repo, plan(), { sweepOrphans: true }).conflicts).toEqual([]);
  expect(checkPlan(repo, plan()).clean).toBe(true);
}

/** The month-later change: somebody starts using Cursor in this repo. */
function addCursor(): void {
  writeFileAt(
    join(repo, '.cursor', 'rules', 'x.mdc'),
    '---\ndescription: house rules\n---\n\nBe careful.\n'
  );
}

describe('J-14 — a harness added after the manifest was written', () => {
  it('J-14, TR-11: notices Cursor without calling it drift', () => {
    stageSyncedRepo();
    expect(plan().notEnabled).toEqual([]);

    addCursor();

    const after = plan();
    expect(after.notEnabled).toEqual([{ harness: 'cursor', why: 'footprint', signal: '.cursor/' }]);
    // A notice, not a fault: nothing is missing, nothing is stale, and the exit
    // code a person sees is the same one they saw yesterday.
    expect(checkPlan(repo, after).clean).toBe(true);
  });

  it('J-14, TR-11: enables Cursor with one inserted element and projects it in the same run', () => {
    stageSyncedRepo();
    addCursor();
    const before = snapshotTree(repo);

    const enabled = enableHarnessInManifest(repo, 'cursor');

    expect(enabled).toEqual({
      outcome: 'enabled',
      harness: 'cursor',
      path: '.agents/harness.manifest.json',
      inserted: ',\n    "cursor"',
    });
    expect(readFileSync(join(repo, '.agents', 'harness.manifest.json'), 'utf8')).toBe(
      MANIFEST_BODY.replace('"codex"', '"codex",\n    "cursor"')
    );

    // The same run re-plans and applies, which is what makes `--enable` one
    // command rather than "edit this, then run it again".
    const { conflicts } = applyPlan(repo, plan(), { sweepOrphans: true });

    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: ['.cursor/hooks.json', '.cursor/hooks.json.dorkos-generated'],
      changed: ['.agents/harness.manifest.json'],
      removed: [],
    });
    // Cursor reads the canonical layer directly, so the skill and the
    // instructions are `native` — nothing is copied for them.
    const cursor = plan().actions.filter((a) => a.harness === 'cursor');
    expect(cursor.map((a) => `${a.kind} ${a.artifact}`).sort()).toEqual([
      'generate hook',
      'native instruction',
      'native skill',
    ]);
  });

  it('J-14, TR-11: says nothing about Cursor once it is enabled, and stays clean', () => {
    stageSyncedRepo();
    addCursor();
    enableHarnessInManifest(repo, 'cursor');
    applyPlan(repo, plan(), { sweepOrphans: true });

    const second = plan();

    expect(second.notEnabled).toEqual([]);
    expect(checkPlan(repo, second).clean).toBe(true);
    expect(existsSync(join(repo, '.cursor', 'hooks.json'))).toBe(true);
  });

  it('J-14, TR-11: leaves the manifest alone when the harness is already enabled', () => {
    stageSyncedRepo();
    const before = snapshotTree(repo);

    expect(enableHarnessInManifest(repo, 'codex').outcome).toBe('already-enabled');

    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });
});
