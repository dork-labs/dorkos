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
 * The infix that marks a managed installed-plugin skill projection
 * (`<pkg>__<skill>`). Authored skills never use it, so it cleanly distinguishes
 * an engine-managed installed projection from a hand-authored skill.
 */
export const INSTALLED_PROJECTION_MARKER = '__';

/**
 * Enumerate skill directories directly under `absRoot`, each returned as a
 * {@link SkillEntry} whose `sourceDir` is `<relPrefix>/<name>`.
 *
 * A directory counts as a skill only when it directly contains a `SKILL.md`
 * file. Stray files and skill-less directories are ignored, as are directories
 * whose name carries the {@link INSTALLED_PROJECTION_MARKER} — those are managed
 * installed projections, never authored sources, so the authored scan must not
 * re-derive them. Results are sorted by name so the projection plan is
 * deterministic.
 *
 * @param absRoot - absolute path to the directory to scan.
 * @param relPrefix - repo-relative prefix prepended to each entry's name.
 * @returns one {@link SkillEntry} per immediate subdirectory containing a `SKILL.md`.
 */
export function scanSkillDirs(absRoot: string, relPrefix: string): SkillEntry[] {
  if (!existsSync(absRoot)) return [];

  const skills: SkillEntry[] = [];
  for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(INSTALLED_PROJECTION_MARKER)) continue;
    if (!existsSync(join(absRoot, entry.name, 'SKILL.md'))) continue;
    skills.push({ name: entry.name, sourceDir: `${relPrefix}/${entry.name}` });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Enumerate authored skills under `<repoRoot>/.agents/skills`.
 *
 * @param repoRoot - absolute path to the repository root.
 * @returns one {@link SkillEntry} per immediate subdirectory containing a `SKILL.md`.
 */
export function scanSkills(repoRoot: string): SkillEntry[] {
  return scanSkillDirs(join(repoRoot, '.agents', 'skills'), '.agents/skills');
}
