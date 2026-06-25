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

/** The outcome of one reconcile pass. */
export interface WorkspaceReconcileResult {
  synced: number;
  removed: number;
}

/** Periodically rebuilds the workspace cache from the on-disk manifests. */
export class WorkspaceReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: WorkspaceStore,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  /** Start the periodic timer (unref'd so it never blocks process exit). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => logger.error('[workspace] reconciliation failed:', err));
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Stop the periodic timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one reconcile pass. */
  async reconcile(): Promise<WorkspaceReconcileResult> {
    let synced = 0;
    let removed = 0;
    for (const row of this.store.list()) {
      if (!(await WorkspaceService.checkoutExists(row.path))) {
        this.store.removeRow(row.id);
        removed += 1;
        continue;
      }
      const manifest = await this.store.readManifest(row.projectKey, row.key);
      if (manifest && JSON.stringify(manifest) !== JSON.stringify(row)) {
        this.store.upsertRow(manifest);
        synced += 1;
      }
    }
    return { synced, removed };
  }
}
