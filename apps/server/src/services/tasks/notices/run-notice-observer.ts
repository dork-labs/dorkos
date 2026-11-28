/**
 * Post-commit observations for schedule notices, separate from execution and its terminal hook.
 * @module services/tasks/notices/run-notice-observer
 */
import type { TaskRun } from '@dorkos/shared/types';
import { logger } from '../../../lib/logger.js';

/** Optional notice consumer. It cannot change whether a run was persisted. */
export class RunNoticeObserver {
  scheduled: ((run: TaskRun) => void) | undefined;
  terminal: ((run: TaskRun) => void) | undefined;

  /**
   * Queue a committed observation; a failed notice must not corrupt run history.
   *
   * @param kind - Which observation.
   * @param run - The run, as written.
   * @param committed - Whether the write is still there when the notice goes.
   */
  emit(kind: 'scheduled' | 'terminal', run: TaskRun | null, committed = () => true): void {
    if (!run || !this[kind]) return;
    const listener = this[kind]!;
    queueMicrotask(() => {
      if (!committed()) return;
      try {
        listener(run);
      } catch (error) {
        logger.warn('Could not post a schedule notice', error);
      }
    });
  }
}
