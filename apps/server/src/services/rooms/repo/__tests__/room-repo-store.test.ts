/**
 * The file-first contract of the room-repo store (ADR-0043, spec
 * `project-rooms` §3.1), and the reconciler that rebuilds its cache.
 *
 * The two ordering tests are the point of this file, and both were run red
 * before the implementation stood:
 *
 * - swapping `write()`'s two statements (row first, then the sidecar) reddens
 *   "writes the sidecar before the cache row",
 * - swapping `remove()`'s (sidecar first, then the row — which is what the
 *   WORKSPACE store does, and the mistake this store is easiest to "fix" into)
 *   reddens "drops the cache row before the sidecar".
 *
 * Both are observed on the real calls the store makes, not on a mock of the
 * store, so an implementation that reaches the disk some other way cannot pass
 * by accident.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'node:fs';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';
import {
  RoomRepoStore,
  ROOM_REPO_SIDECAR_FILENAME,
  InvalidRoomIdError,
} from '../room-repo-store.js';
import { RoomRepoReconciler } from '../room-repo-reconciler.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';

/** A minimal sidecar for `roomId`. */
function sidecarFor(roomId = ROOM_ID, overrides: Partial<RoomRepoSidecar> = {}): RoomRepoSidecar {
  return {
    roomId,
    mode: 'owned',
    createdAt: '2026-08-27T12:00:00.000Z',
    createdBy: 'author-operator',
    defaultBranch: 'main',
    caps: { maxFileBytes: 100, maxRepoBytes: 1000, maxRoomMdBytes: 10 },
    lastMergeSeq: null,
    ...overrides,
  };
}

/** Insert the bare minimum a `rooms` row needs, so the foreign key is satisfied. */
function seedRoom(db: Db, id = ROOM_ID): void {
  db.insert(rooms)
    .values({
      id,
      kind: 'channel',
      title: 'Release train',
      createdAt: '2026-08-27T12:00:00.000Z',
      lastActivityAt: '2026-08-27T12:00:00.000Z',
    })
    .run();
}

describe('RoomRepoStore', () => {
  let db: Db;
  let dorkHome: string;
  let store: RoomRepoStore;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-repo-'));
    store = new RoomRepoStore(db, dorkHome);
    seedRoom(db);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  describe('paths', () => {
    it('hangs the whole room home off {dorkHome}/rooms/<id>, sidecar outside the repo', () => {
      const home = path.join(dorkHome, 'rooms', ROOM_ID);
      expect(store.homeDir(ROOM_ID)).toBe(home);
      expect(store.sidecarPath(ROOM_ID)).toBe(path.join(home, ROOM_REPO_SIDECAR_FILENAME));
      expect(store.repoPath(ROOM_ID)).toBe(path.join(home, 'repo'));
      expect(store.worktreesPath(ROOM_ID)).toBe(path.join(home, 'worktrees'));
      // The trust boundary, stated as an assertion: the repo can never rewrite
      // its own grant because the grant is not inside it.
      expect(store.sidecarPath(ROOM_ID).startsWith(store.repoPath(ROOM_ID))).toBe(false);
    });

    it('refuses a room id that could be read as a path', () => {
      expect(() => store.homeDir('../../etc')).toThrow(InvalidRoomIdError);
      expect(() => store.sidecarPath('a/b')).toThrow(InvalidRoomIdError);
    });
  });

  describe('file-first ordering', () => {
    it('writes the sidecar before the cache row', async () => {
      const order: string[] = [];
      // Passthrough spies rather than stubs: the store must genuinely write the
      // file and genuinely insert the row, so what is under test is the ORDER
      // and not a mock's willingness to be called.
      const realRename = fsp.rename.bind(fsp);
      vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        order.push('sidecar');
        await realRename(from, to);
      });
      const realInsert = db.insert.bind(db);
      vi.spyOn(db, 'insert').mockImplementation((table) => {
        order.push('row');
        return realInsert(table);
      });

      await store.write(sidecarFor());

      expect(order).toEqual(['sidecar', 'row']);
    });

    it('drops the cache row before the sidecar', async () => {
      await store.write(sidecarFor());
      const order: string[] = [];
      const realRm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
        order.push('sidecar');
        await realRm(target, options);
      });
      const realDelete = db.delete.bind(db);
      vi.spyOn(db, 'delete').mockImplementation((table) => {
        order.push('row');
        return realDelete(table);
      });

      await store.remove(ROOM_ID);

      expect(order).toEqual(['row', 'sidecar']);
    });

    it('leaves both halves consistent after a write and a remove', async () => {
      await store.write(sidecarFor());
      expect(store.getRow(ROOM_ID)).toMatchObject({ roomId: ROOM_ID, mode: 'owned' });
      expect(await store.readSidecar(ROOM_ID)).toMatchObject({ roomId: ROOM_ID });

      await store.remove(ROOM_ID);
      expect(store.getRow(ROOM_ID)).toBeNull();
      expect(await store.readSidecar(ROOM_ID)).toBeNull();
      // The home directory itself survives a binding removal — only the delete
      // path takes files away.
      expect(existsSync(store.homeDir(ROOM_ID))).toBe(true);
    });

    it('removing a binding that was never there is not an error', async () => {
      await expect(store.remove(ROOM_ID)).resolves.toBeUndefined();
    });

    it('writes the sidecar atomically, as pretty JSON a person can read', async () => {
      await store.write(sidecarFor());
      const raw = await readFile(store.sidecarPath(ROOM_ID), 'utf-8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(JSON.parse(raw)).toMatchObject({ roomId: ROOM_ID, defaultBranch: 'main' });
      // No temp file left behind.
      const left = await fsp.readdir(store.homeDir(ROOM_ID));
      expect(left).toEqual([ROOM_REPO_SIDECAR_FILENAME]);
    });
  });

  describe('reading', () => {
    it('answers null for a sidecar this build cannot use, rather than throwing', async () => {
      await mkdir(store.homeDir(ROOM_ID), { recursive: true });
      // A binding a FUTURE build could write: `linked` mode, which the schema
      // refuses by name. A store that threw here would take the reconciler
      // down with it.
      await writeFile(
        store.sidecarPath(ROOM_ID),
        JSON.stringify({ ...sidecarFor(), mode: 'linked' }),
        'utf-8'
      );
      await expect(store.readSidecar(ROOM_ID)).resolves.toBeNull();

      await writeFile(store.sidecarPath(ROOM_ID), 'not json at all', 'utf-8');
      await expect(store.readSidecar(ROOM_ID)).resolves.toBeNull();
    });

    it('lists the home directories on disk, and nothing when there are none', async () => {
      await expect(store.listHomeDirs()).resolves.toEqual([]);
      await store.write(sidecarFor());
      await expect(store.listHomeDirs()).resolves.toEqual([ROOM_ID]);
    });
  });

  describe('removeHome', () => {
    it('takes the row and the whole directory, attachments included', async () => {
      await store.write(sidecarFor());
      await mkdir(path.join(store.homeDir(ROOM_ID), 'attachments'), { recursive: true });
      await mkdir(store.repoPath(ROOM_ID), { recursive: true });

      await store.removeHome(ROOM_ID);

      expect(store.getRow(ROOM_ID)).toBeNull();
      expect(existsSync(store.homeDir(ROOM_ID))).toBe(false);
    });
  });
});

describe('RoomRepoReconciler', () => {
  let db: Db;
  let dorkHome: string;
  let store: RoomRepoStore;
  let reconciler: RoomRepoReconciler;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-repo-'));
    store = new RoomRepoStore(db, dorkHome);
    reconciler = new RoomRepoReconciler(store);
    seedRoom(db);
  });

  afterEach(async () => {
    reconciler.stop();
    vi.restoreAllMocks();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it('rebuilds a row the cache lost, from the sidecar on disk', async () => {
    await store.write(sidecarFor());
    store.removeRow(ROOM_ID);
    expect(store.getRow(ROOM_ID)).toBeNull();

    await expect(reconciler.reconcile()).resolves.toEqual({ synced: 1, removed: 0, orphaned: 0 });
    expect(store.getRow(ROOM_ID)).toMatchObject({ roomId: ROOM_ID, mode: 'owned' });
  });

  it('refreshes a row that drifted from its sidecar', async () => {
    await store.write(sidecarFor());
    store.upsertRow(sidecarFor(ROOM_ID, { lastMergeSeq: 99 }));
    expect(store.getRow(ROOM_ID)?.lastMergeSeq).toBe(99);

    await reconciler.reconcile();

    expect(store.getRow(ROOM_ID)?.lastMergeSeq).toBeNull();
  });

  it('drops a row whose sidecar is gone — the tail of an interrupted remove', async () => {
    await store.write(sidecarFor());
    await fsp.rm(store.sidecarPath(ROOM_ID));

    await expect(reconciler.reconcile()).resolves.toEqual({ synced: 0, removed: 1, orphaned: 0 });
    expect(store.getRow(ROOM_ID)).toBeNull();
  });

  it('survives an orphaned sidecar without touching the foreign key or the files', async () => {
    // The case `packages/db/src/schema/rooms.ts` names: the room's row cascades
    // away and the directory does not. Re-inserting the cache row would violate
    // `room_repos.room_id`, so the sweep must not try.
    await store.write(sidecarFor());
    await mkdir(store.repoPath(ROOM_ID), { recursive: true });
    await writeFile(path.join(store.repoPath(ROOM_ID), 'ROOM.md'), '# work', 'utf-8');
    db.delete(rooms).run();
    expect(store.getRow(ROOM_ID)).toBeNull();

    const result = await reconciler.reconcile();

    expect(result).toEqual({ synced: 0, removed: 0, orphaned: 1 });
    // Nothing was deleted: a missing room row is not proof the operator wanted
    // this room's history and its agents' unmerged work destroyed.
    expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);
    expect(existsSync(path.join(store.repoPath(ROOM_ID), 'ROOM.md'))).toBe(true);
  });

  it('keeps reconciling the other rooms after meeting an orphan', async () => {
    const liveRoom = '01ROOMBBBBBBBBBBBBBBBBBBBB';
    seedRoom(db, liveRoom);
    await store.write(sidecarFor());
    await store.write(sidecarFor(liveRoom));
    db.delete(rooms).where(eq(rooms.id, ROOM_ID)).run();
    store.removeRow(liveRoom);

    const result = await reconciler.reconcile();

    expect(result).toEqual({ synced: 1, removed: 0, orphaned: 1 });
    expect(store.getRow(liveRoom)).not.toBeNull();
  });

  it('does nothing at all on an install where no room has a home', async () => {
    await expect(reconciler.reconcile()).resolves.toEqual({ synced: 0, removed: 0, orphaned: 0 });
  });
});
