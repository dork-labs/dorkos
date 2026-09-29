/**
 * Workspace reconciler — keeps the SQLite cache consistent with the file-first
 * manifests (ADR-0043), on the same 5-minute cadence the mesh reconciler uses.
 * Per cached row: if the checkout dir is gone, drop the stale row; if the
 * on-disk manifest differs from the row, sync manifest → row (manifest wins).
 * It never deletes a checkout — reclamation is `sweep()`'s dirty-gated job.
 *
 * @module server/services/workspace/workspace-reconciler
 */
import { logger } from '../../lib/logger.js';
import type { WorkspaceStore } from './workspace-store.js';
import { WorkspaceService } from './workspace-service.js';

/** Default reconcile cadence (ms) — matches the mesh reconciler. */
const DEFAULT_INTERVAL_MS = 300_000;

/** Class-local drain budget; this is not a server shutdown deadline. */
const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000;

/** Terminal disposal reports whether the tracked read settled before the deadline. */
export type WorkspaceDisposeResult = { status: 'drained' | 'timed-out' };

/** Internal lifecycle tuning; existing constructor callers need no options. */
interface WorkspaceReconcilerOptions {
  disposeTimeoutMs?: number;
}

/** The outcome of one reconcile pass. */
export interface WorkspaceReconcileResult {
  synced: number;
  removed: number;
}

/** Periodically rebuilds the workspace cache from the on-disk manifests. */
export class WorkspaceReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  private pending: Promise<WorkspaceReconcileResult> | null = null;
  private disposal: Promise<WorkspaceDisposeResult> | null = null;
  private disposed = false;
  private generation = 0;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
    private readonly options: WorkspaceReconcilerOptions = {}
  ) {}

  /** Start one periodic timer; a terminally disposed owner cannot restart. */
  start(): void {
    if (this.disposed) throw new Error('WorkspaceReconciler is disposed');
    if (this.timer !== null) return;
    const timer = setInterval(() => {
      if (this.timer !== timer || this.pending) return;
      this.reconcile().catch((err) => logger.error('[workspace] reconciliation failed:', err));
    }, this.intervalMs);
    try {
      timer.unref();
      this.timer = timer;
    } catch (error) {
      clearInterval(timer);
      throw error;
    }
  }

  /** Stop scheduling synchronously, without draining work or preventing restart. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run or join one pass, including while stopped; refuse work after disposal starts. */
  reconcile(): Promise<WorkspaceReconcileResult> {
    if (this.disposed) return Promise.reject(new Error('WorkspaceReconciler is disposed'));
    if (this.pending) return this.pending;
    const pending = this.runPass(this.generation);
    this.pending = pending;
    const release = () => {
      this.pending = null;
    };
    // Observe both outcomes without creating an unhandled rejecting cleanup promise.
    void pending.then(release, release);
    return pending;
  }

  /**
   * Permanently stop admission and fence writes before waiting for the tracked pass.
   * A timeout cannot cancel IO; repeated calls retain the original promise/outcome.
   * This class-local guarantee requires separate adoption by the server owner.
   */
  dispose(): Promise<WorkspaceDisposeResult> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.generation += 1;
    this.stop();
    const pending = this.pending;
    if (!pending) {
      this.disposal = Promise.resolve({ status: 'drained' });
    } else {
      this.disposal = new Promise((resolve) => {
        const deadline = setTimeout(
          () => resolve({ status: 'timed-out' }),
          this.options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
        );
        const drained = () => {
          clearTimeout(deadline);
          resolve({ status: 'drained' });
        };
        // Keep observing rejection even if the deadline wins; scheduled errors still log.
        void pending.then(drained, drained);
      });
    }
    return this.disposal;
  }

  private canWrite(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  private async runPass(generation: number): Promise<WorkspaceReconcileResult> {
    let synced = 0;
    let removed = 0;
    if (!this.canWrite(generation)) return { synced, removed };
    for (const row of this.store.list()) {
      const exists = await WorkspaceService.checkoutExists(row.path);
      // Store mutations are synchronous. If that changes, this fence must be redesigned.
      if (!this.canWrite(generation)) break;
      if (!exists) {
        this.store.removeRow(row.id);
        removed += 1;
        continue;
      }
      const manifest = await this.store.readManifest(row.projectKey, row.key);
      if (!this.canWrite(generation)) break;
      if (manifest && JSON.stringify(manifest) !== JSON.stringify(row)) {
        this.store.upsertRow(manifest);
        synced += 1;
      }
    }
    return { synced, removed };
  }
}
