/**
 * Watches task directories for SKILL.md file changes and syncs them to the DB
 * cache and the running scheduler.
 *
 * @module services/tasks/task-file-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { TaskStore } from './task-store.js';
import type { TaskRegistrar } from './task-registrar.js';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { logger } from '../../lib/logger.js';

/**
 * Watches task directories for file changes and syncs them to the DB cache and
 * the scheduler.
 *
 * - Global tasks: `{dorkHome}/tasks/` — started unconditionally on server startup
 * - Project tasks: `{projectPath}/.dork/tasks/` — started per agent registration
 *
 * The scheduler half runs through {@link TaskRegistrar}, which is what makes an
 * edit on disk take effect now rather than at the next restart. This class used
 * to take a `(taskSlug: string) => void` callback for that, and the one caller
 * in `index.ts` passed `() => {}` — so every on-disk change updated the row and
 * nothing else.
 */
export class TaskFileWatcher {
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private store: TaskStore,
    private registrar: TaskRegistrar
  ) {}

  /**
   * Watch a task directory for SKILL.md file changes.
   *
   * @param tasksDir - Absolute path to the tasks directory
   * @param scope - 'project' or 'global'
   * @param projectPath - Project root (for project-scoped tasks)
   * @param agentId - Agent ID for project-scoped tasks
   */
  watch(
    tasksDir: string,
    scope: 'project' | 'global',
    projectPath?: string,
    agentId?: string
  ): void {
    if (this.watchers.has(tasksDir)) {
      logger.warn(`[TaskFileWatcher] Already watching ${tasksDir} — skipping duplicate`);
      return;
    }

    // Watch the directory itself and filter to {slug}/SKILL.md in the handler.
    // NO glob: chokidar v4 removed glob support, so a `*/SKILL.md` pattern
    // watches a literal path that never exists and silently never fires.
    const watcher = chokidar.watch(tasksDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25,
      },
    });

    // A task is `<tasksDir>/<slug>/SKILL.md`, and `<slug>` may not be a name the
    // tasks system reserves for a container. That last clause is not tidiness —
    // a row for `<tasksDir>/templates/SKILL.md` is genuinely dangerous:
    //
    // - It schedules and fires like any other task, but the reconciler skips
    //   reserved names, so it is the one row with no safety net behind it.
    // - `DELETE /api/tasks/:id` derives the directory to remove from the row's
    //   `filePath`, which for this row is the templates container itself — so
    //   deleting the task `fs.rm`s every template the user has, recursively.
    //
    // Refusing at the source means the row is never created. It does NOT clean
    // up a row an older build already made; that is deliberate. The slot has
    // only ever been reachable by hand-placing a file (the create route refuses
    // the name), so migration logic would be scaffolding for a case nobody is
    // in — and deleting rows to fix a bug about deleting rows is the wrong
    // trade. Such a row is now inert: never re-synced, never retired.
    const isSkillFile = (filePath: string): boolean =>
      path.basename(filePath) === SKILL_FILENAME &&
      path.dirname(path.dirname(filePath)) === tasksDir &&
      !RESERVED_TASK_DIRNAMES.includes(path.basename(path.dirname(filePath)));
    watcher.on('add', (filePath) => {
      if (isSkillFile(filePath)) void this.handleFileChange(filePath, scope, projectPath, agentId);
    });
    watcher.on('change', (filePath) => {
      if (isSkillFile(filePath)) void this.handleFileChange(filePath, scope, projectPath, agentId);
    });
    watcher.on('unlink', (filePath) => {
      if (isSkillFile(filePath)) this.handleFileRemove(filePath);
    });

    // Without this handler a watcher failure (e.g. EMFILE when the process runs
    // out of file descriptors) has nowhere to go but the process-wide
    // unhandled-error path, which spams the log without ever naming the watcher
    // that died. This directory stops syncing to the DB cache until the process
    // restarts or the caller re-watches it — chokidar offers no reconnect
    // signal, so saying so once, clearly, is the whole remedy.
    //
    // A single fd-exhaustion episode can make chokidar fire 'error' once per
    // directory it fails to (re-)watch, so this latches per distinct error code
    // rather than a single boolean: a benign EACCES on one path must never
    // suppress the EMFILE storm that follows it. The Set lives in this per-call
    // closure, so one tasks dir's latch cannot silence a sibling's.
    const seenCodes = new Set<string>();
    watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Logged as an explicit object, never the bare Error: the NDJSON reporter
      // spreads what it is given, and `message`/`stack` are non-enumerable on
      // an Error, so they would vanish (DOR-832).
      logger.error(
        `[watcher-error] TaskFileWatcher: ${tasksDir} (${scope}) — further ${code} errors from this watcher are suppressed`,
        {
          tasksDir,
          scope,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });

    this.watchers.set(tasksDir, watcher);
    logger.info(`[TaskFileWatcher] Watching ${tasksDir} (${scope})`);
  }

  /** Stop watching a specific directory (e.g., on agent unregister). */
  async stopWatching(tasksDir: string): Promise<void> {
    const watcher = this.watchers.get(tasksDir);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(tasksDir);
      logger.info(`[TaskFileWatcher] Stopped watching ${tasksDir}`);
    }
  }

  /** Stop all watchers (server shutdown). */
  async stopAll(): Promise<void> {
    for (const watcher of this.watchers.values()) {
      await watcher.close();
    }
    this.watchers.clear();
  }

  private async handleFileChange(
    filePath: string,
    scope: 'project' | 'global',
    projectPath?: string,
    agentId?: string
  ): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const result = parseSkillFile(filePath, content, TaskFrontmatterSchema);

      if (!result.ok) {
        logger.warn(`[TaskFileWatcher] Invalid task file ${filePath}: ${result.error}`);
        return;
      }

      const def = { ...result.definition, scope, projectPath };
      // The row first, then the job that runs from it. Both, or the cockpit
      // shows one schedule while a different one fires — which is what a
      // no-op `onTaskChange` left this doing until the next restart.
      const task = this.store.upsertFromFile(def, agentId);
      this.registrar.syncTask(task.id);
    } catch (err) {
      logger.error(`[TaskFileWatcher] Failed to process ${filePath}`, err);
    }
  }

  private handleFileRemove(filePath: string): void {
    const dirName = path.basename(path.dirname(filePath));
    try {
      // Pause by exact path, not by slug: the same slug can exist in the global
      // tasks directory and in any number of project ones, and only this file
      // was removed.
      this.store.markRemovedByFilePath(filePath);
      // Paused in the DB is not paused on the clock. Without this the job keeps
      // firing a task whose file — the source of truth for what it even does —
      // is gone.
      this.registrar.syncTaskByFilePath(filePath);
      logger.info(`[TaskFileWatcher] Task file removed: ${dirName}`);
    } catch (err) {
      // Contained for the same reason the change handler is: this runs inside a
      // chokidar event, where a throw has nowhere to go but the process-wide
      // unhandled-error path.
      logger.error(`[TaskFileWatcher] Failed to retire ${filePath}`, err);
    }
  }
}
