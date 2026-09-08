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
 * one-liner. A REAL directory there is a skill somebody wrote where Claude Code
 * reads — sometimes on purpose (`manifest.claudeOnlySkills`), sometimes because
 * that is where the agent that made it puts things.
 *
 * A SYMLINK there is decided by **where it points**, not by being a link. Into
 * `.agents/skills` or `.dork/plugins` it is DorkOS's own projection and is not a
 * source. Anywhere else it is a person's skill kept outside the canonical layer
 * and linked in — the shape `planClaudeOnlySkills` already warns about ("a link
 * to a skill kept elsewhere") and `arb-repo.ts` already stages. Treating every
 * link as ours gave a real skill no line at all, which is the silence this
 * module exists to end. A dangling link is neither: `scanSkillDirs` refuses one,
 * because a link to nothing holds no `SKILL.md`.
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
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { scanSkillDirs, AGENTS_SKILLS_DIR } from '../scan/scanner.js';
import { CLAUDE_SKILLS_DIR } from '../plan/installed-projector.js';
import { readDirEntries } from './read.js';
import type { SkillInventoryEntry, SkillRoot, UnreadableSource } from './types.js';

/**
 * The two roots everything DorkOS projects into `.claude/skills` points back at:
 * the canonical skill layer and the installed-plugin store. A link resolving
 * under either is the engine's own output; a link resolving anywhere else is a
 * person's.
 */
const MANAGED_LINK_ROOTS = [AGENTS_SKILLS_DIR, '.dork/plugins'] as const;

/** Whether `absPath` is inside `absRoot` (or is it). */
function isInside(absPath: string, absRoot: string): boolean {
  return absPath === absRoot || absPath.startsWith(absRoot + sep);
}

/**
 * Whether a `.claude/skills` entry is a projection DorkOS made, decided by where
 * it resolves rather than by whether it is a link.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param absEntry - absolute path of the entry under `.claude/skills`.
 * @returns `true` when the entry resolves inside a root the engine projects from.
 */
function isManagedProjection(repoRoot: string, absEntry: string): boolean {
  let real: string;
  try {
    real = realpathSync(absEntry);
  } catch {
    return false;
  }
  // Both sides resolved, because `repoRoot` itself is routinely a link — every
  // test tree is a `mkdtemp` under macOS's `/var -> /private/var`, so comparing
  // a resolved target against an unresolved root matches nothing and every
  // projection reads as a person's skill.
  const realRoot = realpathOr(repoRoot);
  return MANAGED_LINK_ROOTS.some((root) => isInside(real, resolve(realRoot, root)));
}

/** A path's real location, or the path itself when it does not resolve. */
function realpathOr(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return absPath;
  }
}

/**
 * Inventory every authored skill in the two roots a person writes them in.
 *
 * The engine's own output is excluded from both roots, in the two different ways
 * the two roots need it: the `.agents/skills` walk uses the scanner's default
 * authored view (`<pkg>__<name>` **and** a symlink), and the `.claude/skills`
 * walk drops the entries that resolve back into `.agents/skills` or
 * `.dork/plugins`.
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
  const claude = collect(repoRoot, CLAUDE_SKILLS_DIR, {});
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

  const skills: SkillInventoryEntry[] = [];
  for (const skill of scanSkillDirs(absRoot, root, options)) {
    const absEntry = join(repoRoot, skill.sourceDir);
    const isSymlink = lstatSync(absEntry, { throwIfNoEntry: false })?.isSymbolicLink() === true;
    if (root === CLAUDE_SKILLS_DIR && isSymlink && isManagedProjection(repoRoot, absEntry))
      continue;
    skills.push({
      kind: 'skill',
      name: skill.name,
      source: skill.sourceDir,
      provenance: 'authored',
      isSymlink,
      root,
    });
  }
  return { skills, unreadable: [] };
}
