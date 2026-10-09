import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { RoomRepoSidecar } from '@dorkos/shared/room-repo';
import { RoomRepoStore } from '../room-repo-store.js';

const roomId = '01ROOMPERSISTENCEAAAAAAAAAA';
const metadata = (): RoomRepoSidecar => ({
  roomId,
  mode: 'owned',
  createdAt: '2026-10-04T00:00:00.000Z',
  createdBy: 'operator',
  defaultBranch: 'main',
  caps: { maxFileBytes: 100, maxRepoBytes: 1000, maxRoomMdBytes: 100 },
  lastMergeSeq: null,
});

// The legacy fixture producer is intentionally tested here. These controls do not
// claim the separate original installation context or acquired-reader assembly.
describe('RoomRepoStore finite persistence metadata', () => {
  let db: Db;
  let home: string;
  let store: RoomRepoStore;
  beforeEach(async () => {
    db = createTestDb();
    home = await fs.mkdtemp(path.join(tmpdir(), 'dorkos-room-persistence-budget-'));
    db.insert(rooms)
      .values({
        id: roomId,
        kind: 'channel',
        title: 'Persistence',
        createdAt: '2026-10-04T00:00:00.000Z',
        lastActivityAt: '2026-10-04T00:00:00.000Z',
      })
      .run();
    store = new RoomRepoStore(db, home);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    db.$client.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const unchanged = async (before: string) => {
    expect(await fs.readFile(store.sidecarPath(roomId), 'utf8')).toBe(before);
    expect(store.getRow(roomId)?.lastMergeSeq).toBeNull();
  };

  it('writes ordinary known metadata and retains the full cache row', async () => {
    await store.write(metadata());
    expect(JSON.parse(await fs.readFile(store.sidecarPath(roomId), 'utf8'))).toEqual(metadata());
    expect(store.getRow(roomId)).toMatchObject({ roomId, mode: 'owned', lastMergeSeq: null });
  });

  it('refuses accessor metadata without invoking getters or changing persisted state', async () => {
    await store.write(metadata());
    const before = await fs.readFile(store.sidecarPath(roomId), 'utf8');
    for (const nested of [false, true]) {
      const input = metadata();
      const getter = vi.fn(() => 'x'.repeat(128 * 1024));
      Object.defineProperty(nested ? input.caps! : input, nested ? 'maxFileBytes' : 'createdBy', {
        enumerable: true,
        get: getter,
      });
      await expect(store.write(input)).rejects.toThrow('plain data fields');
      expect(getter).not.toHaveBeenCalled();
      await unchanged(before);
    }
  });

  it('refuses symbol and hidden unknown fields rather than silently dropping them', async () => {
    await store.write(metadata());
    const before = await fs.readFile(store.sidecarPath(roomId), 'utf8');
    for (const key of [Symbol('unknown'), 'unknown']) {
      const input = metadata();
      Object.defineProperty(input, key, { value: 'hidden', enumerable: false });
      await expect(store.write(input)).rejects.toThrow('unsupported persistence fields');
      await unchanged(before);
    }
  });

  it('refuses outer and cap proxies before invoking any inspection trap', async () => {
    await store.write(metadata());
    const before = await fs.readFile(store.sidecarPath(roomId), 'utf8');
    for (const nested of [false, true]) {
      const input = metadata();
      const trap = vi.fn(() => {
        throw new Error('Proxy inspection executed');
      });
      const proxy = new Proxy(nested ? input.caps! : input, {
        get: trap,
        getPrototypeOf: trap,
        ownKeys: trap,
        getOwnPropertyDescriptor: trap,
      });
      if (nested) input.caps = proxy as RoomRepoSidecar['caps'];
      await expect(store.write(nested ? input : (proxy as RoomRepoSidecar))).rejects.toThrow(
        'plain metadata'
      );
      expect(trap).not.toHaveBeenCalled();
      await unchanged(before);
    }
  });

  it('refuses scalar and escaped UTF8 byte overflow before publication', async () => {
    await store.write(metadata());
    const before = await fs.readFile(store.sidecarPath(roomId), 'utf8');
    for (const createdBy of ['x'.repeat(65537), '\u0000'.repeat(12000), 'é'.repeat(40000)]) {
      await expect(store.write({ ...metadata(), createdBy })).rejects.toThrow(
        'persistence ceiling'
      );
      await unchanged(before);
    }
  });

  it('retains the captured metadata when caller data changes during publication', async () => {
    const input = metadata();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      input.createdBy = 'x'.repeat(128 * 1024);
      input.lastMergeSeq = 99;
      input.caps!.maxFileBytes = 999;
      return rename(from, to);
    });
    await store.write(input);
    expect(JSON.parse(await fs.readFile(store.sidecarPath(roomId), 'utf8'))).toEqual(metadata());
    expect(store.getRow(roomId)?.lastMergeSeq).toBeNull();
  });
});
