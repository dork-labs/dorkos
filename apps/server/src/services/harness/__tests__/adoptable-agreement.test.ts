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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inventorySourceTree, loadManifest, readAdoptCandidates } from '@dorkos/harness';
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
      status: 3,
      engine: 3,
    });
    expect(fromEngine).toEqual(fromStatus);
    expect(fromEngine).toEqual([
      '.claude/skills/deploy-checklist',
      '.claude/skills/forked-thing',
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

    expect(candidates.length).toBe(3);
    const forked = candidates.find((entry) => entry.name === 'forked-thing');
    expect(forked?.frontmatterKeys).toEqual(['name', 'description', 'context']);
    expect({
      unreadable: forked?.unreadable,
      target: forked?.targetState,
      blocked: forked?.pathBlockedReason,
    }).toEqual({ unreadable: false, target: 'absent', blocked: undefined });
  });
});
