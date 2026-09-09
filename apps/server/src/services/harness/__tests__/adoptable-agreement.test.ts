/**
 * SK-16 — the two readers of "what could be adopted" answer with the same set.
 *
 * There are deliberately two. The status model's reader
 * ({@link adoptableSkillSources}) works off an inventory the server already has
 * and decides what a Skills page row says; the engine's
 * ({@link readAdoptCandidates}) reads each candidate's `SKILL.md` as well,
 * because `planAdopt` is pure and has to be handed every fact it will decide on.
 * Neither can import the other — `packages/harness` cannot import `apps/server`,
 * and the edge runs that way on purpose — so this file is the only place that
 * can put them side by side, and a duplication nobody can compare is a
 * duplication nobody is checking.
 *
 * **The two exclusions are the definition rather than an optimisation**, so the
 * tree carries one of each beside real candidates: a skill that also lives in
 * the canonical layer is a blocker whose fix is a deletion, and a skill named in
 * `manifest.claudeOnlySkills` is a person saying the placement is deliberate.
 * A property that ranged only over the happy set would pass without ever
 * exercising the thing that makes either reader interesting.
 *
 * Seeded defect: drop the `alsoCanonical` exclusion from either side and the
 * equality reds.
 *
 * @module services/harness/__tests__/adoptable-agreement
 */
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inventorySourceTree,
  loadManifest,
  planAdopt,
  readAdoptCandidates,
  ROOM_SEEDED_SKILL_NAMES,
} from '@dorkos/harness';
import { SEEDED_PACK_EXCLUDES } from '../../rooms/repo/room-worktree-manager.js';
import { adoptableSkillSources } from '../status.js';

/** Temp directories to remove when the case ends. */
const staged: string[] = [];

afterEach(() => {
  for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Write a file, creating the directories above it. */
function writeAt(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Write one skill directory's `SKILL.md`. */
function writeSkill(repo: string, dir: string, name: string, extra = ''): void {
  writeAt(
    join(repo, dir, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: The ${name} skill\n${extra}---\n\n# ${name}\n`
  );
}

/**
 * A repository holding three real candidates across three roots, one skill that
 * is also canonical, one that is declared, and one that only ever lived in the
 * canonical layer.
 *
 * @returns the repository root.
 */
function stageTree(): string {
  const repo = mkdtempSync(join(tmpdir(), 'adopt-agreement-'));
  staged.push(repo);

  writeSkill(repo, '.claude/skills', 'deploy-checklist');
  writeSkill(repo, '.claude/skills', 'forked-thing', 'context: fork\n');
  writeSkill(repo, '.opencode/skills', 'ship-it');

  // Two more of DOR-1902's five harness-native roots, because the property is
  // about "every root that belongs to one tool" and a fixture that only ever
  // used one of them would agree with a reader that had hard-coded it.
  writeSkill(repo, '.cursor/skills', 'cursor-thing');
  writeSkill(repo, '.gemini/skills', 'gemini-thing');

  // A skill kept outside the repo and linked in. Both readers must OFFER it —
  // it is adoptable, and R5 is what refuses it later, with its own sentence.
  // A reader that skipped links would disagree with one that did not, silently.
  const elsewhere = mkdtempSync(join(tmpdir(), 'adopt-agreement-elsewhere-'));
  staged.push(elsewhere);
  writeSkill(elsewhere, '.', 'linked-in');
  mkdirSync(join(repo, '.claude/skills'), { recursive: true });
  symlinkSync(join(elsewhere, 'linked-in'), join(repo, '.claude/skills/linked-in'), 'dir');

  // The two exclusions, each with a real copy in a harness-owned root.
  writeSkill(repo, '.claude/skills', 'twin');
  writeSkill(repo, '.agents/skills', 'twin');
  writeSkill(repo, '.claude/skills', 'declared-on-purpose');

  // Canonical-only: adoptable by neither reader, because it is already shared.
  writeSkill(repo, '.agents/skills', 'already-shared');

  writeAt(
    join(repo, '.agents/harness.manifest.json'),
    `${JSON.stringify(
      {
        version: 1,
        harnesses: ['claude-code', 'opencode'],
        claudeOnlySkills: [
          {
            name: 'declared-on-purpose',
            path: '.claude/skills/declared-on-purpose',
            reason: 'Kept in Claude Code on purpose.',
          },
        ],
      },
      null,
      2
    )}\n`
  );
  return repo;
}

describe('the adopt reader and the status model', () => {
  it('SK-16: agree on which skills could be adopted, exclusions included', () => {
    const repo = stageTree();
    const inventory = inventorySourceTree(repo);
    const manifest = loadManifest(repo);
    const claudeOnlyNames = new Set(manifest.claudeOnlySkills.map((entry) => entry.name));

    const fromStatus = [...adoptableSkillSources(inventory, claudeOnlyNames)].sort();
    const fromEngine = readAdoptCandidates(repo, inventory, manifest)
      .candidates.map((entry) => entry.source)
      .sort();

    // How many, before anything about them: a property that silently ranged
    // over an empty set would pass for the wrong reason.
    expect({ status: fromStatus.length, engine: fromEngine.length }).toEqual({
      status: 6,
      engine: 6,
    });
    expect(fromEngine).toEqual(fromStatus);
    expect(fromEngine).toEqual([
      '.claude/skills/deploy-checklist',
      '.claude/skills/forked-thing',
      '.claude/skills/linked-in',
      '.cursor/skills/cursor-thing',
      '.gemini/skills/gemini-thing',
      '.opencode/skills/ship-it',
    ]);
  });

  it('SK-16: keeps both exclusions out, and says which one kept each', () => {
    const repo = stageTree();
    const inventory = inventorySourceTree(repo);
    const manifest = loadManifest(repo);
    const { candidates, exclusions } = readAdoptCandidates(repo, inventory, manifest);

    expect(exclusions.length).toBe(2);
    expect([...exclusions].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      {
        name: 'declared-on-purpose',
        source: '.claude/skills/declared-on-purpose',
        root: '.claude/skills',
        why: 'declared',
      },
      {
        name: 'twin',
        source: '.claude/skills/twin',
        root: '.claude/skills',
        why: 'also-canonical',
      },
    ]);
    expect(candidates.map((entry) => entry.name)).not.toContain('twin');
  });

  it('SK-16: reads each candidate’s frontmatter as written, not as the schema keeps it', () => {
    const repo = stageTree();
    const inventory = inventorySourceTree(repo);
    const { candidates } = readAdoptCandidates(repo, inventory, loadManifest(repo));

    expect(candidates.length).toBe(6);
    const forked = candidates.find((entry) => entry.name === 'forked-thing');
    expect(forked?.frontmatterKeys).toEqual(['name', 'description', 'context']);
    // The linked-in skill is offered, and carries the fact R5 refuses it on.
    expect(candidates.find((entry) => entry.name === 'linked-in')?.isSymlink).toBe(true);
    expect({
      unreadable: forked?.unreadable,
      target: forked?.targetState,
      blocked: forked?.pathBlockedReason,
    }).toEqual({ unreadable: false, target: 'absent', blocked: undefined });
  });
  it('SK-16: offers a skill folder DorkOS cannot open, and says why it will not move', () => {
    // The shape DOR-1943 measured and DOR-1949 fixed. The inventory used to drop
    // a mode-000 skill folder with no entry and no record, so the skill reached
    // no list at all and `dorkos harness adopt locked` answered R1's "there is
    // no skill called `locked`" — false about the person's own repository.
    //
    // Seeded defect: take the `lockedSkills` term out of either reader. One side
    // then offers the folder and the other does not, and the equality above reds.
    const repo = stageTree();
    const locked = join(repo, '.claude/skills/locked');
    writeSkill(repo, '.claude/skills', 'locked');
    chmodSync(locked, 0o000);
    try {
      const inventory = inventorySourceTree(repo);
      const manifest = loadManifest(repo);
      const { candidates } = readAdoptCandidates(repo, inventory, manifest);
      const fromStatus = adoptableSkillSources(
        inventory,
        new Set(manifest.claudeOnlySkills.map((entry) => entry.name))
      );

      expect({
        skills: inventory.skills.filter((entry) => entry.name === 'locked').length,
        unreadable: inventory.unreadable.filter((entry) => entry.source.includes('locked')).length,
        candidates: candidates.filter((entry) => entry.name === 'locked').length,
        offered: fromStatus.has('.claude/skills/locked'),
      }).toEqual({ skills: 0, unreadable: 1, candidates: 1, offered: true });

      // R2's own sentence, naming the folder that is in the way rather than
      // denying the skill exists.
      const plan = planAdopt({
        ...readAdoptCandidates(repo, inventory, manifest),
        ownership: 'plain',
        request: { mode: 'explicit', name: 'locked' },
      });
      expect(plan.refusals.map((refusal) => refusal.rule)).toEqual(['hostile-path']);
      expect(plan.refusals[0]?.reason).toBe(
        'blocked by `.claude/skills/locked`, which is a folder DorkOS cannot read ' +
          '(permission denied). Fix the folder’s permissions, then re-run'
      );
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it('SK-16: reserves exactly the names a room worktree hides from git', () => {
    // R3 refuses exactly the names a room worktree hides from git, and the two
    // lists are derived in two packages that cannot see each other. Compared
    // through the PATHS the room manager really writes into `info/exclude`, so
    // a change to either derivation's shape reds this rather than passing on
    // both sides reading the same array.
    const reserved = [...ROOM_SEEDED_SKILL_NAMES].sort();
    const hidden = SEEDED_PACK_EXCLUDES.map((path) =>
      path.replace('/.agents/skills/', '').replace('/SKILL.md', '')
    ).sort();
    expect({ reserved: reserved.length, hidden: hidden.length }).toEqual({
      reserved: hidden.length,
      hidden: hidden.length,
    });
    expect(reserved.length).toBeGreaterThanOrEqual(7);
    expect(reserved).toEqual(hidden);
  });
});
