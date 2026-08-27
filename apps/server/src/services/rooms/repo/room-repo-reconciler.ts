/**
 * Room-repo reconciler — rebuilds the `room_repos` cache from the sidecars on
 * disk (ADR-0043), on the same 5-minute cadence the mesh and workspace
 * reconcilers use.
 *
 * One pass, two directions:
 *
 * - every home directory holding a `room-repo.json` gets its row inserted or
 *   refreshed from the file,
 * - every cached row whose sidecar has vanished is dropped.
 *
 * ## Orphans are reported and left alone — never deleted
 *
 * `room_repos.room_id` is a real foreign key onto `rooms.id`, so a sidecar
 * whose room no longer exists cannot be re-inserted. The two available answers
 * were "delete the orphaned home directory" and "skip it with a warning", and
 * this reconciler skips.
 *
 * A room home is not a cache. It holds the room's git repo — merged history AND
 * every agent worktree's unmerged work — plus the room's attachments. A missing
 * `rooms` row is not proof the operator wanted any of that gone: a restored
 * backup, a half-applied migration, or a bug in whatever path deletes a room
 * all look identical from here, and only one of them is a deletion somebody
 * asked for. The workspace reconciler draws the same line in the same words —
 * "it never deletes a checkout" — and reclamation there is a separate,
 * dirty-gated sweep for the same reason.
 *
 * So the destructive half lives where the intent is: the delete path calls
 * `assertRoomHomeRemovable` and then `RoomRepoStore.removeHome` in the same
 * breath as the row (`room-repo-service.ts`). What this sweep owes is that an
 * orphan left behind by an interrupted one does not crash it — the row is never
 * attempted, so the foreign key is never touched, and every other room on the
 * install still reconciles.
 *
 * @module server/services/rooms/repo/room-repo-reconciler
 */
import { logger } from '../../../lib/logger.js';
import type { RoomRepoStore } from './room-repo-store.js';

/** Default reconcile cadence (ms) — matches the mesh and workspace reconcilers. */
const DEFAULT_INTERVAL_MS = 300_000;

/** The outcome of one reconcile pass. */
export interface RoomRepoReconcileResult {
  /** Rows inserted or refreshed from a sidecar. */
  synced: number;
  /** Rows dropped because their sidecar is gone. */
  removed: number;
  /**
   * Sidecars whose room no longer exists, left untouched on disk.
   *
   * Counted rather than swallowed so that "this install is carrying home
   * directories nothing points at" is a number a person can see, not a silence.
   */
  orphaned: number;
}

/** Periodically rebuilds the room-repo cache from the on-disk sidecars. */
export class RoomRepoReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Bind the sweep to one install's store.
   *
   * @param store - The file-first store to read sidecars and write rows through.
   * @param intervalMs - How often to sweep. Defaults to five minutes.
   */
  constructor(
    private readonly store: RoomRepoStore,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {}

  /** Start the periodic timer (unref'd so it never blocks process exit). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => logger.error('[rooms] repo reconciliation failed:', err));
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

  /**
   * Run one reconcile pass.
   *
   * @returns What the pass changed, orphans included.
   */
  async reconcile(): Promise<RoomRepoReconcileResult> {
    const result: RoomRepoReconcileResult = { synced: 0, removed: 0, orphaned: 0 };
    const seen = new Set<string>();

    for (const roomId of await this.store.listHomeDirs()) {
      const sidecar = await this.store.readSidecar(roomId);
      if (!sidecar) continue;
      seen.add(roomId);
      if (!this.store.roomExists(roomId)) {
        result.orphaned += 1;
        logger.warn('[rooms] room repo has no room', {
          roomId,
          home: this.store.homeDir(roomId),
          note: 'left on disk; nothing here deletes a room’s files',
        });
        continue;
      }
      this.store.upsertRow(sidecar);
      result.synced += 1;
    }

    // The other direction: a row whose sidecar is gone. The file is the truth,
    // so its absence retires the row — this is the tail of an interrupted
    // `remove()`, which drops the row first and the sidecar second.
    for (const row of this.store.listRows()) {
      if (seen.has(row.roomId)) continue;
      this.store.removeRow(row.roomId);
      result.removed += 1;
    }

    return result;
  }
}
