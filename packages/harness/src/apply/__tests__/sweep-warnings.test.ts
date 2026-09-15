/**
 * DOR-1939 — a folder only a sweep walks, and what a person is told when it
 * cannot be looked in.
 *
 * `.opencode/commands` is the sharpest case, because nothing else in the engine
 * goes near it: the inventory does not walk it, no plan action targets it in a
 * repository that does not run OpenCode, and the only thing that ever opens it
 * is `findOpencodeCommandOrphans` — through `listDirEntries`, which answers `[]`
 * for a folder nobody may read exactly as it does for an empty one. So a
 * mode-000 folder there produced `clean: true`, an empty `blocked`, an empty
 * `leftAlone` and not one word anywhere: a sync that could not look, reported as
 * a sync with nothing to do.
 *
 * Nothing is broken by that — a sweep that cannot look removes nothing, which is
 * the safe direction — and that is exactly why it is a warning rather than a
 * fault. `clean` stays true; the sentence names the folder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../apply.js';
import { unlistableSweptDirs } from '../sweep-warnings.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

/** Whether this machine can stage a folder nobody may read. */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

/** Every folder locked in a case, restored before the tree is removed. */
const locked: string[] = [];
const staged: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // already gone
    }
  }
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A repository that is otherwise perfectly in sync, with one folder a sweep
 * would walk and nobody may read.
 *
 * @param folder - the repo-relative folder to lock.
 * @returns the repository root and its dork home.
 */
function stageBlindSweep(folder: string): { repo: string; dorkHome: string } {
  const repo = mkdtempSync(join(tmpdir(), 'harness-blind-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-blind-home-'));
  staged.push(repo, dorkHome);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# agents\n');
  applyPlan(repo, project(repo, { dorkHome }));
  const abs = join(repo, folder);
  mkdirSync(abs, { recursive: true });
  chmodSync(abs, 0o000);
  locked.push(abs);
  return { repo, dorkHome };
}

describe('AP-07, VC-02 — a folder a sweep could not look inside', () => {
  it.skipIf(!CAN_MAKE_UNREADABLE)('names it, and still calls the tree clean', () => {
    // Seeded defect: return `[]` from `sweepScanWarnings`. `--check` then says
    // exactly what it said before DOR-1939 — nothing at all — about a folder a
    // sync silently declined to walk.
    const { repo, dorkHome } = stageBlindSweep('.opencode/commands');

    const drift = checkPlan(repo, project(repo, { dorkHome }));

    expect(drift.warnings).toEqual([
      'DorkOS could not look inside `.opencode/commands`, so it does not know whether anything a ' +
        'sync would remove is in there. Nothing was taken out of it. If it should be a folder ' +
        'DorkOS can read, fix it and re-run.',
    ]);
    // Nothing needs writing and nothing needs removing, so the tree IS clean —
    // a warning is not a fault, and turning one into an exit code would make
    // `--check` red on a repository with nothing wrong with it.
    expect({
      clean: drift.clean,
      drifted: drift.drifted.length,
      blocked: drift.blocked.length,
      orphans: drift.orphans,
    }).toEqual({ clean: true, drifted: 0, blocked: 0, orphans: [] });
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)('says the same thing when the sync really runs', () => {
    const { repo, dorkHome } = stageBlindSweep('.opencode/commands');
    const plan = project(repo, { dorkHome });

    expect(applyPlan(repo, plan, { sweepOrphans: true }).warnings).toEqual(
      checkPlan(repo, plan).warnings
    );
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)('reaches a wrapper directory one level down', () => {
    // `.claude/commands/<pkg>` is walked by the Claude wrapper sweep, which is
    // the one sweep that enumerates by wildcard AND deletes a directory it finds
    // empty — so a folder it cannot list is the one it most needs to say so
    // about. The inventory reads that folder too, so the rendered sentence is
    // the plan's; what this pins is that the SWEEP walks it.
    const { repo, dorkHome } = stageBlindSweep('.claude/commands/acme');

    expect(unlistableSweptDirs(repo)).toEqual(['.claude/commands/acme']);
    expect(checkPlan(repo, project(repo, { dorkHome })).warnings).toEqual([]);
  });

  it('says nothing about a folder that is simply not there', () => {
    // The silence that must survive: an absent `.opencode/commands` is the
    // ordinary case in every repository that does not run OpenCode, and a
    // warning about each of the four would be a wall of notices about nothing.
    const repo = mkdtempSync(join(tmpdir(), 'harness-blind-absent-'));
    const dorkHome = mkdtempSync(join(tmpdir(), 'harness-blind-absent-home-'));
    staged.push(repo, dorkHome);
    writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
      version: 1,
      harnesses: ['claude-code'],
    });

    expect(checkPlan(repo, project(repo, { dorkHome })).warnings).toEqual([]);
  });
});

describe('AP-07 — every folder the sweeps walk is pinned', () => {
  // F6: two of the four {@link SWEPT_DIRS} entries had no case of their own, so
  // deleting either from the list redded nothing. Asked of the complete list
  // rather than of the rendered sentence, because the rendered one drops a
  // folder the plan already names — and the plan names three of these four.
  for (const folder of ['.claude/skills', '.agents/skills', '.opencode/commands'] as const) {
    it.skipIf(!CAN_MAKE_UNREADABLE)(`walks ${folder}`, () => {
      const { repo } = stageBlindSweep(folder);

      expect(unlistableSweptDirs(repo)).toEqual([folder]);
    });
  }

  it.skipIf(!CAN_MAKE_UNREADABLE)('says one sentence about one folder, not two', () => {
    // A mode-000 `.claude/skills` is read by the INVENTORY as well as walked by
    // two sweeps, so the plan already carries a sentence naming it. A second one
    // from this module put the same folder on screen twice, in two voices. The
    // plan's own sentence wins: it is drawn first, it names the folder already,
    // and it answers what could not be READ rather than what was therefore not
    // removed.
    const { repo, dorkHome } = stageBlindSweep('.claude/skills');
    const plan = project(repo, { dorkHome });

    // The folder IS one the sweeps walk — the fact above is unchanged …
    expect(unlistableSweptDirs(repo)).toEqual(['.claude/skills']);
    // … and a person is told about it exactly once.
    const named = [
      ...plan.warnings.filter((w) => w.reason.includes('.claude/skills')),
      ...checkPlan(repo, plan).warnings.filter((w) => w.includes('.claude/skills')),
    ];
    expect(named.length).toBe(1);
    expect(checkPlan(repo, plan).warnings).toEqual([]);
  });
});
