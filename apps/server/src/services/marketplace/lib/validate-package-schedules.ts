/**
 * The install-time gate on a package's declared schedules.
 *
 * ## Why this is not in `@dorkos/marketplace`
 *
 * The manifest schema checks that a `cron` is a non-empty string, and stops
 * there. Whether the string MEANS anything is croner's question, and croner is a
 * server dependency: `packages/marketplace` is browser-safe (`apps/client` and
 * `apps/site` both import its manifest schema) and holds its dependency list to
 * zod plus `@dorkos/skills`. `@dorkos/skills` declines the same dependency for
 * the same reason, and says so at the top of `schedule-schema.ts`.
 *
 * Writing a second cron grammar inside the schema instead would be worse than
 * either: an acceptance set that agrees with croner today and drifts the first
 * time croner widens or tightens one, surfacing as a schedule the installer
 * accepted and the scheduler then refuses. So the rule lives here, in the
 * process that can ask the real question — the same reasoning, and the same
 * function, `services/tasks/cron-validation.ts` already carries for the API's
 * door.
 *
 * ## Why at install and not at boot
 *
 * A package whose cron croner cannot read is broken at the moment somebody
 * installs it, and that is the moment there is a person present to be told and
 * an install to refuse. Discovered at boot instead, the same defect is a parked
 * row with a warning nobody asked for, attached to a package that has been on
 * disk for weeks. Failing here costs the author one clear sentence; failing at
 * boot costs the operator an investigation.
 *
 * @module services/marketplace/lib/validate-package-schedules
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { MarketplacePackageManifest } from '@dorkos/marketplace';
import { describeScheduleProblem } from '../../tasks/cron-validation.js';
import { slugify } from '@dorkos/skills/slug';
import { packageSchedules, scheduleDisplayName } from './package-schedules.js';

/**
 * Directories inside a package that may hold a schedulable skill, in the order
 * they are searched. The task directories are excluded on purpose: a task
 * directory is the legacy home for scheduled tasks, and a schedule pointing into
 * one is the arrangement this slot replaces.
 *
 * Must stay identical to `SCHEDULE_SKILL_SOURCE_DIRS` in
 * `packages/marketplace/src/package-validator.ts`, which answers the same
 * question at publish time. Disagreeing in either direction puts the failure in
 * front of the wrong person — stricter there rejects a package that installs
 * fine; looser there passes one whose schedule then never materializes, and the
 * author who could fix it never hears about it.
 */
const SKILL_SEARCH_DIRS = ['skills', '.claude/skills', 'commands', '.claude/commands'] as const;

/** How deep to look for a shipped skill below a search root. */
const MAX_SEARCH_DEPTH = 3;

/**
 * Find the directory of a skill a package ships, by name.
 *
 * Matches on DIRECTORY name rather than frontmatter `name`, because that is what
 * every harness keys a skill by — Claude Code included, which is why the package
 * validator downgrades a frontmatter/directory mismatch to a warning rather than
 * an error (DOR-263). A `skillRef` therefore names the directory.
 *
 * @param packageRoot - Absolute path to the package root.
 * @param skillName - The `skillRef` to resolve.
 * @returns Absolute path to the skill directory, or `null` when it is not there.
 */
export async function findShippedSkillDir(
  packageRoot: string,
  skillName: string
): Promise<string | null> {
  for (const dir of SKILL_SEARCH_DIRS) {
    const found = await searchForSkillDir(path.join(packageRoot, dir), skillName, 0);
    if (found) return found;
  }
  return null;
}

/**
 * Depth-bounded search for a skill directory containing a `SKILL.md`.
 *
 * @param root - Directory to search.
 * @param skillName - Directory name to find.
 * @param depth - Current recursion depth.
 * @internal
 */
async function searchForSkillDir(
  root: string,
  skillName: string,
  depth: number
): Promise<string | null> {
  if (depth > MAX_SEARCH_DEPTH) return null;

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null; // Missing or unreadable — not a finding, just not here.
  }

  for (const entry of entries) {
    // A vendored dependency that happens to ship a same-named skill is not this
    // package's skill (the same exclusion `findSkillFiles` makes when staging).
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const child = path.join(root, entry.name);
    if (entry.name === skillName) {
      const hasSkillFile = await readdir(child)
        .then((names) => names.includes('SKILL.md'))
        .catch(() => false);
      if (hasSkillFile) return child;
    }
    const nested = await searchForSkillDir(child, skillName, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * Check every schedule a package declares, before anything touches disk.
 *
 * Two classes of problem, both fatal to the install because both describe a
 * schedule that could never run:
 *
 * 1. A `cron` or `timezone` croner cannot read (see the module note).
 * 2. A `skillRef` naming a skill the package does not ship — a reference to
 *    nothing, which would otherwise materialize as a schedule pointing at a
 *    file that was never there.
 *
 * Every problem is collected rather than thrown on first sight, so an author
 * fixing a manifest sees the whole list in one install attempt.
 *
 * @param packagePath - Absolute path to the staged package root.
 * @param manifest - The validated package manifest.
 * @returns One sentence per problem; empty when every schedule reads.
 */
export async function validatePackageSchedules(
  packagePath: string,
  manifest: MarketplacePackageManifest
): Promise<string[]> {
  const problems: string[] = [];
  const schedules = packageSchedules(manifest);
  /** Directory slug → the declared name that produced it, for collision reporting. */
  const slugOwners = new Map<string, string>();

  for (const [index, schedule] of schedules.entries()) {
    const label = scheduleDisplayName(schedule, index);

    const scheduleProblem = describeScheduleProblem(schedule.cron, schedule.timezone);
    if (scheduleProblem) {
      problems.push(`Schedule '${label}': ${scheduleProblem}`);
    }

    if (schedule.skillRef) {
      const skillDir = await findShippedSkillDir(packagePath, schedule.skillRef);
      if (!skillDir) {
        problems.push(
          `Schedule '${label}' names the skill '${schedule.skillRef}', which this package does ` +
            `not ship. Add a skills/${schedule.skillRef}/SKILL.md, or describe the work inline ` +
            `with name, description and prompt.`
        );
      }
      continue;
    }

    // Inline entries become directories, so their names have to survive
    // slugification and be distinct from each other once slugified.
    if (schedule.name === undefined) continue; // already reported by the schema
    const slug = slugify(schedule.name);

    if (slug === '') {
      // Reported with the author's OWN spelling, because the slug is empty and
      // would name nothing they could search their manifest for. The schema
      // rejects these too; this is the copy an installing person sees.
      problems.push(
        `Schedule '${schedule.name}' has no letters or numbers in its name, so DorkOS cannot ` +
          `make a folder name from it. Rename it to something like 'nightly-tidy'.`
      );
      continue;
    }

    const clashesWith = slugOwners.get(slug);
    if (clashesWith !== undefined) {
      // Two declarations, one directory: the second would silently overwrite the
      // first (same package name, so the ownership gate lets it through) and the
      // uninstall receipt would carry the path twice. One schedule would simply
      // never exist, with nothing said.
      problems.push(
        `Schedules '${clashesWith}' and '${schedule.name}' both become the folder '${slug}', so ` +
          `one would replace the other. Give them names that differ by more than punctuation.`
      );
      continue;
    }
    slugOwners.set(slug, schedule.name);
  }

  return problems;
}
