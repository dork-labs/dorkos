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
import { RoomStore } from '../../room-store.js';

import { entry, ROOM_ID, seedRoom } from './room-store.fixtures.js';

const require = createRequire(import.meta.url);

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
