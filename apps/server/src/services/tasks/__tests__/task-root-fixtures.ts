/**
 * Shared root fixtures for the discovery suites.
 *
 * `TaskFileWatcher.watch` and `TaskReconciler.addRoot` took four positional
 * arguments until DOR-1485 and now take one {@link TaskRoot}. This builder keeps
 * the suites that drive them readable.
 *
 * It used to have a twin, `legacyRoot`, for the `tasks/` directories where every
 * SKILL.md was a schedule by virtue of sitting there. DOR-1486 retired those
 * roots, and with them the idea that a root has a KIND: there is one kind now,
 * and a file is a schedule because it says so.
 *
 * @module services/tasks/__tests__/task-root-fixtures
 */
import type { TaskRoot } from '../skills-roots.js';

/**
 * A skills root — only the files carrying a `schedule:` block are schedules.
 *
 * @param dir - The directory.
 * @param scope - Whether it belongs to a project or the install.
 * @param projectPath - The project root, for project scope.
 * @param agentId - The owning agent, for project scope.
 */
export function skillsRoot(
  dir: string,
  scope: 'project' | 'global' = 'global',
  projectPath?: string,
  agentId?: string
): TaskRoot {
  return { dir, scope, projectPath, agentId };
}
