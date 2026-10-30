/**
 * Project-only schedules from a global package (DOR-3376).
 *
 * A package installed globally puts its scheduled skills in `~/.dork/skills`,
 * which made every one of them a global schedule with no project. Some only
 * make sense inside a project (Flow's `flow-drain` works on a repo's own
 * backlog), and approving one globally would run it nowhere useful. A file
 * marks that with `scope: project` in its `schedule:` block.
 *
 * Such a file from a GLOBAL root becomes no global row at all. Instead, each
 * registered project gets its own copy: switched off, keyed on the file and
 * the project's agent, running in that project's folder. A copy is a
 * discovered file like any other, so turning it on is the same approval a
 * package's opt-in schedule takes today; nothing here asks anybody anything.
 * From a project's own root the key changes nothing.
 *
 * Shared by the watcher and the reconciler so the two cannot disagree about
 * which rows one file makes.
 *
 * @module services/tasks/sync/project-only-schedules
 */
import type { Task } from '@dorkos/shared/types';
import type { TaskDefinition } from '@dorkos/skills/types';
import type { TaskRoot } from '../skills-roots.js';
import type { TaskStore } from '../task-store.js';
import type { UpsertFromFileOptions } from './task-file-sync.js';

/**
 * The projects that get a copy of this file, or `null` when the file is synced
 * the ordinary way: one row, where the file is.
 *
 * @param def - The parsed file.
 * @param root - The root it was found in.
 * @param roots - Every root DorkOS is reading, so each registered project is
 *   found once.
 * @returns The agent ids of the projects, each once, or `null`.
 */
export function projectOnlyTargets(
  def: TaskDefinition,
  root: TaskRoot,
  roots: Iterable<TaskRoot>
): string[] | null {
  if (root.scope !== 'global' || def.meta.schedule.scope !== 'project') return null;
  const agentIds = new Set<string>();
  for (const candidate of roots) {
    if (candidate.scope === 'project' && candidate.agentId) agentIds.add(candidate.agentId);
  }
  return [...agentIds];
}

/** What one sync of a project-only file changed. */
export interface ProjectCopiesSync {
  /** Each project's copy, as it now stands. */
  copies: Task[];
  /** Rows this sync deleted, so their clock jobs can be taken down. */
  removedIds: string[];
}

/**
 * Write one copy of the file per project, and remove the global row it used to
 * make, if there is one.
 *
 * The global row goes rather than pausing: a paused global schedule would still
 * be listed as global, which is the one thing this marker exists to stop.
 *
 * @param store - The task store.
 * @param def - The parsed file.
 * @param agentIds - The projects, from {@link projectOnlyTargets}.
 * @param options - The discovery write's own options.
 */
export function syncProjectCopies(
  store: TaskStore,
  def: TaskDefinition,
  agentIds: readonly string[],
  options: UpsertFromFileOptions
): ProjectCopiesSync {
  const removedIds: string[] = [];
  const global = store.fileSync.getByFilePath(def.filePath);
  if (global && store.deleteTask(global.id)) removedIds.push(global.id);
  const copies = agentIds.map((agentId) =>
    store.fileSync.upsertFromFile(def, agentId, { ...options, projectOnly: true })
  );
  return { copies, removedIds };
}

/**
 * Remove every project's copy of a file that is no longer project-only: its
 * `scope` key was taken out, so it is one ordinary schedule again.
 *
 * @param store - The task store.
 * @param filePath - The file's resolved path.
 * @returns The ids removed, so their clock jobs can be taken down.
 */
export function dropProjectCopies(store: TaskStore, filePath: string): string[] {
  return store.fileSync
    .projectCopiesOf(filePath)
    .filter((copy) => store.deleteTask(copy.id))
    .map((copy) => copy.id);
}
