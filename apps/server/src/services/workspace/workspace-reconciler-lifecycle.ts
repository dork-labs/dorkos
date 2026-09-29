/**
 * Sticky root ownership of workspace reconciliation, including interrupted startup.
 * Other server resources retain their own teardown contracts.
 *
 * @module server/services/workspace/workspace-reconciler-lifecycle
 */
import { logger } from '../../lib/logger.js';
import type { WorkspaceDisposeResult, WorkspaceReconciler } from './workspace-reconciler.js';

/** Retains one reconciler and closes its admission even when cleanup precedes startup. */
export class WorkspaceReconcilerLifecycle {
  private reconciler: WorkspaceReconciler | null = null;
  private disposed = false;
  private disposal: Promise<WorkspaceDisposeResult> | null = null;

  /** Register once before starting, so failed timer acquisition remains owned. */
  start(reconciler: WorkspaceReconciler): void {
    if (this.disposed) throw new Error('WorkspaceReconcilerLifecycle is disposed');
    if (this.reconciler) throw new Error('WorkspaceReconcilerLifecycle already owns a reconciler');
    this.reconciler = reconciler;
    reconciler.start();
  }

  /**
   * Fence the real reconciler synchronously, then share its bounded completion.
   * Unexpected failures remain failed for every caller; timeout is not IO cancellation.
   */
  dispose(): Promise<WorkspaceDisposeResult> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    try {
      const disposal =
        this.reconciler?.dispose() ??
        Promise.resolve<WorkspaceDisposeResult>({ status: 'drained' });
      this.disposal = disposal.then((outcome) => {
        if (outcome.status === 'timed-out') {
          logger.warn(
            '[workspace] Reconciliation disposal timed out; late cache writes remain fenced'
          );
        }
        return outcome;
      });
    } catch (error) {
      // A synchronous disposal failure must also be memoized as a stable rejection.
      this.disposal = Promise.reject(error);
    }
    return this.disposal;
  }
}
