/**
 * Skill half of the source inventory — the two roots a person authors a skill
 * in, and neither of the roots DorkOS writes into.
 *
 * `.agents/skills` is the canonical layer the planner already scans, so this
 * reuses {@link scanSkillDirs} rather than re-deriving it, and only adds what an
 * inventory needs on top: whether the entry is reached through a symlink, and
 * which root it came from.
 *
 * `.claude/skills` is the other half, and it is why this module is not a
 * one-liner. A REAL directory there is a skill somebody wrote where only Claude
 * Code reads — sometimes on purpose (`manifest.claudeOnlySkills`), sometimes
 * because that is where the agent that made it puts things. A SYMLINK there is
 * DorkOS's own projection of a canonical skill. Only the first is a source, so
 * the walk is `followSymlinks: false`.
 *
 * Each root is probed with {@link readDirEntries} before the scanner walks it.
 * `scanSkillDirs` guards an ABSENT directory and nothing else, so a file sitting
 * where `.claude/skills` belongs throws `ENOTDIR` out of it — which is fine for
 * the planner, whose callers already handle that, and not fine for an inventory
 * whose whole promise is that a hostile tree produces a record instead of a
 * crash.
 *
 * @module inventory/skills
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '../scan/scanner.js';
import { CLAUDE_SKILLS_DIR } from '../plan/installed-projector.js';
import { readDirEntries } from './read.js';
import type { SkillInventoryEntry, SkillRoot, UnreadableSource } from './types.js';

/**
 * Inventory every authored skill in the two roots a person writes them in.
 *
 * A managed installed projection (`<pkg>__<name>` **and** a symlink) is excluded
 * from both roots, in the two different ways the two roots need it: the
 * `.agents/skills` walk uses the scanner's default authored view, and the
 * `.claude/skills` walk refuses symlinks outright, because every entry DorkOS
 * writes there is one.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one entry per authored skill directory, `.agents/skills` first, plus
 *   any root that could not be listed.
 */
export function inventorySkills(repoRoot: string): {
  skills: SkillInventoryEntry[];
  unreadable: UnreadableSource[];
} {
  const agents = collect(repoRoot, AGENTS_SKILLS_DIR, {});
  const claude = collect(repoRoot, CLAUDE_SKILLS_DIR, { followSymlinks: false });
  return {
    skills: [...agents.skills, ...claude.skills],
    unreadable: [...agents.unreadable, ...claude.unreadable],
  };
}

/**
 * Walk one skills root into inventory entries.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param root - the repo-relative skills root to walk.
 * @param options - the scanner options that decide what counts as a source here.
 * @returns the entries found under `root`, or the reason it could not be walked.
 */
function collect(
  repoRoot: string,
  root: SkillRoot,
  options: { followSymlinks?: boolean }
): { skills: SkillInventoryEntry[]; unreadable: UnreadableSource[] } {
  const absRoot = join(repoRoot, root);
  const probe = readDirEntries(absRoot, root, 'skill');
  if (probe.unreadable) return { skills: [], unreadable: [probe.unreadable] };

  return {
    skills: scanSkillDirs(absRoot, root, options).map((skill) => ({
      kind: 'skill' as const,
      name: skill.name,
      source: skill.sourceDir,
      provenance: 'authored' as const,
      isSymlink:
        lstatSync(join(repoRoot, skill.sourceDir), { throwIfNoEntry: false })?.isSymbolicLink() ===
        true,
      root,
    })),
    unreadable: [],
  };
}
