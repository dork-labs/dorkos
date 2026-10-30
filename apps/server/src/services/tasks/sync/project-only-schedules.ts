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
 * registered project that USES the package gets its own copy: switched off,
 * keyed on the file and the project's agent, running in that project's folder.
 * A project uses the package when it holds the block's `projectFile`, resolved
 * inside the project; with no `projectFile`, no project gets a copy. When in
 * doubt, none: a copy nobody asked for is a switch somebody has to wonder
 * about.
 *
 * A copy is a discovered file like any other, so turning it on is the same
 * approval a package's opt-in schedule takes today; nothing here asks anybody
 * anything. From a project's own root the key changes nothing.
 *
 * Shared by the watcher and the reconciler so the two cannot disagree about
 * which rows one file makes.
 *
 * @module services/tasks/sync/project-only-schedules
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Task } from '@dorkos/shared/types';
import type { TaskDefinition } from '@dorkos/skills/types';
import type { TaskRoot } from '../skills-roots.js';
import type { TaskStore } from '../task-store.js';
import type { UpsertFromFileOptions } from './task-file-sync.js';

/**
 * Whether `relative` names a file that really sits inside `projectPath`.
 *
 * Resolved through every symlink on both sides, so a link pointing out of the
 * project counts as missing, and so does a file that is not there at all.
 * The text rules (no absolute path, no `..`, no `~`) were already checked by
 * the schema; this is the half only the disk can answer.
 *
 * @param projectPath - The project's root folder.
 * @param relative - The block's `projectFile`.
 */
export async function projectHoldsFile(projectPath: string, relative: string): Promise<boolean> {
  try {
    const rootReal = await fs.realpath(projectPath);
    const fileReal = await fs.realpath(path.join(rootReal, relative));
    if (!fileReal.startsWith(rootReal + path.sep)) return false;
    return (await fs.stat(fileReal)).isFile();
  } catch {
    return false;
  }
}

/** Which projects a project-only file reaches, from {@link projectOnlyTargets}. */
export interface ProjectOnlyTargets {
  /** Projects holding the block's `projectFile`: each has, or gets, a copy. */
  using: string[];
  /** Every registered project, so a copy whose project still exists is known. */
  registered: string[];
}

/**
 * The projects a global `scope: project` file reaches, or `null` when the file
 * is synced the ordinary way: one row, where the file is.
 *
 * @param def - The parsed file.
 * @param root - The root it was found in.
 * @param roots - Every root DorkOS is reading, so each registered project is
 *   found once.
 * @returns The agent ids of the projects, each once, or `null`.
 */
export async function projectOnlyTargets(
  def: TaskDefinition,
  root: TaskRoot,
  roots: Iterable<TaskRoot>
): Promise<ProjectOnlyTargets | null> {
  if (root.scope !== 'global' || def.meta.schedule.scope !== 'project') return null;
  const projectFile = def.meta.schedule.projectFile;
  const registered = new Map<string, string>();
  for (const candidate of roots) {
    if (candidate.scope === 'project' && candidate.agentId && candidate.projectPath) {
      registered.set(candidate.agentId, candidate.projectPath);
    }
  }
  const using: string[] = [];
  if (projectFile !== undefined) {
    for (const [agentId, projectPath] of registered) {
      if (await projectHoldsFile(projectPath, projectFile)) using.push(agentId);
    }
  }
  return { using, registered: [...registered.keys()] };
}

/** What one sync of a project-only file changed. */
export interface ProjectCopiesSync {
  /** Each project's copy, as it now stands. */
  copies: Task[];
  /** Rows this sync deleted, so their clock jobs can be taken down. */
  removedIds: string[];
}

/**
 * Write one copy of the file for each project using the package, and remove
 * the global row it used to make, if there is one.
 *
 * The global row goes rather than pausing: a paused global schedule would still
 * be listed as global, which is the one thing this marker exists to stop.
 *
 * **A project that stops using the package.** A copy a person ever switched on
 * stays, and is still synced, so a change to the shared file still parks it
 * for them: their switch is not ours to delete. A copy nobody ever switched on
 * is dropped, because nothing about it was anybody's choice.
 *
 * @param store - The task store.
 * @param def - The parsed file.
 * @param targets - The projects, from {@link projectOnlyTargets}.
 * @param options - The discovery write's own options.
 */
export function syncProjectCopies(
  store: TaskStore,
  def: TaskDefinition,
  targets: ProjectOnlyTargets,
  options: UpsertFromFileOptions
): ProjectCopiesSync {
  const removedIds: string[] = [];
  const global = store.fileSync.getByFilePath(def.filePath);
  if (global && store.deleteTask(global.id)) removedIds.push(global.id);

  const using = new Set(targets.using);
  const kept = new Set<string>();
  for (const copy of store.fileSync.projectCopiesOf(def.filePath)) {
    if (copy.agentId === null || using.has(copy.agentId)) continue;
    if (store.fileSync.projectCopyWasEverOn(copy.id)) {
      // Still synced only while its project is registered; an unregistered
      // agent's rows are paused elsewhere and left alone here.
      if (targets.registered.includes(copy.agentId)) kept.add(copy.agentId);
    } else if (store.deleteTask(copy.id)) {
      removedIds.push(copy.id);
    }
  }

  const copies = [...using, ...kept].map((agentId) =>
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
