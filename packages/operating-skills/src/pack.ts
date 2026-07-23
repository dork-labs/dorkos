/**
 * The Operating DorkOS skill pack — the canonical, ordered list of first-party
 * skills that teach an agent how to run DorkOS, plus the pack version stamped
 * into every seeded file.
 *
 * @module pack
 */
import { operatingDorkos } from './skills/operating-dorkos.js';
import { managingAgents } from './skills/managing-agents.js';
import { schedulingTasks } from './skills/scheduling-tasks.js';
import { usingTheMarketplace } from './skills/using-the-marketplace.js';
import { readingActivity } from './skills/reading-activity.js';

/** One authored skill in the pack: its kebab-case name, discovery description, and body. */
export interface OperatingSkill {
  /** Kebab-case skill name; also the directory name under `.agents/skills/`. */
  name: string;
  /** Frontmatter `description` — the string that triggers skill activation. */
  description: string;
  /** Markdown body written for models (ACI-style, imperative). */
  body: string;
}

/**
 * The pack content version. Bump this (integer, monotonic) whenever any skill
 * body or description changes so the seeder re-writes unmodified on-disk copies.
 * User-modified copies are never overwritten regardless of version.
 */
export const OPERATING_SKILLS_VERSION = 1;

/**
 * The canonical pack, umbrella skill first. Every entry is validated against the
 * `@dorkos/skills` SKILL.md schema by this package's tests.
 */
export const OPERATING_SKILLS_PACK: readonly OperatingSkill[] = [
  operatingDorkos,
  managingAgents,
  schedulingTasks,
  usingTheMarketplace,
  readingActivity,
];
