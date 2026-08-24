/**
 * Shared root fixtures for the discovery suites.
 *
 * `TaskFileWatcher.watch` and `TaskReconciler.addRoot` took four positional
 * arguments until DOR-1485 and now take one {@link TaskRoot}. These builders
 * keep the three suites that drive them readable, and keep the choice of root
 * KIND explicit at every call site — which matters, because the kind is what
 * decides whether a file is a schedule by virtue of where it lives or by
 * virtue of what it says.
 *
 * @module services/tasks/__tests__/task-root-fixtures
 */
import type { TaskRoot } from '../skills-roots.js';

/**
 * A legacy `tasks/` root — every SKILL.md in it is a schedule.
 *
 * Argument order mirrors the pre-DOR-1485 `watch()` signature so the existing
 * suites read as they always did.
 *
 * @param dir - The directory.
 * @param scope - Whether it belongs to a project or the install.
 * @param projectPath - The project root, for project scope.
 * @param agentId - The owning agent, for project scope.
 */
export function legacyRoot(
  dir: string,
  scope: 'project' | 'global' = 'global',
  projectPath?: string,
  agentId?: string
): TaskRoot {
  return { dir, kind: 'legacy-tasks', scope, projectPath, agentId };
}

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
  return { dir, kind: 'skills', scope, projectPath, agentId };
}
