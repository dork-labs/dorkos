/**
 * Watches the roots where scheduled work can live and syncs what it finds to
 * the DB cache and the running scheduler.
 *
 * @module services/tasks/task-file-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { TaskStore } from './task-store.js';
import type { TaskRegistrar } from './task-registrar.js';
import type { ScheduleIdentityRegistry } from './schedule-identity.js';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { readTaskRootFile } from './skills-root-discovery.js';
import type { TaskRoot } from './skills-roots.js';
import { logger } from '../../lib/logger.js';

/**
 * Watches task roots for file changes and syncs them to the DB cache and the
 * scheduler.
 *
 * Two kinds of root, both live until DOR-1486 retires the second
 * (`skills-roots.ts`):
 *
 * - **Skills roots** — `{dorkHome}/skills/` and every registered agent's
 *   `{projectPath}/.agents/skills/`. Files are read with the unified skill
 *   schema, and only those carrying a `schedule:` block become schedules.
 * - **Legacy task roots** — `{dorkHome}/tasks/` and `{projectPath}/.dork/tasks/`.
 *   Every file is a schedule, read with the old top-level-fields schema.
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
    private registrar: TaskRegistrar,
    private identities: ScheduleIdentityRegistry
  ) {}

  /**
   * Watch one root for SKILL.md changes.
   *
   * @param root - The directory to watch and how to read what is in it.
   */
  watch(root: TaskRoot): void {
    if (this.watchers.has(root.dir)) {
      logger.warn(`[TaskFileWatcher] Already watching ${root.dir} — skipping duplicate`);
      return;
    }

    // Watch the directory itself and filter to {slug}/SKILL.md in the handler.
    // NO glob: chokidar v4 removed glob support, so a `*/SKILL.md` pattern
    // watches a literal path that never exists and silently never fires.
    const watcher = chokidar.watch(root.dir, {
      persistent: true,
      ignoreInitial: false,
      depth: 1,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25,
      },
    });

    // A task is `<root>/<slug>/SKILL.md`, and `<slug>` may not be a name the
    // tasks system reserves for a container. That last clause is not tidiness —
    // a row for `<root>/templates/SKILL.md` is genuinely dangerous:
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
      path.dirname(path.dirname(filePath)) === root.dir &&
      !RESERVED_TASK_DIRNAMES.includes(path.basename(path.dirname(filePath)));
    watcher.on('add', (filePath) => {
      if (isSkillFile(filePath)) void this.handleFileChange(filePath, root);
    });
    watcher.on('change', (filePath) => {
      if (isSkillFile(filePath)) void this.handleFileChange(filePath, root);
    });
    watcher.on('unlink', (filePath) => {
      if (isSkillFile(filePath)) this.handleFileRemove(filePath, root);
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
    // closure, so one root's latch cannot silence a sibling's.
    const seenCodes = new Set<string>();
    watcher.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
      if (seenCodes.has(code)) return;
      seenCodes.add(code);
      // Logged as an explicit object, never the bare Error: the NDJSON reporter
      // spreads what it is given, and `message`/`stack` are non-enumerable on
      // an Error, so they would vanish (DOR-832).
      logger.error(
        `[watcher-error] TaskFileWatcher: ${root.dir} (${root.scope}) — further ${code} errors from this watcher are suppressed`,
        {
          tasksDir: root.dir,
          scope: root.scope,
          kind: root.kind,
          code,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          suppressingFurtherErrors: true,
        }
      );
    });

    this.watchers.set(root.dir, watcher);
    logger.info(`[TaskFileWatcher] Watching ${root.dir} (${root.scope}, ${root.kind})`);
  }

  /**
   * Stop watching one root (e.g. on agent unregister).
   *
   * The root's identity claims go with it: a root nobody watches must not keep
   * owning files another root can still see (see {@link ScheduleIdentityRegistry}).
   *
   * @param tasksDir - The root's directory.
   */
  async stopWatching(tasksDir: string): Promise<void> {
    const watcher = this.watchers.get(tasksDir);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(tasksDir);
      this.identities.releaseRoot(tasksDir);
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

  private async handleFileChange(filePath: string, root: TaskRoot): Promise<void> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const outcome = await readTaskRootFile(filePath, content, root);

      if (outcome.kind === 'invalid') {
        // The row, if there is one, is left exactly as it was: a typo in
        // frontmatter must never cost a schedule its id and run history.
        logger.warn(`[TaskFileWatcher] Invalid file ${filePath}: ${outcome.error}`);
        return;
      }

      if (outcome.kind === 'ignored') {
        // A file in a skills root with no `schedule:` block is not a schedule.
        // If it used to be one, the schedule is over: pause the row so it stops
        // firing content the file no longer claims. Removing the block is how a
        // person turns a scheduled task back into a plain skill (spec §2).
        this.retireIfPresent(filePath);
        return;
      }

      // The row first, then the job that runs from it. Both, or the cockpit
      // shows one schedule while a different one fires — which is what a no-op
      // `onTaskChange` left this doing until the next restart.
      const { discovered } = outcome;
      if (!this.identities.claim(discovered.def.filePath, root.dir)) return;
      const task = this.store.upsertFromFile(discovered.def, root.agentId, {
        source: 'discovery',
        problem: discovered.problem,
      });
      this.registrar.syncTask(task.id);
    } catch (err) {
      logger.error(`[TaskFileWatcher] Failed to process ${filePath}`, err);
    }
  }

  /**
   * Pause the row at this path, if there is one, without complaining when there
   * is not — the ordinary case for a plain skill that was never scheduled.
   */
  private retireIfPresent(filePath: string): void {
    if (this.store.markRemovedByFilePath(filePath) === 0) return;
    this.registrar.syncTaskByFilePath(filePath);
    logger.info(`[TaskFileWatcher] Schedule block removed from ${filePath} — paused`);
  }

  private handleFileRemove(filePath: string, root: TaskRoot): void {
    const dirName = path.basename(path.dirname(filePath));
    try {
      // Pause by exact path, not by slug: the same slug can exist in the global
      // root and in any number of project ones, and only this file was removed.
      //
      // The path is used as-is rather than resolved, because a deleted file has
      // no real path to resolve — `fs.realpath` on it throws ENOENT. For a
      // symlinked entry that means the row keyed on the link TARGET is not
      // paused here; the reconciler is the backstop for that, and the identity
      // claim is released either way so another root can pick the file up.
      this.identities.releasePath(filePath);
      this.store.markRemovedByFilePath(filePath);
      // Paused in the DB is not paused on the clock. Without this the job keeps
      // firing a task whose file — the source of truth for what it even does —
      // is gone.
      this.registrar.syncTaskByFilePath(filePath);
      logger.info(`[TaskFileWatcher] Task file removed: ${dirName} (${root.scope})`);
    } catch (err) {
      // Contained for the same reason the change handler is: this runs inside a
      // chokidar event, where a throw has nowhere to go but the process-wide
      // unhandled-error path.
      logger.error(`[TaskFileWatcher] Failed to retire ${filePath}`, err);
    }
  }
}
