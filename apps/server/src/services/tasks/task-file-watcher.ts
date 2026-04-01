/**
 * Watches task directories for SKILL.md file changes and syncs to the DB cache.
 *
 * @module services/tasks/task-file-watcher
 */
import chokidar, { type FSWatcher } from 'chokidar';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { TaskStore } from './task-store.js';
import { parseSkillFile } from '@dorkos/skills/parser';
import { TaskFrontmatterSchema } from '@dorkos/skills/task-schema';
import { SKILL_FILENAME } from '@dorkos/skills/constants';
import { logger } from '../../lib/logger.js';

/** Callback invoked when a task file changes or is removed. */
type TaskChangeCallback = (taskSlug: string) => void;

/**
 * Watches task directories for file changes and syncs to the DB cache.
 *
 * - Global tasks: `{dorkHome}/tasks/` — started unconditionally on server startup
 * - Project tasks: `{projectPath}/.dork/tasks/` — started per agent registration
 */
export class TaskFileWatcher {
  private watchers = new Map<string, FSWatcher>();

  constructor(
    private store: TaskStore,
    private onTaskChange: TaskChangeCallback,
    private dorkHome: string
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

    const watcher = chokidar.watch(path.join(tasksDir, '*', SKILL_FILENAME), {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 25,
      },
    });

    watcher.on('add', (filePath) => this.handleFileChange(filePath, scope, projectPath, agentId));
    watcher.on('change', (filePath) =>
      this.handleFileChange(filePath, scope, projectPath, agentId)
    );
    watcher.on('unlink', (filePath) => this.handleFileRemove(filePath));

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
      this.store.upsertFromFile(def, agentId);
      this.onTaskChange(def.name);
    } catch (err) {
      logger.error(`[TaskFileWatcher] Failed to process ${filePath}`, err);
    }
  }

  private handleFileRemove(filePath: string): void {
    // Derive slug from the parent directory name (e.g., /tasks/daily-check/SKILL.md → "daily-check")
    const dirName = path.basename(path.dirname(filePath));
    this.store.markRemovedBySlug(dirName);
    this.onTaskChange(dirName);
    logger.info(`[TaskFileWatcher] Task file removed: ${dirName}`);
  }
}
