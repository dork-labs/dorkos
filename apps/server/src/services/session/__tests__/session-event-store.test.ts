import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { createDb, runMigrations, sql, type Db } from '@dorkos/db';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import { SessionEventStore } from '../session-event-store.js';
import { SessionStateProjector } from '../session-state-projector.js';
import { reconstructHistoryFromEvents } from '../event-log-history.js';
import { EVENT_LOG_MAX_EVENTS } from '../event-log.js';

/** A minimal seq'd turn: turn_start(user) → text_delta → turn_end. */
function turn(startSeq: number, text: string): SessionEvent[] {
  return [
    { type: 'turn_start', seq: startSeq, userMessage: `msg ${startSeq}` } as SessionEvent,
    { type: 'text_delta', seq: startSeq + 1, text } as SessionEvent,
    { type: 'turn_end', seq: startSeq + 2 } as SessionEvent,
  ];
}

describe('SessionEventStore', () => {
  let db: Db;
  let store: SessionEventStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SessionEventStore(db);
  });

  it('round-trips a turn: readAll returns the events in seq order', () => {
    store.appendTurn('s1', turn(1, 'hello'));

    const events = store.readAll('s1');
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[0]!.type).toBe('turn_start');
    // JSON round-trip preserves union-member fields.
    expect((events[1] as Extract<SessionEvent, { type: 'text_delta' }>).text).toBe('hello');
  });

  it('isolates events by session id', () => {
    store.appendTurn('s1', turn(1, 'a'));
    store.appendTurn('s2', turn(1, 'b'));
    expect(store.readAll('s1')).toHaveLength(3);
    expect(store.readAll('s2')).toHaveLength(3);
    expect(store.readAll('unknown')).toEqual([]);
  });

  it('deleteSession wipes one session and leaves others intact', () => {
    store.appendTurn('s1', turn(1, 'a'));
    store.appendTurn('s2', turn(1, 'b'));

    store.deleteSession('s1');

    expect(store.readAll('s1')).toEqual([]);
    expect(store.maxSeq('s1')).toBe(0);
    // Sibling session is untouched.
    expect(store.readAll('s2')).toHaveLength(3);
  });

  it('deleteSession on an unknown session is a no-op', () => {
    expect(() => store.deleteSession('never-seen')).not.toThrow();
  });

  it('appendTurn is idempotent — a re-flush of the same seqs inserts no duplicates', () => {
    const t = turn(1, 'once');
    store.appendTurn('s1', t);
    store.appendTurn('s1', t); // recovery re-flush
    expect(store.readAll('s1').map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('maxSeq returns the highest retained seq, or 0 when empty', () => {
    expect(store.maxSeq('s1')).toBe(0);
    store.appendTurn('s1', turn(1, 'a'));
    store.appendTurn('s1', turn(4, 'b'));
    expect(store.maxSeq('s1')).toBe(6);
  });

  it('trims to the newest EVENT_LOG_MAX_EVENTS rows on append; maxSeq tracks the top', () => {
    // Append one event per row past the cap; each "turn" here is a single event
    // so the row count equals the seq count for an exact boundary check.
    const total = EVENT_LOG_MAX_EVENTS + 10;
    const events: SessionEvent[] = Array.from(
      { length: total },
      (_, i) => ({ type: 'text_delta', seq: i + 1, text: `d${i + 1}` }) as SessionEvent
    );
    // One transaction (one turn) that overflows the cap: trim runs inside it.
    store.appendTurn('s1', events);

    const retained = store.readAll('s1');
    expect(retained).toHaveLength(EVENT_LOG_MAX_EVENTS);
    // The OLDEST rows were dropped; the newest are kept.
    expect(retained[0]!.seq).toBe(total - EVENT_LOG_MAX_EVENTS + 1);
    expect(retained[retained.length - 1]!.seq).toBe(total);
    expect(store.maxSeq('s1')).toBe(total);
  });

  it('trim keeps exactly the newest N and is a no-op below the threshold', () => {
    const events: SessionEvent[] = Array.from(
      { length: 5 },
      (_, i) => ({ type: 'text_delta', seq: i + 1, text: `d` }) as SessionEvent
    );
    store.appendTurn('s1', events);

    store.trim('s1', 10); // fewer than 10 rows — no-op
    expect(store.readAll('s1')).toHaveLength(5);

    store.trim('s1', 2); // keep the newest 2
    expect(store.readAll('s1').map((e) => e.seq)).toEqual([4, 5]);
  });

  it('survives a NEW connection to the same on-disk file — the true restart bar (DOR-189)', () => {
    // The other "restart" tests dispose the projector against a still-open
    // :memory: db, which proves the read path but not durability across a
    // process boundary. This is the CI form of the acceptance criterion: write
    // through one better-sqlite3 connection to a real FILE, close it (process 1
    // exits), then open a SECOND connection on the same path exactly as boot
    // does (createDb + runMigrations) and prove the turn is still there.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dor189-store-'));
    const dbPath = path.join(dir, 'dork.db');
    try {
      // "Process 1": boot, persist one turn, shut down.
      const db1 = createDb(dbPath);
      runMigrations(db1);
      new SessionEventStore(db1).appendTurn('sess', turn(1, 'durable answer'));
      db1.$client.close();

      // "Process 2": fresh connection + boot-identical migration run.
      const db2 = createDb(dbPath);
      runMigrations(db2); // idempotent, exactly what index.ts does at startup
      const store2 = new SessionEventStore(db2);

      expect(store2.maxSeq('sess')).toBe(3);
      expect(store2.readAll('sess').map((e) => e.seq)).toEqual([1, 2, 3]);

      // A fresh projector hydrates from the reopened store and reconstructs
      // the identical history with stable ids.
      const revived = new SessionStateProjector('sess');
      revived.enablePersistence(store2);
      expect(revived.getCursor()).toBe(3);
      const history = reconstructHistoryFromEvents(revived.replayFrom(0));
      expect(history).toEqual([
        { id: 'user-1', role: 'user', content: 'msg 1' },
        { id: 'assistant-1', role: 'assistant', content: 'durable answer' },
      ]);
      db2.$client.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an unparseable row rather than throwing the whole read', () => {
    store.appendTurn('s1', turn(1, 'good'));
    // Poison one row's payload directly (simulates on-disk corruption).
    db.run(
      sql`UPDATE session_events SET payload = '{not json' WHERE session_id = 's1' AND seq = 2`
    );

    const events = store.readAll('s1');
    // The poisoned seq=2 is skipped; the surrounding turn events survive.
    expect(events.map((e) => e.seq)).toEqual([1, 3]);
  });
});
