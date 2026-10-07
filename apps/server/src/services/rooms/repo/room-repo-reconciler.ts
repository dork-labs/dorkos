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
import fs from 'node:fs/promises';
import type { Db } from '@dorkos/db';
import type { RoomService } from '../room-service.js';
import { requireRoomServiceFileWriteOwner } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import type { DocChannelStore } from '../../canvas/doc-channel/store.js';
import type { InstallationFileWrites } from '../../canvas/doc-channel/writes/installation-file-writes.js';
import { requireInstallationFileWritesOwner } from '../../canvas/doc-channel/writes/installation-file-writes.js';
import {
  readInstallationRoomFileWriteOwner,
  readInstallationRoomMaintenanceMutationContext,
  withRecognizedInstallationRoomNamespace,
  requireInstallationRoomWrites,
  requireInstallationRoomMutationTarget,
  readInstallationRoomMutationRoots,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import {
  requireOriginalHttpRoomReconcilerOwner,
  requireOriginalHttpRoomReconcilerAdmission,
} from '../../canvas/doc-channel/http-composition.js';
import {
  SAFE_ROOM_ID,
  requireRoomRepoStoreDatabase,
  readOriginalRoomRepoInventory,
  originalRoomRepoRoomExists,
  executeOriginalRoomRepoStoreRead,
  executeOriginalRoomRepoStoreUpsert,
  executeOriginalRoomRepoCacheRemove,
  type RoomRepoStore,
} from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import {
  executeOriginalRoomWorktreeReap,
  type RoomWorktreeManager,
} from './room-worktree-manager.js';

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
  /** Leftover sidecar drafts tidied away. */
  draftsRemoved: number;
  /**
   * What the worktree reap did across every room with a live binding.
   *
   * All zero when the sweep was built without a worktree manager — which is
   * only the case in the store's own tests; production always passes one.
   */
  worktrees: RoomWorktreeReapTotals;
}

/** The worktree reap's totals across one pass (spec `project-rooms` §3.4). */
export interface RoomWorktreeReapTotals {
  /** Working copies fully gone: directory removed AND branch retired. */
  reaped: number;
  /**
   * Working copies removed whose branch was kept because `main` lacks it.
   *
   * Counted apart from `reaped` rather than folded in: something was left
   * behind on purpose, and a total that hid it would report a tidy-up as
   * complete when it was not.
   */
  reapedTreeKeptBranch: number;
  /**
   * Working copies kept because they are in use or moved recently.
   *
   * Includes the ones whose agent is mid-turn — the sweep must not delete a
   * live turn's working directory.
   */
  spared: number;
  /**
   * Working copies kept because they hold work `main` does not have.
   *
   * The number a person should be shown: it is the room's unfinished business,
   * and it is what the explorer surfaces as stranded work (§3.6).
   */
  stranded: number;
}

type ReconcilerLifetime = Readonly<{ start: () => void; stop: () => Promise<void> }>;
const lifetimes = new WeakMap<RoomRepoReconciler, ReconcilerLifetime>();
type ReconcilerOwner = Readonly<{
  owner: InstallationFileWrites;
  writer: InstallationRoomWrites;
  db: Db;
  channels: DocChannelStore;
  repos: RoomRepoStore;
  mutex: RoomRepoMutex;
  rooms: RoomService;
  roomStore: RoomStore;
}>;
const originals = new WeakMap<RoomRepoReconciler, ReconcilerOwner>();
const maintenanceSources = new WeakMap<
  object,
  {
    reconciler: RoomRepoReconciler;
    binding: ReconcilerOwner;
    roomId: string;
    active: boolean;
    phase: 'cache' | 'reap';
  }
>();
const maintenanceContexts = new WeakMap<object, object>();
/** Require the Room reconciler's exact original owner dependencies. */
export function requireRoomRepoReconcilerOwner(
  value: RoomRepoReconciler,
  owner: InstallationFileWrites,
  db: Db,
  rooms: RoomService,
  repos: RoomRepoStore
): undefined {
  const binding = originals.get(value);
  if (
    !binding ||
    binding.owner !== owner ||
    binding.db !== db ||
    binding.rooms !== rooms ||
    binding.repos !== repos
  )
    throw new Error('Room reconciler lacks its exact original construction.');
  requireInstallationFileWritesOwner(owner, db, binding.channels);
  requireInstallationRoomWrites(binding.writer, owner, db, binding.channels, repos);
  requireRoomServiceFileWriteOwner(rooms, db, binding.roomStore);
  requireRoomRepoStoreDatabase(repos, db);
  if (originals.get(value) !== binding || db.$client.inTransaction)
    throw new Error('Room reconciler native lifetime changed.');
  return undefined;
}
/** Lookup of only an internally admitted operation, never a supplied readiness token. */
export function readOriginalRoomRepoMaintenanceSource(
  operation: object,
  reconciler: RoomRepoReconciler,
  writer: InstallationRoomWrites,
  roomId: string
): undefined {
  const actual = maintenanceSources.get(operation);
  if (
    !actual ||
    !actual.active ||
    actual.reconciler !== reconciler ||
    actual.binding.writer !== writer ||
    actual.roomId !== roomId
  )
    throw new Error('Room maintenance operation is foreign or retired.');
  const b = actual.binding;
  requireRoomRepoReconcilerOwner(reconciler, b.owner, b.db, b.rooms, b.repos);
  requireOriginalHttpRoomReconcilerOwner(b.owner, reconciler, b.db, b.rooms);
  if (!actual.active || maintenanceSources.get(operation) !== actual)
    throw new Error('Room maintenance operation retired.');
  return undefined;
}
/** Read DATA for the original Room repository maintenance operation. */
export function readOriginalRoomRepoMaintenanceOperation(
  context: InstallationRoomMutationContext,
  store: RoomRepoStore,
  db: Db
): Readonly<{ roomId: string; phase: 'cache' | 'reap' }> | undefined {
  const operation = maintenanceContexts.get(context),
    actual = operation && maintenanceSources.get(operation);
  if (!operation || !actual || actual.binding.repos !== store || actual.binding.db !== db)
    return undefined;
  readOriginalRoomRepoMaintenanceSource(
    operation,
    actual.reconciler,
    actual.binding.writer,
    actual.roomId
  );
  return Object.freeze({ roomId: actual.roomId, phase: actual.phase });
}

/** Captured constructor operations; public replacements cannot bypass drain. */
export function startRecognizedRoomRepoReconciler(value: RoomRepoReconciler): void {
  const lifetime = lifetimes.get(value);
  if (!lifetime) throw new Error('Room reconciler is not recognized');
  lifetime.start();
}

/** Stop the recognized Room repository reconciler. */
export function stopRecognizedRoomRepoReconciler(value: RoomRepoReconciler): Promise<void> {
  const lifetime = lifetimes.get(value);
  if (!lifetime) throw new Error('Room reconciler is not recognized');
  return lifetime.stop();
}

/** Periodically rebuilds the room-repo cache from the on-disk sidecars. */
export class RoomRepoReconciler {
  #timer: ReturnType<typeof setInterval> | null = null;

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
  #inFlight = false;

  /** Whether the current run of skipped ticks has already been logged. */
  #skippedTickLogged = false;

  /**
   * Bind the sweep to one install's store.
   *
   * @param store - The file-first store to read sidecars and write rows through.
   * @param intervalMs - How often to sweep. Defaults to five minutes.
   * @param worktrees - The worktree manager whose reap rides along with this
   *   pass, or `null` to run the cache half alone. **One sweep, one overlap
   *   guard**: the reap is not given a timer of its own, so an install can
   *   never have two passes walking the same directories.
   */
  constructor(
    store: RoomRepoStore,
    intervalMs: number = DEFAULT_INTERVAL_MS,
    worktrees: RoomWorktreeManager | null = null,
    owning?: ReconcilerOwner
  ) {
    this.#store = store;
    this.#intervalMs = intervalMs;
    this.#worktrees = worktrees;
    if (owning) {
      if (
        owning.repos !== store ||
        readInstallationRoomFileWriteOwner(owning.writer, store, owning.mutex) !== owning.owner
      )
        throw new Error('Room reconciler belongs to another installation.');
      originals.set(this, Object.freeze({ ...owning }));
      requireRoomRepoReconcilerOwner(this, owning.owner, owning.db, owning.rooms, store);
    }
    lifetimes.set(this, Object.freeze({ start: () => this.#start(), stop: () => this.#stop() }));
  }

  readonly #store: RoomRepoStore;
  readonly #intervalMs: number;
  readonly #worktrees: RoomWorktreeManager | null;
  #closed = false;
  #stopping: Promise<void> | undefined;
  readonly #active = new Set<Promise<RoomRepoReconcileResult>>();

  /** Start the periodic timer (unref'd so it never blocks process exit). */
  start(): void {
    this.#start();
  }

  #start(): void {
    if (this.#closed) throw new Error('Room reconciler is stopped');
    const binding = originals.get(this);
    if (binding)
      requireOriginalHttpRoomReconcilerAdmission(binding.owner, this, binding.db, binding.rooms);
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#runTick(), this.#intervalMs);
    this.#timer.unref();
  }

  /** Close admission and drain every actual admitted pass before DB disposal. */
  stop(): Promise<void> {
    return this.#stop();
  }

  #stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#closed = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    const pending = [...this.#active];
    this.#stopping = (async () => {
      const outcomes = await Promise.allSettled(pending);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') throw outcome.reason;
      }
    })();
    return this.#stopping;
  }

  /**
   * One tick: run a pass unless the previous one is still going.
   *
   * The guard is set before the pass starts and cleared in a `finally`, so a
   * pass that throws still releases it for the next tick.
   */
  #runTick(): void {
    if (this.#closed) return;
    if (this.#inFlight) {
      if (!this.#skippedTickLogged) {
        this.#skippedTickLogged = true;
        logger.debug('[rooms] repo reconcile tick skipped: the previous pass is still running');
      }
      return;
    }
    this.#inFlight = true;
    this.#skippedTickLogged = false;
    this.#admit()
      .catch((err) => logger.error('[rooms] repo reconciliation failed:', err))
      .finally(() => {
        this.#inFlight = false;
      });
  }

  /**
   * Run one reconcile pass.
   *
   * @returns What the pass changed, orphans included.
   */
  reconcile(): Promise<RoomRepoReconcileResult> {
    return this.#admit();
  }

  #admit(): Promise<RoomRepoReconcileResult> {
    if (this.#closed) return Promise.reject(new Error('Room reconciler is stopped'));
    const binding = originals.get(this);
    if (!binding)
      return Promise.reject(
        new Error('Room reconciliation requires its original installation assembly')
      );
    try {
      requireOriginalHttpRoomReconcilerAdmission(binding.owner, this, binding.db, binding.rooms);
    } catch (error) {
      return Promise.reject(error);
    }
    // Register before any observable store/FS call can reenter stop().
    const pending = Promise.resolve().then(() => this.#reconcile());
    this.#active.add(pending);
    void pending.then(
      () => this.#active.delete(pending),
      () => this.#active.delete(pending)
    );
    return pending;
  }

  async #reconcile(): Promise<RoomRepoReconcileResult> {
    const result: RoomRepoReconcileResult = {
      synced: 0,
      removed: 0,
      orphaned: 0,
      draftsRemoved: 0,
      worktrees: { reaped: 0, reapedTreeKeptBranch: 0, spared: 0, stranded: 0 },
    };
    const binding = originals.get(this)!;
    const inventory = readOriginalRoomRepoInventory(this.#store, binding.db);
    let before: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      before = await fs.lstat(inventory.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' && inventory.rows.length === 0)
        return result;
      throw error; // Missing inventory roots with cached rows are not deletion authority.
    }
    if (!before.isDirectory() || before.isSymbolicLink())
      throw new Error('Room cache root is not its original directory.');
    const entries = await fs.readdir(inventory.root, { withFileTypes: true });
    const after = await fs.lstat(inventory.root);
    if (before.dev !== after.dev || before.ino !== after.ino)
      throw new Error('Room cache root was replaced during inventory.');
    const roomIds = new Set(inventory.rows.map((row) => row.roomId));
    for (const entry of entries) {
      if (entry.isDirectory() && SAFE_ROOM_ID.test(entry.name)) roomIds.add(entry.name);
    }
    for (const roomId of roomIds) {
      if (this.#closed) break; // No new room scope after stop; already admitted scopes drain below.
      await withRecognizedInstallationRoomNamespace(binding.writer, roomId, async (handle) => {
        const operation = Object.freeze({});
        const record = {
          reconciler: this,
          binding,
          roomId,
          active: true,
          phase: 'cache' as 'cache' | 'reap',
        };
        maintenanceSources.set(operation, record);
        try {
          const context = readInstallationRoomMaintenanceMutationContext(
            binding.writer,
            roomId,
            handle,
            this,
            operation
          );
          maintenanceContexts.set(context, operation);
          const sidecar = await executeOriginalRoomRepoStoreRead(
            this.#store,
            binding.db,
            context,
            roomId
          );
          const roots = readInstallationRoomMutationRoots(context);
          requireInstallationRoomMutationTarget(context, roots.homePath);
          if (sidecar) {
            if (!originalRoomRepoRoomExists(this.#store, binding.db, roomId)) {
              result.orphaned += 1;
              logger.warn('[rooms] room repo has no room', {
                roomId,
                home: roots.homePath,
                note: 'left on disk',
              });
              requireInstallationRoomMutationTarget(context, roots.homePath);
              return;
            }
            executeOriginalRoomRepoStoreUpsert(this.#store, binding.db, context, sidecar);
            result.synced += 1;
          } else if (inventory.rows.some((row) => row.roomId === roomId)) {
            // Absence comes from the fresh retained-source read under this same room lease.
            executeOriginalRoomRepoCacheRemove(this.#store, binding.db, context, roomId);
            result.removed += 1;
          }
          if (
            sidecar &&
            this.#worktrees &&
            originalRoomRepoRoomExists(this.#store, binding.db, roomId)
          ) {
            record.phase = 'reap';
            const swept = await executeOriginalRoomWorktreeReap(this.#worktrees, roomId, context);
            result.worktrees.reaped += swept.reaped.length;
            result.worktrees.reapedTreeKeptBranch += swept.reapedTreeKeptBranch.length;
            result.worktrees.spared += swept.spared.length;
            result.worktrees.stranded += swept.stranded.length;
            requireInstallationRoomMutationTarget(context, roots.homePath);
          }
          requireInstallationRoomMutationTarget(context, roots.homePath);
        } finally {
          record.active = false;
          maintenanceSources.delete(operation);
        }
      });
    }
    // Unproven stale drafts are preserved; names and age are not acquisition receipts.
    return result;
  }
}
