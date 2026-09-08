/**
 * Dead links left behind by an authored skill that moved (SK-10).
 *
 * Removing or renaming `.agents/skills/<x>` leaves `.claude/skills/<x>` pointing
 * at nothing. The plan cannot name it — its source is gone — so nothing else in
 * the engine ever looks at it: `checkPlan` had no action to call stale, and
 * `sweepInstalledOrphans` only ever considers `__` links. Claude Code cannot
 * follow a dead link, so the person was left with a broken skill and a `--check`
 * that called the tree clean.
 *
 * One scanner answers both questions — `--check` names these, `--fix` removes
 * them — so the report and the sweep can never disagree about what an orphan IS.
 * WHEN each runs is the CLI's business and not the same: the sweep runs only for
 * a full plan, so `dorkos harness sync --check --harness <id>` withholds this
 * list rather than naming links the matching `--fix` would not remove.
 *
 * The predicate is narrow on purpose. An entry qualifies only when ALL of it
 * holds:
 *
 * - it is a **symlink**. A real directory is somebody's content, whatever it is
 *   called; the engine's own projections are always links.
 * - its link text resolves **into `.agents/skills/`**. A person's link to a
 *   skill kept in a vendored checkout elsewhere is theirs, dead or not.
 * - its target is **gone**. A live link is a projection, not an orphan.
 * - its name carries **no `__`**. That shape belongs to
 *   `sweepInstalledOrphans`, which already prunes a vanished plugin's links;
 *   letting both claim one path would sweep and report it twice.
 * - the current plan does **not** name it. A link the plan still wants is drift
 *   for `applySymlink` to repair, never something to delete.
 *
 * @module apply/authored-orphans
 */
import { readlinkSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ProjectionPlan } from '../plan/types.js';
import { AGENTS_SKILLS_DIR, INSTALLED_PROJECTION_MARKER } from '../scan/scanner.js';
import { CLAUDE_SKILLS_DIR } from '../plan/installed-projector.js';
import { isDanglingSymlink, isSymlink, listDir } from './link-state.js';

/**
 * Find the authored skill links that point at nothing.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan (every symlink target it names is kept).
 * @returns the repo-relative paths of the dead links, sorted.
 */
export function findOrphanedAuthoredLinks(repoRoot: string, plan: ProjectionPlan): string[] {
  const planned = new Set(
    plan.actions.filter((a) => a.kind === 'symlink' && a.target).map((a) => a.target as string)
  );

  // Nothing to scan means no orphans, never a crash: `.claude/skills` may be
  // absent, a FILE, or unreadable, and `checkPlan` reads it before it can say
  // anything at all (see `listDir`).
  const skillsDir = join(repoRoot, CLAUDE_SKILLS_DIR);

  const orphans: string[] = [];
  for (const entry of listDir(skillsDir)) {
    if (entry.includes(INSTALLED_PROJECTION_MARKER)) continue; // the installed sweep's
    const rel = `${CLAUDE_SKILLS_DIR}/${entry}`;
    if (planned.has(rel)) continue; // still projected — apply repairs it
    const abs = join(skillsDir, entry);
    if (!isSymlink(abs) || !isDanglingSymlink(abs)) continue; // real content, or a live link
    if (!pointsIntoAuthoredSkills(repoRoot, skillsDir, abs)) continue; // somebody's own link
    orphans.push(rel);
  }
  return orphans.sort();
}

/**
 * Remove the authored skill links that point at nothing.
 *
 * Only the link is removed — never anything at the other end of it, which by
 * definition is not there.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns the repo-relative paths swept.
 */
export function sweepAuthoredOrphans(repoRoot: string, plan: ProjectionPlan): string[] {
  const orphans = findOrphanedAuthoredLinks(repoRoot, plan);
  for (const rel of orphans) rmSync(join(repoRoot, rel), { force: true });
  return orphans;
}

/**
 * Whether a link's text — resolved from the directory the link sits in, so a
 * relative projection like `../../.agents/skills/x` is read the way the OS reads
 * it — lands inside the authored skills directory.
 */
function pointsIntoAuthoredSkills(repoRoot: string, linkDir: string, abs: string): boolean {
  const target = resolve(linkDir, readlinkSync(abs));
  const inside = relative(join(repoRoot, AGENTS_SKILLS_DIR), target);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
}
