/**
 * Skill scanner — derives the authored skill set from `.agents/skills/*`.
 *
 * The manifest deliberately does NOT store the per-skill list (it is derivable);
 * this scanner reconstructs it from disk so the projector always operates on the
 * current skill set, not a stale snapshot.
 *
 * @module scan/scanner
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** A single authored skill discovered under `.agents/skills`. */
export interface SkillEntry {
  /** The skill's directory name — its stable identifier. */
  name: string;
  /** Repo-relative source directory, e.g. `.agents/skills/<name>`. */
  sourceDir: string;
}

/**
 * Enumerate authored skills under `<repoRoot>/.agents/skills`.
 *
 * A directory counts as a skill only when it directly contains a `SKILL.md`
 * file. Stray files and skill-less directories are ignored. Results are sorted
 * by name so the projection plan is deterministic.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one {@link SkillEntry} per immediate subdirectory containing a `SKILL.md`.
 */
export function scanSkills(repoRoot: string): SkillEntry[] {
  const skillsRoot = join(repoRoot, '.agents', 'skills');
  if (!existsSync(skillsRoot)) return [];

  const skills: SkillEntry[] = [];
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!existsSync(join(skillsRoot, entry.name, 'SKILL.md'))) continue;
    skills.push({ name: entry.name, sourceDir: `.agents/skills/${entry.name}` });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
