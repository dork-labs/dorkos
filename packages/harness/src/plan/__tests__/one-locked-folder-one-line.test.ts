/**
 * DOR-1949 on the merged tree — one locked skill folder, one sentence.
 *
 * Two features arrived at the same folder from opposite ends. DOR-1935 taught
 * the PLAN to say a single skill folder nobody can look inside still counts as
 * a skill you have and that its links were left alone; DOR-1949 taught the
 * INVENTORY to record the same folder rather than dropping it in silence. Both
 * are right, and on the merged tree a mode-000 `.agents/skills/<x>` drew both,
 * one after the other — two surfaces describing one fact, which is how a person
 * stops reading either.
 *
 * `buildPlan`'s dedupe held only ROOTS, which was the whole population when it
 * was written: a folder one level down had no line of its own until DOR-1935
 * gave it one.
 *
 * **Which sentence wins is not arbitrary.** The plan's says what DorkOS could
 * not read AND what it did about it; the inventory's says only the first half.
 * The larger one stays.
 *
 * The second case is the reason DOR-1949 exists at all, and it is not a
 * duplicate of anything: `.claude/skills/<x>` is walked by the inventory and by
 * nothing else, so without that record the folder reaches no list — which is
 * exactly the silence the ticket was filed for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManifest, project } from '../../engine.js';
import { inventorySourceTree } from '../../inventory/index.js';
import { planAdopt, readAdoptCandidates } from '../../adopt/index.js';
import { writeFileAt, writeJsonAt } from '../../__tests__/journeys/stage.js';

/** Whether this machine can stage a folder nobody may read. */
const CAN_MAKE_UNREADABLE = process.platform !== 'win32' && process.getuid?.() !== 0;

const staged: string[] = [];
const relaxed: string[] = [];

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
 * A repository with one locked skill folder in each authored root.
 *
 * @returns the repository root and its dork home.
 */
function stageLockedSkills(): { repo: string; dorkHome: string } {
  const repo = mkdtempSync(join(tmpdir(), 'harness-onelocked-repo-'));
  const dorkHome = mkdtempSync(join(tmpdir(), 'harness-onelocked-home-'));
  staged.push(repo, dorkHome);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code'],
  });
  for (const [root, name] of [
    ['.agents/skills', 'canonical'],
    ['.claude/skills', 'claude-only'],
  ] as const) {
    const dir = join(repo, ...root.split('/'), name);
    writeFileAt(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n`
    );
    chmodSync(dir, 0o000);
    relaxed.push(dir);
  }
  return { repo, dorkHome };
}

describe('VC-02 — a folder nobody can look inside gets one line', () => {
  it.skipIf(!CAN_MAKE_UNREADABLE)('says it once about the canonical layer, not twice', () => {
    // Seeded defect: build the filter set from `unreadableSkillRoots` alone.
    // The folder then draws the plan's sentence AND the inventory's, in that
    // order, about one directory.
    const { repo, dorkHome } = stageLockedSkills();

    const about = project(repo, { dorkHome }).warnings.filter(
      (warning) => warning.source === '.agents/skills/canonical'
    );

    expect(about.length).toBe(1);
    // And it is the larger of the two: what could not be read, AND what DorkOS
    // did about it.
    expect(about[0]?.reason).toContain('every link to it was left exactly as it is');
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)('still says it once about a Claude-only folder', () => {
    // The silence DOR-1949 was filed for. Nothing but the inventory walks
    // `.claude/skills`, so this record is the only line there has ever been —
    // a dedupe that dropped it would put the folder back in the dark.
    const { repo, dorkHome } = stageLockedSkills();

    const about = project(repo, { dorkHome }).warnings.filter(
      (warning) => warning.source === '.claude/skills/claude-only'
    );

    expect(about.length).toBe(1);
    expect(about[0]?.reason).toContain('could not be opened');
  });

  it.skipIf(!CAN_MAKE_UNREADABLE)('and adopt still refuses it by name', () => {
    // The dedupe is about what is PRINTED, and `adopt/read.ts` reads
    // `inventory.unreadable` directly rather than the plan's warnings — so R2
    // still refuses the folder with the sentence naming it, which is the half of
    // DOR-1949 a person acts on.
    const { repo } = stageLockedSkills();
    const inventory = inventorySourceTree(repo);
    const manifest = loadManifest(repo);

    const plan = planAdopt({
      ...readAdoptCandidates(repo, inventory, manifest),
      ownership: 'plain',
      request: { mode: 'explicit', name: 'claude-only' },
    });

    expect(plan.refusals.map((refusal) => refusal.rule)).toEqual(['hostile-path']);
    expect(plan.refusals[0]?.reason).toContain('`.claude/skills/claude-only`');
  });
});
