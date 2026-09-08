/**
 * J-05 — an agent writes a new skill mid-session.
 *
 * Codex is working in a repo and writes `.agents/skills/deploy-checklist/` while
 * the person also has Claude Code open on the same tree. Five of the six
 * harnesses read the canonical directory natively, so the skill is theirs the
 * instant the file lands. Claude Code reads only `.claude/skills/`, and that one
 * link is the whole of what the engine has to do.
 *
 * This is the ENGINE half of the journey. The trigger half — what notices the
 * file and calls the engine within seconds, and the four hazards it has to avoid
 * — is `apps/server/src/services/harness/__tests__/skills-watcher.test.ts`,
 * because the watcher lives in the server. The two halves are cross-referenced
 * so neither can be read as the whole journey.
 *
 * Every beat is measured as an exact before/after tree diff, so a stray file is
 * a red rather than an unnoticed side effect. Three beats:
 *
 * 1. **Noticed.** The plan gains one `symlink` for Claude Code and five
 *    `native` skills, and applying it adds exactly one path.
 * 2. **Not swept.** Deleting the skill with `sweepOrphans: false` — the only way
 *    the watcher ever calls this engine — leaves the now-dead link where it is,
 *    and `checkPlan` reports it as an orphan for `--fix` to prune. That is the
 *    trade DOR-1850 makes: no sweep at file-event frequency.
 * 3. **Renamed.** A rename is an add and a delete, so the new link appears and
 *    the old one stays for the same reason.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { lstatSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import type { ProjectionPlan } from '../../plan/types.js';
import { diffSnapshots, snapshotTree, writeFileAt } from './stage.js';

/** The manifest, with every harness the engine knows about enabled. */
const MANIFEST_BODY = `{
  "version": 1,
  "harnesses": [
    "claude-code",
    "codex",
    "cursor",
    "gemini",
    "copilot",
    "opencode"
  ],
  "claudeOnlySkills": []
}
`;

/** A skill exactly as an agent writes one. */
function skillBody(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nDo the ${name} thing.\n`;
}

let repo = '';
let dorkHome = '';

afterEach(() => {
  for (const dir of [repo, dorkHome]) if (dir) rmSync(dir, { recursive: true, force: true });
  repo = '';
  dorkHome = '';
});

/** The plan for the repo as it stands right now. */
function plan(): ProjectionPlan {
  return project(repo, { dorkHome });
}

/**
 * Stage a repo that is already in sync, with one skill in it, and assert the
 * baseline is clean.
 *
 * The baseline projection sweeps; every projection AFTER it in this journey does
 * not, which is what the watcher does.
 */
function stageSyncedRepo(): void {
  repo = mkdtempSync(join(tmpdir(), 'harness-j05-repo-'));
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-j05-home-'));

  writeFileAt(join(repo, '.agents', 'harness.manifest.json'), MANIFEST_BODY);
  writeFileAt(join(repo, 'AGENTS.md'), '# Our project\n\nHouse rules.\n');
  writeFileAt(join(repo, '.agents', 'skills', 'existing', 'SKILL.md'), skillBody('existing'));

  expect(applyPlan(repo, plan(), { sweepOrphans: true }).conflicts).toEqual([]);
  expect(checkPlan(repo, plan()).clean).toBe(true);
}

/** What an agent does mid-session: one directory, one file. */
function agentWritesSkill(name: string): void {
  writeFileAt(join(repo, '.agents', 'skills', name, 'SKILL.md'), skillBody(name));
}

describe('J-05 — an agent writes a skill while the person has Claude Code open', () => {
  it('J-05, SRC-06: plans one link for Claude Code and native for the other five', () => {
    stageSyncedRepo();
    agentWritesSkill('deploy-checklist');

    const forSkill = plan()
      .actions.filter((a) => a.artifact === 'skill' && a.name === 'deploy-checklist')
      .map((a) => `${a.harness} ${a.kind}`)
      .sort();

    // The one fact the whole engine is built on: Claude Code is the only harness
    // that does not read `.agents/skills`, so it is the only one with work to do.
    expect(forSkill).toEqual([
      'claude-code symlink',
      'codex native',
      'copilot native',
      'cursor native',
      'gemini native',
      'opencode native',
    ]);
  });

  it('J-05: adds exactly one path — the link Claude Code reads', () => {
    stageSyncedRepo();
    const before = snapshotTree(repo);

    agentWritesSkill('deploy-checklist');
    // `sweepOrphans: false` is what the watcher passes, every time (DOR-1850).
    const { conflicts } = applyPlan(repo, plan(), { sweepOrphans: false });

    expect(conflicts).toEqual([]);
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: [
        '.agents/skills/deploy-checklist',
        '.agents/skills/deploy-checklist/SKILL.md',
        '.claude/skills/deploy-checklist',
      ],
      changed: [],
      removed: [],
    });
    expect(lstatSync(join(repo, '.claude', 'skills', 'deploy-checklist')).isSymbolicLink()).toBe(
      true
    );
    expect(checkPlan(repo, plan()).clean).toBe(true);
  });

  it('J-05, TR-06: leaves the dead link behind when the skill goes away, and reports it as an orphan', () => {
    stageSyncedRepo();
    agentWritesSkill('deploy-checklist');
    applyPlan(repo, plan(), { sweepOrphans: false });
    const before = snapshotTree(repo);

    rmSync(join(repo, '.agents', 'skills', 'deploy-checklist'), { recursive: true, force: true });
    applyPlan(repo, plan(), { sweepOrphans: false });

    // Nothing removed. A sweep at watcher frequency would run five sweeps over a
    // tree that may be mid-edit (HK-11), so the trigger never asks for one.
    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: [],
      changed: [],
      removed: ['.agents/skills/deploy-checklist', '.agents/skills/deploy-checklist/SKILL.md'],
    });

    // Not silently left, either: the link is named as an orphan, so `--fix` is
    // what prunes it and a person can see why it is still there.
    const drift = checkPlan(repo, plan());
    expect(drift.orphans).toEqual(['.claude/skills/deploy-checklist']);
    expect(drift.clean).toBe(false);

    // And a sync that IS allowed to sweep takes it.
    expect(applyPlan(repo, plan(), { sweepOrphans: true }).swept).toEqual([
      '.claude/skills/deploy-checklist',
    ]);
    expect(checkPlan(repo, plan()).clean).toBe(true);
  });

  it('J-05: links the new name on a rename, and leaves the old link for --fix', () => {
    stageSyncedRepo();
    agentWritesSkill('old-name');
    applyPlan(repo, plan(), { sweepOrphans: false });
    const before = snapshotTree(repo);

    renameSync(
      join(repo, '.agents', 'skills', 'old-name'),
      join(repo, '.agents', 'skills', 'new-name')
    );
    applyPlan(repo, plan(), { sweepOrphans: false });

    expect(diffSnapshots(before, snapshotTree(repo))).toEqual({
      added: [
        '.agents/skills/new-name',
        '.agents/skills/new-name/SKILL.md',
        '.claude/skills/new-name',
      ],
      changed: [],
      removed: ['.agents/skills/old-name', '.agents/skills/old-name/SKILL.md'],
    });
    expect(checkPlan(repo, plan()).orphans).toEqual(['.claude/skills/old-name']);
  });
});
