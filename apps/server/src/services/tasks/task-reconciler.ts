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
   * This is a periodic safety net over many independent task files and rows, so
   * every step that can fail is contained to the one file or row it concerns.
   * One unreadable directory, one bad file, or one row the DB refuses to touch
   * says nothing about the rest — and because the pass runs on a timer forever,
   * letting a single failure escape does not retry the work, it permanently
   * disables the safety net.
   */
  async reconcile(): Promise<{ upserted: number; orphaned: number }> {
    let upserted = 0;
    let orphaned = 0;
    const seenFilePaths = new Set<string>();

    for (const dir of this.directories) {
      // `templates/` and friends are containers the tasks system owns, not
      // tasks — scanning them as tasks reports a permanent bogus "invalid
      // file" every pass.
      const results = await scanSkillDirectory(dir.tasksDir, TaskFrontmatterSchema, {
        ignoreDirs: RESERVED_TASK_DIRNAMES,
      }).catch((err: unknown) => {
        // A missing directory is already an empty scan, so reaching here means
        // something genuinely went wrong reading this one.
        logger.error(`[TaskReconciler] Failed to scan ${dir.tasksDir}`, err);
        return [];
      });

      for (const result of results) {
        if (!result.ok) {
          logger.warn(`[TaskReconciler] Invalid file ${result.filePath}: ${result.error}`);
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

    // Mark DB entries as paused if their file is gone (24h grace period)
    const allTasks = this.store.getTasks();
    const now = Date.now();
    for (const task of allTasks) {
      if (!task.filePath || seenFilePaths.has(task.filePath)) continue;
      try {
        const updatedAt = new Date(task.updatedAt).getTime();
        if (now - updatedAt > ORPHAN_GRACE_MS) {
          this.store.deleteTask(task.id);
          orphaned++;
        } else if (task.status !== 'paused') {
          // Derive slug from filePath: /path/to/{slug}/SKILL.md → slug
          const dirName = path.basename(path.dirname(task.filePath));
          this.store.markRemovedBySlug(dirName);
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
