/**
 * Room-repo reconciler — rebuilds the `room_repos` cache from the sidecars on
 * disk (ADR-0043), on the same 5-minute cadence the mesh and workspace
 * reconcilers use.
 *
 * One pass, two directions:
 *
 * - every home directory holding a `room-repo.json` gets its row inserted or
 *   refreshed from the file,
 * - every cached row whose sidecar is gone is dropped — **re-checked against
 *   the disk at the moment of removal**, never against the listing the pass
 *   started with. See below.
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
 * `RoomRepoService.assertHomeRemovable` and then `removeHome` in the same
 * breath as the row (`room-repo-service.ts`). What this sweep owes is that an
 * orphan left behind by an interrupted one does not crash it — the row is never
 * attempted, so the foreign key is never touched, and every other room on the
 * install still reconciles.
 *
 * ## Why the removal half re-reads the disk
 *
 * The pass walks the homes, then drops rows it did not see. Those are two
 * moments, and an `enable()` landing between them wrote a sidecar and a row the
 * walk could not have seen — so the removal loop would delete the row of a repo
 * that had just been created, and `hasRepo` would answer `false` for the next
 * five minutes about a repo sitting on disk. Reproduced by parking a pass mid
 * walk and writing a binding underneath it: `removed: 1`, row `null`.
 *
 * The fix is to treat the listing as a hint and the disk as the authority: a
 * row is retired only after a fresh `readSidecar` for that exact room also says
 * there is nothing there. That read is the same one `remove()`'s ordering makes
 * decisive, so the two agree by construction rather than by timing.
 *
 * @module server/services/rooms/repo/room-repo-reconciler
 */
import { logger } from '../../../lib/logger.js';
import type { RoomRepoStore } from './room-repo-store.js';

/** Default reconcile cadence (ms) — matches the mesh and workspace reconcilers. */
const DEFAULT_INTERVAL_MS = 300_000;

/**
 * How old a leftover `.{uuid}.tmp` sidecar draft must be before the sweep tidies
 * it away.
 *
 * An hour, which is far longer than any write takes and short enough that a
 * person opening the directory does not find a pile. A younger draft may belong
 * to a write happening right now.
 */
const STALE_DRAFT_MAX_AGE_MS = 60 * 60 * 1000;

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
  /** Leftover sidecar drafts tidied away. */
  draftsRemoved: number;
}

/** Periodically rebuilds the room-repo cache from the on-disk sidecars. */
export class RoomRepoReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Whether a pass is running right now.
   *
   * An in-flight guard rather than an argument that overlap is harmless
   * (DOR-1578's shape, from `services/search/indexer.ts`). This pass awaits the
   * filesystem for every room, so on an install with many rooms — or a slow
   * disk — a pass can outlive the interval, and two passes racing on the same
   * rows is exactly the timing the removal half was just hardened against. The
   * guard makes the question moot instead of arguable.
   */
  private inFlight = false;

  /** Whether the current run of skipped ticks has already been logged. */
  private skippedTickLogged = false;

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
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
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
   * One tick: run a pass unless the previous one is still going.
   *
   * The guard is set before the pass starts and cleared in a `finally`, so a
   * pass that throws still releases it for the next tick.
   */
  private runTick(): void {
    if (this.inFlight) {
      if (!this.skippedTickLogged) {
        this.skippedTickLogged = true;
        logger.debug('[rooms] repo reconcile tick skipped: the previous pass is still running');
      }
      return;
    }
    this.inFlight = true;
    this.skippedTickLogged = false;
    this.reconcile()
      .catch((err) => logger.error('[rooms] repo reconciliation failed:', err))
      .finally(() => {
        this.inFlight = false;
      });
  }

  /**
   * Run one reconcile pass.
   *
   * @returns What the pass changed, orphans included.
   */
  async reconcile(): Promise<RoomRepoReconcileResult> {
    const result: RoomRepoReconcileResult = {
      synced: 0,
      removed: 0,
      orphaned: 0,
      draftsRemoved: 0,
    };
    const seen = new Set<string>();

    for (const roomId of await this.store.listHomeDirs()) {
      result.draftsRemoved += await this.store.sweepStaleDrafts(roomId, STALE_DRAFT_MAX_AGE_MS);
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
      // The listing above is a hint from a moment that has passed. Ask the disk
      // again about THIS room before deleting anything: a binding created while
      // the walk was running is on disk and not in `seen`, and retiring its row
      // would make `hasRepo` lie until the next pass. See the module doc.
      const late = await this.store.readSidecar(row.roomId);
      if (late) {
        // It is here after all, so finish the job the walk missed rather than
        // merely sparing it — the row this pass would have deleted may also be
        // out of date. The room's existence is re-checked for the same reason
        // the first loop checks it: the insert is against a foreign key.
        if (this.store.roomExists(row.roomId)) {
          this.store.upsertRow(late);
          result.synced += 1;
        } else {
          result.orphaned += 1;
        }
        continue;
      }
      this.store.removeRow(row.roomId);
      result.removed += 1;
    }

    return result;
  }
}
