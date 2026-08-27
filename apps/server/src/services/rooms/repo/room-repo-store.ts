/**
 * File-first write-through persistence for room repos (ADR-0043, spec
 * `project-rooms` §3.1).
 *
 * `{dorkHome}/rooms/<roomId>/room-repo.json` is the truth; the `room_repos`
 * table is a derived cache. The sidecar is written BEFORE the row and deleted
 * AFTER it, and that ordering is the opposite of `WorkspaceStore.remove`'s on
 * purpose:
 *
 * - **Create.** A crash between the two leaves a sidecar with no row. The
 *   reconciler rebuilds the row from it, so the repo the operator asked for
 *   exists. The other order would leave a row pointing at a directory that was
 *   never bound.
 * - **Remove.** A crash between the two leaves a sidecar whose row is gone —
 *   the same recoverable state, healed the same way. The other order would
 *   delete the truth first and leave the derived row as the only record of a
 *   binding, which is precisely the thing a file-first store exists to prevent.
 *
 * So in both directions the sidecar is the last word: while it is on disk the
 * room has a repo, and no interrupted write can make the cache say otherwise
 * for longer than one reconcile.
 *
 * The layout this module owns, and nothing above it may construct by hand:
 *
 * ```
 * {dorkHome}/rooms/<roomId>/
 *   room-repo.json       <- the sidecar, OUTSIDE the repo (trust boundary)
 *   attachments/         <- LocalRoomAttachmentStore's, untouched here
 *   repo/                <- the room's main checkout
 *   worktrees/<agentSlug>/
 * ```
 *
 * @module server/services/rooms/repo/room-repo-store
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { roomRepos, rooms, type Db } from '@dorkos/db';
import { RoomRepoSidecarSchema, type RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { logger } from '../../../lib/logger.js';

/**
 * The file inside a room's home directory that records its repo.
 *
 * A constant rather than an inline string because the reconciler's directory
 * walk and the store's path builder must name the same file, and a typo in
 * either would look like "no room on this install has a repo".
 */
export const ROOM_REPO_SIDECAR_FILENAME = 'room-repo.json';

/**
 * The characters a room id may be made of before it reaches the filesystem.
 *
 * The same allowlist `LocalRoomAttachmentStore` applies to the same segment of
 * the same path, and an allowlist for the same reason: a room id arrives here
 * from a URL path segment, and the only safe way to know a string is not a path
 * is that it cannot contain one.
 */
const SAFE_ROOM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown when a room id could be read as a path. */
export class InvalidRoomIdError extends Error {
  constructor(roomId: string) {
    super(`Invalid room id: ${roomId}`);
    this.name = 'InvalidRoomIdError';
  }
}

/** Map a sidecar onto its derived cache row. */
function toRow(sidecar: RoomRepoSidecar): typeof roomRepos.$inferInsert {
  return {
    roomId: sidecar.roomId,
    mode: sidecar.mode,
    createdAt: sidecar.createdAt,
    lastMergeSeq: sidecar.lastMergeSeq,
  };
}

/**
 * File-first store for a room's repo binding.
 *
 * Construct with the DB handle and the resolved DorkOS data directory — never
 * `os.homedir()`, which is banned in `apps/server/src` (Hard Rule 3).
 */
export class RoomRepoStore {
  /** `{dorkHome}/rooms` — the same root the attachment store hangs off. */
  private readonly root: string;

  /**
   * Bind the store to one install's database and data directory.
   *
   * @param db - The consolidated DB handle.
   * @param dorkHome - The resolved DorkOS data directory. Required, no fallback.
   */
  constructor(
    private readonly db: Db,
    dorkHome: string
  ) {
    this.root = path.join(dorkHome, 'rooms');
  }

  /**
   * A room's home directory — the parent of its sidecar, its repo and its
   * worktrees.
   *
   * @param roomId - The room.
   * @throws {InvalidRoomIdError} When the id could be read as a path.
   */
  homeDir(roomId: string): string {
    if (!SAFE_ROOM_ID.test(roomId)) throw new InvalidRoomIdError(roomId);
    return path.join(this.root, roomId);
  }

  /**
   * Where a room's `room-repo.json` lives. Outside `repo/`, so the repo can
   * never rewrite its own grant.
   *
   * @param roomId - The room.
   */
  sidecarPath(roomId: string): string {
    return path.join(this.homeDir(roomId), ROOM_REPO_SIDECAR_FILENAME);
  }

  /**
   * Where a room's main checkout lives — the integration tree.
   *
   * @param roomId - The room.
   */
  repoPath(roomId: string): string {
    return path.join(this.homeDir(roomId), 'repo');
  }

  /**
   * Where a room's standing per-agent worktrees live.
   *
   * @param roomId - The room.
   */
  worktreesPath(roomId: string): string {
    return path.join(this.homeDir(roomId), 'worktrees');
  }

  /**
   * Persist the sidecar atomically, THEN upsert the cache row.
   *
   * Temp file plus rename, so a reader never sees half a sidecar and an
   * interrupted write leaves the previous one standing.
   *
   * @param sidecar - The binding to record.
   */
  async write(sidecar: RoomRepoSidecar): Promise<void> {
    const dir = this.homeDir(sidecar.roomId);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, this.sidecarPath(sidecar.roomId));
    this.upsertRow(sidecar);
  }

  /**
   * Upsert only the derived row — the reconciler's half of {@link write}.
   *
   * @param sidecar - The binding the row mirrors.
   */
  upsertRow(sidecar: RoomRepoSidecar): void {
    this.db
      .insert(roomRepos)
      .values(toRow(sidecar))
      .onConflictDoUpdate({ target: roomRepos.roomId, set: toRow(sidecar) })
      .run();
  }

  /**
   * Drop the cache row, THEN delete the sidecar — see the module doc for why
   * this order and not the workspace store's.
   *
   * Idempotent in both halves: removing a binding that is already gone is not
   * an error, which is what makes it safe for a delete path to call
   * unconditionally.
   *
   * @param roomId - The room whose binding goes away.
   */
  async remove(roomId: string): Promise<void> {
    this.removeRow(roomId);
    await fs.rm(this.sidecarPath(roomId), { force: true });
  }

  /**
   * Drop only the cache row — reconciler use, when a sidecar has vanished.
   *
   * @param roomId - The room.
   */
  removeRow(roomId: string): void {
    this.db.delete(roomRepos).where(eq(roomRepos.roomId, roomId)).run();
  }

  /**
   * The binding as the CACHE has it, or `null`.
   *
   * A row rather than the file, because this is what a request path reads and a
   * request path should not touch the disk to answer "does this room have a
   * repo". The row is rebuilt from the file every five minutes and written
   * through on every mutation, so the two disagree only inside an interrupted
   * write.
   *
   * @param roomId - The room.
   */
  getRow(roomId: string): typeof roomRepos.$inferSelect | null {
    return this.db.select().from(roomRepos).where(eq(roomRepos.roomId, roomId)).get() ?? null;
  }

  /** Every cached binding on this install. */
  listRows(): (typeof roomRepos.$inferSelect)[] {
    return this.db.select().from(roomRepos).all();
  }

  /**
   * Read a room's sidecar off disk — the source of truth.
   *
   * **`null` means "this room has no binding", and nothing else.** Two causes
   * qualify: the file is not there (`ENOENT`), and the file is not a sidecar
   * this build understands — which includes a `'linked'` binding a future build
   * wrote, since the schema refuses that by name and a reconciler that threw on
   * one would stop rebuilding every OTHER room's row on the install.
   *
   * **Every other error is raised.** This used to swallow all of them, and the
   * consequence was not a slow read: `null` is what the reconciler reads as "no
   * sidecar, retire the row", so one pass under file-descriptor pressure
   * (`EMFILE`), or against a directory the server had lost permission to
   * (`EACCES`), would have deleted the cache row of every room on the install.
   * A transient failure must not be spelled the same way as an answer.
   *
   * @param roomId - The room.
   * @returns The parsed sidecar, or `null` when the room has no binding.
   * @throws When the sidecar exists but could not be read.
   */
  async readSidecar(roomId: string): Promise<RoomRepoSidecar | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.sidecarPath(roomId), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      logger.error('[rooms] could not read a room-repo sidecar', {
        roomId,
        path: this.sidecarPath(roomId),
        err,
      });
      throw err;
    }
    // Past this line the file exists and was read: a failure is about its
    // CONTENT, which is a real answer about the binding rather than a fault.
    try {
      const parsed = RoomRepoSidecarSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
      logger.warn('[rooms] a room-repo sidecar is not one this build can use', {
        roomId,
        reason: parsed.error.issues[0]?.message,
      });
      return null;
    } catch (err) {
      logger.warn('[rooms] a room-repo sidecar is not valid JSON', { roomId, err });
      return null;
    }
  }

  /**
   * Every room id that has a home directory on disk, whether or not it holds a
   * sidecar or a row.
   *
   * The reconciler's starting point: the truth is what is on disk, so the sweep
   * walks the disk rather than the table it is rebuilding.
   *
   * An empty list means no room has ever had a home — `ENOENT` on the root,
   * which is every install until the first repo is enabled. Any other failure
   * is raised, for the same reason {@link RoomRepoStore.readSidecar} raises:
   * the reconciler reads "no homes on disk" as "retire every row", so a
   * permission or descriptor failure spelled as an empty list would empty the
   * cache table.
   *
   * @returns Room ids, or an empty list when no room has ever had a home.
   * @throws When the rooms root exists but could not be listed.
   */
  async listHomeDirs(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory() && SAFE_ROOM_ID.test(e.name)).map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      logger.error('[rooms] could not list the room homes', { root: this.root, err });
      throw err;
    }
  }

  /**
   * Delete leftover `.{uuid}.tmp` sidecar drafts in one room's home, older than
   * `maxAgeMs`.
   *
   * {@link RoomRepoStore.write} writes to a temp file and renames it, so a
   * process killed between the two leaves the draft behind forever — small, but
   * unbounded across an install's life, and confusing to anybody who opens the
   * directory. The sweep already reads this directory, so tidying costs one
   * `readdir` it was going to do anyway.
   *
   * Age-gated rather than absolute: a draft that is seconds old may belong to a
   * write happening right now, in this process or another.
   *
   * @param roomId - The room whose home to tidy.
   * @param maxAgeMs - How old a draft must be before it is removed.
   * @returns How many were removed.
   */
  async sweepStaleDrafts(roomId: string, maxAgeMs: number): Promise<number> {
    const dir = this.homeDir(roomId);
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      // Tidying is never the reason a sweep fails; the caller's real work has
      // its own error handling.
      return 0;
    }
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('.') || !name.endsWith('.tmp')) continue;
      const target = path.join(dir, name);
      try {
        const stat = await fs.stat(target);
        if (stat.mtimeMs > cutoff) continue;
        await fs.rm(target, { force: true });
        removed += 1;
      } catch {
        // Raced with somebody else's cleanup, or not ours to remove. Either way
        // the next pass asks again.
      }
    }
    return removed;
  }

  /**
   * Whether a room still exists — the question the reconciler must ask before
   * inserting a row, because `room_repos.room_id` is a real foreign key and an
   * orphaned sidecar would otherwise fail the sweep for every room after it.
   *
   * @param roomId - The room.
   */
  roomExists(roomId: string): boolean {
    return (
      this.db.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, roomId)).get() !== undefined
    );
  }

  /**
   * Delete a room's whole home directory — sidecar, repo, worktrees and all.
   *
   * **`Unguarded` is in the name as a warning.** This is the ONLY thing in the
   * domain that destroys work, and it asks nothing before doing it: the
   * unmerged-work question lives in `RoomRepoService.assertHomeRemovable`, and
   * `RoomRepoService.removeHome` is the guarded pair a caller should reach for.
   * A method called `removeHome` on a store reads like the counterpart of
   * `write`, which is exactly the misreading that would delete an agent's
   * unmerged work. The cache row goes first (via
   * {@link RoomRepoStore.remove}'s ordering rule) so an interrupted delete
   * cannot leave a row pointing at a directory that is half gone.
   *
   * **`attachments/` goes with it**, because it is inside the same home
   * directory — which is right for a hard delete (the files were posted into a
   * room that no longer exists) and is exactly why archiving must never reach
   * this function.
   *
   * @param roomId - The room whose home goes away.
   */
  async removeHomeUnguarded(roomId: string): Promise<void> {
    this.removeRow(roomId);
    await fs.rm(this.homeDir(roomId), { recursive: true, force: true });
  }
}
