/**
 * `seq` allocation is the one non-obvious thing {@link RoomStore} owns, and the
 * spec's claim about it — "SQLite serialises writers, so `COALESCE(MAX(seq),0)+1`
 * inside the insert transaction is safe and needs no counter table" — is load
 * bearing. So it is proved here under REAL concurrency (worker threads writing
 * to the same file database at the same time), not just asserted sequentially.
 *
 * The other property proved here is an absence: the room log is never trimmed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { RoomStore, type NewRoomEntry } from '../room-store.js';
import { EVENT_LOG_MAX_EVENTS } from '../../session/event-log.js';

const require = createRequire(import.meta.url);
const ROOM_ID = 'room-1';

/** A minimal appendable entry; the caller supplies whatever it wants to vary. */
function entry(overrides: Partial<NewRoomEntry> & { id: string }): NewRoomEntry {
  return {
    roomId: ROOM_ID,
    authorId: 'author-1',
    kind: 'post',
    body: { text: 'hello' },
    mentions: [],
    sessionId: null,
    cascadeRoot: overrides.id,
    cascadeDepth: 0,
    createdAt: '2026-07-26T12:00:00.000Z',
    ...overrides,
  };
}

/** Seed a room so `appendEntry`'s `lastActivityAt` update has something to hit. */
function seedRoom(store: RoomStore, id = ROOM_ID): void {
  store.createRoom(
    {
      id,
      kind: 'channel',
      parentId: null,
      slug: id,
      title: `#${id}`,
      topic: null,
      workspaceId: null,
      rootEntryId: null,
      createdAt: '2026-07-26T11:00:00.000Z',
    },
    []
  );
}

describe('RoomStore seq allocation', () => {
  let db: Db;
  let store: RoomStore;

  beforeEach(() => {
    db = createTestDb();
    store = new RoomStore(db);
    seedRoom(store);
  });

  it('allocates 1, 2, 3 … with no gaps', () => {
    const seqs = ['a', 'b', 'c'].map((id) => store.appendEntry(entry({ id })).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('allocates per room, not globally', () => {
    seedRoom(store, 'room-2');
    expect(store.appendEntry(entry({ id: 'a' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'b', roomId: 'room-2' })).seq).toBe(1);
    expect(store.appendEntry(entry({ id: 'c' })).seq).toBe(2);
  });

  it('does not consume a seq when the insert rolls back', () => {
    store.appendEntry(entry({ id: 'a' }));
    // A duplicate entry id violates `room_entries_room_id_entry_id_unique`, so
    // the whole transaction rolls back — including the seq it had read.
    expect(() => store.appendEntry(entry({ id: 'a' }))).toThrow();
    expect(store.appendEntry(entry({ id: 'b' })).seq).toBe(2);
    expect(store.maxSeq(ROOM_ID)).toBe(2);
  });

  it('bumps the room activity in the same transaction as the entry', () => {
    store.appendEntry(entry({ id: 'a', createdAt: '2026-07-26T13:00:00.000Z' }));
    expect(store.getRoom(ROOM_ID)?.lastActivityAt).toBe('2026-07-26T13:00:00.000Z');
  });
});

describe('RoomStore never trims the log', () => {
  // Deliberately heavy: proving the absence of a trim means writing past the cap
  // through the real append path, which is 5000+ IMMEDIATE transactions. The
  // default 5s budget is not enough for that on a loaded machine, and a timeout
  // here would read as "the log trims" — the exact thing this test denies.
  it(`keeps more than EVENT_LOG_MAX_EVENTS (${EVENT_LOG_MAX_EVENTS}) entries`, () => {
    const store = new RoomStore(createTestDb());
    seedRoom(store);
    const total = EVENT_LOG_MAX_EVENTS + 5;
    for (let i = 0; i < total; i++) store.appendEntry(entry({ id: `e-${i}` }));

    // The in-memory EventLog and session_events both evict oldest at this cap.
    // A room that forgot what was said would not be a room, so this one does not.
    expect(store.maxSeq(ROOM_ID)).toBe(total);
    expect(store.listEntriesAfter(ROOM_ID, 0)).toHaveLength(total);
    expect(store.listEntries(ROOM_ID, { limit: 1, before: 2 })[0].seq).toBe(1);
  }, 60_000);
});

/**
 * The worker body. It mirrors `RoomStore.appendEntry`'s statements rather than
 * importing the store, because a worker cannot load this repo's TypeScript
 * without a build step — the point of these threads is to contend for the same
 * SQLite file at the same time, which is a property of the SQL, not the ORM.
 * The main thread writes through the real store into the same contention, so
 * the store's own path is exercised under it.
 */
const WORKER_SOURCE = `
const { workerData, parentPort } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 20000');

const readNext = db.prepare(
  'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM room_entries WHERE room_id = ?'
);
const insert = db.prepare(
  'INSERT INTO room_entries (room_id, seq, id, author_id, kind, body, mentions, session_id, cascade_root, cascade_depth, signature, created_at)' +
    " VALUES (?, ?, ?, ?, 'post', '{\\"text\\":\\"x\\"}', '[]', NULL, ?, 0, NULL, '2026-07-26T12:00:00.000Z')"
);
const append = db.transaction((entryId) => {
  const seq = readNext.get(workerData.roomId).next;
  insert.run(workerData.roomId, seq, entryId, 'author-1', entryId);
  return seq;
});

parentPort.postMessage({ ready: true });
parentPort.once('message', () => {
  const seqs = [];
  for (let i = 0; i < workerData.count; i++) {
    seqs.push(append.immediate(workerData.label + '-' + i));
  }
  db.close();
  parentPort.postMessage({ seqs });
});
`;

/** Spawn one writer thread and resolve once it has signalled readiness. */
function spawnWriter(opts: {
  dbPath: string;
  roomId: string;
  label: string;
  count: number;
}): Promise<{ worker: Worker; done: Promise<number[]> }> {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { ...opts, driver: require.resolve('better-sqlite3') },
  });
  return new Promise((resolve, reject) => {
    const done = new Promise<number[]>((resolveDone, rejectDone) => {
      worker.on('message', (msg: { ready?: boolean; seqs?: number[] }) => {
        if (msg.ready) {
          resolve({ worker, done });
        } else if (msg.seqs) {
          resolveDone(msg.seqs);
        }
      });
      worker.on('error', (err) => {
        rejectDone(err);
        reject(err);
      });
    });
  });
}

describe('RoomStore seq allocation under concurrent writers', () => {
  let dir: string;
  let dbPath: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-rooms-seq-'));
    dbPath = path.join(dir, 'rooms.db');
    db = createDb(dbPath);
    runMigrations(db);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never issues the same seq twice, and leaves no gaps', async () => {
    const store = new RoomStore(db);
    seedRoom(store);

    const perWriter = 20;
    const writers = await Promise.all(
      ['w1', 'w2', 'w3'].map((label) =>
        spawnWriter({ dbPath, roomId: ROOM_ID, label, count: perWriter })
      )
    );

    // All three threads are parked on the barrier. Release them and write from
    // this thread through the real store at the same time, so the drizzle path
    // is inside the contention rather than watching it.
    for (const { worker } of writers) worker.postMessage('go');
    const mine: number[] = [];
    for (let i = 0; i < perWriter; i++) {
      mine.push(store.appendEntry(entry({ id: `main-${i}` })).seq);
    }

    const theirs = await Promise.all(writers.map(({ done }) => done));
    await Promise.all(writers.map(({ worker }) => worker.terminate()));

    const all = [...mine, ...theirs.flat()].sort((a, b) => a - b);
    const expected = Array.from({ length: perWriter * 4 }, (_, i) => i + 1);

    expect(all).toEqual(expected);
    expect(new Set(all).size).toBe(all.length);
    expect(store.maxSeq(ROOM_ID)).toBe(perWriter * 4);
  }, 30_000);
});
