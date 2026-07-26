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
 *
 * History:
 * - 1: initial pack (spec `agents-as-operators` §1.5).
 * - 2: capability self-description pointer (spec `capability-registry` §2.2).
 * - 3: permission tiers, the `approval_required` handshake, and `dorkos call`.
 *   Version 2 taught a pre-approval world: it never mentioned tiers, approvals,
 *   or the universal `dorkos call` path, and it told agents to look for
 *   `requires_confirmation` on `marketplace_uninstall`, which now returns the
 *   approval payload instead. Same round corrected the `config_patch` shape (the
 *   required `patch` wrapper) and the `ui.statusBar` example (a `pins` list, not
 *   per-item booleans).
 * - 4: `dorkos uninstall` is gated too (DOR-467). Version 3 told agents the CLI
 *   verb was "the person's ungated path" and to stay off it. That was true when
 *   written and is not any more: the route behind it now answers to the same
 *   approval gate, so the sentence had to stop describing a hole that is closed.
 * - 5: the pack stops calling a `destructive` tool ungated (DOR-509). Version 4
 *   told every agent that `tasks_delete` "carries no gate of its own". It has been
 *   `destructive` since DOR-468 and stops for a person, so the pack was teaching
 *   agents not to warn anybody before an irreversible delete, and to read a refusal
 *   as a malfunction rather than an answer. Same round: `operating-dorkos` now says
 *   that hand-registered tools carry tiers too (the catalog not listing one is not
 *   the same as it being ungated), and `managing-agents` gained the missing
 *   `mesh_unregister` section, the other `destructive` tool.
 */
export const OPERATING_SKILLS_VERSION = 5;

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
