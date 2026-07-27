/**
 * Safety-net reconciler for file→DB sync.
 *
 * Runs every 5 minutes to catch changes missed by the file watcher
 * (e.g., during network filesystem hiccups or race conditions).
 *
 * @module services/tasks/task-reconciler
 */
import path from 'node:path';
import type { TaskStore } from './task-store.js';
import { scanSkillDirectory } from '@dorkos/skills/scanner';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { RESERVED_TASK_DIRNAMES } from './task-templates.js';
import { logger } from '../../lib/logger.js';

/** 5-minute reconciliation interval. */
const RECONCILE_INTERVAL_MS = 300_000;

/** 24-hour grace period before removing orphan DB entries. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

interface TaskDirectory {
  tasksDir: string;
  scope: 'project' | 'global';
  projectPath?: string;
  agentId?: string;
}

/**
 * Periodically reconciles task files on disk with the DB cache.
 *
 * Follows the agent reconciler pattern from packages/mesh.
 */
export class TaskReconciler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private directories: TaskDirectory[] = [];

  constructor(private store: TaskStore) {}

  /** Register a directory to reconcile. */
  addDirectory(
    tasksDir: string,
    scope: 'project' | 'global',
    projectPath?: string,
    agentId?: string
  ): void {
    this.directories.push({ tasksDir, scope, projectPath, agentId });
  }

  /** Remove a directory from reconciliation (e.g., on agent unregister). */
  removeDirectory(tasksDir: string): void {
    this.directories = this.directories.filter((d) => d.tasksDir !== tasksDir);
  }

  /** Start periodic reconciliation. */
  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      this.reconcile().catch((err) => {
        logger.error('[TaskReconciler] Reconciliation failed', err);
      });
    }, RECONCILE_INTERVAL_MS);
    logger.info('[TaskReconciler] Started (interval: 5m)');
  }

  /** Stop periodic reconciliation. */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('[TaskReconciler] Stopped');
    }
  }

  /**
   * Run a single reconciliation pass.
   *
   * A pass does two things: sync every task file it can read into the DB, then
   * retire rows whose file is gone. The second half destroys data, so it acts
   * only on POSITIVE evidence of deletion — a directory this pass listed
   * successfully, in which the file was not found. Anything short of that (a
   * directory that could not be listed, a file that could not be read, a file
   * whose frontmatter does not parse) leaves the row exactly as it is.
   *
   * The distinction matters because a wrong answer here is unrecoverable: an
   * `ON DELETE CASCADE` takes the task's entire run history with it, and the
   * rebuilt row gets a new id. "Could not look" is not "not there".
   *
   * Every step that can fail is contained to the one directory, file, or row it
   * concerns. Because the pass runs on a timer forever, letting one failure
   * escape does not retry the work — it permanently disables the safety net,
   * which is exactly how this ran broken for weeks.
   */
  async reconcile(): Promise<{ upserted: number; orphaned: number }> {
    let upserted = 0;
    let orphaned = 0;
    const seenFilePaths = new Set<string>();
    // Directories this pass could not list. Nothing inside one may be retired:
    // we have no evidence either way about any file it holds.
    const unlistedDirs: string[] = [];

    for (const dir of this.directories) {
      let results;
      try {
        // `templates/` and friends are containers the tasks system owns, not
        // tasks — scanning them as tasks reports a permanent bogus "invalid
        // file" every pass.
        results = await scanSkillDirectory(dir.tasksDir, TaskFrontmatterSchema, {
          ignoreDirs: RESERVED_TASK_DIRNAMES,
        });
      } catch (err) {
        // A directory that does not exist is already an empty scan, so reaching
        // here means the directory is there and we could not read it — EACCES,
        // or EMFILE under file-descriptor pressure. Treating that as "empty"
        // would pause every task inside it.
        logger.error(`[TaskReconciler] Failed to scan ${dir.tasksDir}`, err);
        unlistedDirs.push(dir.tasksDir);
        continue;
      }

      for (const result of results) {
        if (!result.ok) {
          logger.warn(`[TaskReconciler] Invalid file ${result.filePath}: ${result.error}`);
          // A file that is on disk but unusable — unreadable, or frontmatter
          // that does not parse — is NOT a deleted task. Count it as seen so
          // the retirement pass leaves its row alone; a typo in a cron
          // expression must never cost a task its id and run history. This
          // matches TaskFileWatcher, which also leaves the row untouched when
          // an edit fails to parse.
          if (!result.fileMissing) seenFilePaths.add(result.filePath);
          continue;
        }
        // Record the file as seen BEFORE attempting the write: the file is on
        // disk either way, and a task missing from this set is treated as
        // deleted below. A failed write must never look like a deletion.
        seenFilePaths.add(result.definition.filePath);
        const def = {
          ...result.definition,
          scope: dir.scope as 'project' | 'global',
          projectPath: dir.projectPath,
        };
        try {
          this.store.upsertFromFile(def, dir.agentId);
          upserted++;
        } catch (err) {
          logger.error(`[TaskReconciler] Failed to sync ${result.definition.filePath}`, err);
        }
      }
    }

    // Retire rows whose file is gone: pause first, delete after a 24h grace.
    const allTasks = this.store.getTasks();
    const now = Date.now();
    for (const task of allTasks) {
      if (!task.filePath || seenFilePaths.has(task.filePath)) continue;
      if (unlistedDirs.includes(path.dirname(path.dirname(task.filePath)))) continue;
      try {
        const updatedAt = new Date(task.updatedAt).getTime();
        if (now - updatedAt > ORPHAN_GRACE_MS) {
          this.store.deleteTask(task.id);
          orphaned++;
        } else if (task.status !== 'paused') {
          this.store.markRemovedByFilePath(task.filePath);
        }
      } catch (err) {
        logger.error(`[TaskReconciler] Failed to retire removed task ${task.id}`, err);
      }
    }

    if (upserted > 0 || orphaned > 0) {
      logger.info(
        `[TaskReconciler] Reconciled: ${upserted} upserted, ${orphaned} orphaned removed`
      );
    }

    return { upserted, orphaned };
  }
}
