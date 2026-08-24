import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMessageQueue, eq, type Db } from '@dorkos/db';
import type { ClientContext } from '@dorkos/shared/additional-context';
import { MessageQueueStore, QUEUE_POSITION_STEP } from '../message-queue-store.js';

/** Enqueue with the fields a test does not care about filled in. */
function enqueue(
  store: MessageQueueStore,
  sessionId: string,
  content: string,
  extra: {
    clientId?: string;
    disposition?: 'queue' | 'steer' | 'stage';
    context?: ClientContext;
  } = {}
) {
  return store.enqueue({
    sessionId,
    content,
    clientId: extra.clientId ?? 'window-a',
    disposition: extra.disposition,
    context: extra.context,
  });
}

/** Every row of a session as `{ id, position }`, in stored order. */
function positions(db: Db, sessionId: string): { id: string; position: number }[] {
  return db
    .select({ id: sessionMessageQueue.id, position: sessionMessageQueue.position })
    .from(sessionMessageQueue)
    .where(eq(sessionMessageQueue.sessionId, sessionId))
    .orderBy(sessionMessageQueue.position)
    .all();
}

describe('MessageQueueStore', () => {
  let db: Db;
  let store: MessageQueueStore;

  beforeEach(() => {
    db = createTestDb();
    store = new MessageQueueStore(db);
  });

  describe('enqueue and list', () => {
    it('round-trips a message through SQLite with every field intact', () => {
      const context: ClientContext = { queued: true };
      const record = enqueue(store, 's1', 'run the tests', {
        clientId: 'window-b',
        disposition: 'steer',
        context,
      });

      expect(record.id).toMatch(/[0-9a-f-]{36}/);
      expect(record.content).toBe('run the tests');
      expect(record.disposition).toBe('steer');
      expect(record.enqueuedBy).toBe('window-b');
      expect(record.enqueuedAt).toBeGreaterThan(0);
      expect(record.context).toEqual(context);

      // Read back through a SECOND store instance: nothing may live in memory.
      const reread = new MessageQueueStore(db).list('s1');
      expect(reread).toEqual([record]);
    });

    it('defaults an absent disposition to queue and an absent context to null', () => {
      const record = enqueue(store, 's1', 'hello');
      expect(record.disposition).toBe('queue');
      expect(record.context).toBeNull();
    });

    it('appends in FIFO order with sparse positions', () => {
      const first = enqueue(store, 's1', 'one');
      const second = enqueue(store, 's1', 'two');
      const third = enqueue(store, 's1', 'three');

      expect(store.list('s1').map((r) => r.content)).toEqual(['one', 'two', 'three']);
      expect([first.position, second.position, third.position]).toEqual([
        QUEUE_POSITION_STEP,
        QUEUE_POSITION_STEP * 2,
        QUEUE_POSITION_STEP * 3,
      ]);
    });

    it('isolates queues by session', () => {
      enqueue(store, 's1', 'mine');
      enqueue(store, 's2', 'theirs');

      expect(store.list('s1').map((r) => r.content)).toEqual(['mine']);
      expect(store.list('s2').map((r) => r.content)).toEqual(['theirs']);
      expect(store.list('unknown')).toEqual([]);
    });

    it('accepts a caller-minted id so an ingress can promise one before writing', () => {
      const record = store.enqueue({
        sessionId: 's1',
        content: 'hi',
        clientId: 'window-a',
        id: 'known-id',
      });
      expect(record.id).toBe('known-id');
      expect(store.get('known-id')?.content).toBe('hi');
    });

    it('reads a poisoned context_json as no context rather than throwing', () => {
      const record = enqueue(store, 's1', 'hi');
      db.update(sessionMessageQueue)
        .set({ contextJson: '{not json' })
        .where(eq(sessionMessageQueue.id, record.id))
        .run();

      expect(store.list('s1')[0]!.context).toBeNull();
    });
  });

  describe('remove and updateContent', () => {
    it('removes one message and leaves the rest in order', () => {
      enqueue(store, 's1', 'one');
      const second = enqueue(store, 's1', 'two');
      enqueue(store, 's1', 'three');

      expect(store.remove(second.id)?.content).toBe('two');
      expect(store.list('s1').map((r) => r.content)).toEqual(['one', 'three']);
    });

    it('reports an unknown id rather than pretending it removed something', () => {
      expect(store.remove('nope')).toBeUndefined();
    });

    it('edits content in place, keeping position and identity', () => {
      const first = enqueue(store, 's1', 'run the tests');
      enqueue(store, 's1', 'then deploy');

      const edited = store.updateContent(first.id, 'run the tests twice');

      expect(edited?.content).toBe('run the tests twice');
      expect(edited?.position).toBe(first.position);
      expect(store.list('s1').map((r) => r.content)).toEqual([
        'run the tests twice',
        'then deploy',
      ]);
    });

    it('returns undefined when editing an unknown id', () => {
      expect(store.updateContent('nope', 'x')).toBeUndefined();
    });
  });

  describe('move', () => {
    it('reorders with before and after anchors', () => {
      const a = enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');
      const c = enqueue(store, 's1', 'c');

      store.move(c.id, { before: a.id });
      expect(store.list('s1').map((r) => r.content)).toEqual(['c', 'a', 'b']);

      store.move(c.id, { after: b.id });
      expect(store.list('s1').map((r) => r.content)).toEqual(['a', 'b', 'c']);
    });

    it('touches exactly ONE row while sparse gaps remain', () => {
      const a = enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');
      const c = enqueue(store, 's1', 'c');
      const before = new Map(positions(db, 's1').map((r) => [r.id, r.position]));

      store.move(c.id, { before: b.id });

      const changed = positions(db, 's1').filter((r) => before.get(r.id) !== r.position);
      expect(changed.map((r) => r.id)).toEqual([c.id]);
      // And it landed between its new neighbours rather than on top of one.
      expect(changed[0]!.position).toBeGreaterThan(before.get(a.id)!);
      expect(changed[0]!.position).toBeLessThan(before.get(b.id)!);
    });

    it('renumbers when the gap it would land in has closed', () => {
      const a = enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');
      const c = enqueue(store, 's1', 'c');
      // Close the gap: a and b become adjacent integers, so there is no integer
      // strictly between them for c to take.
      db.update(sessionMessageQueue)
        .set({ position: 10 })
        .where(eq(sessionMessageQueue.id, a.id))
        .run();
      db.update(sessionMessageQueue)
        .set({ position: 11 })
        .where(eq(sessionMessageQueue.id, b.id))
        .run();

      store.move(c.id, { after: a.id });

      // Order is what was asked for...
      expect(store.list('s1').map((r) => r.content)).toEqual(['a', 'c', 'b']);
      // ...and the whole session was respaced, so the next move has room again.
      expect(positions(db, 's1').map((r) => r.position)).toEqual([
        QUEUE_POSITION_STEP,
        QUEUE_POSITION_STEP * 2,
        QUEUE_POSITION_STEP * 3,
      ]);
    });

    it('moving before the head puts a message at the front', () => {
      const a = enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');

      store.move(b.id, { before: a.id });

      expect(store.list('s1').map((r) => r.content)).toEqual(['b', 'a']);
      expect(store.list('s1')[0]!.position).toBeGreaterThan(0);
    });

    it('moving a message onto itself is a no-op', () => {
      enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');
      const before = positions(db, 's1');

      expect(store.move(b.id, { after: b.id })?.id).toBe(b.id);

      expect(positions(db, 's1')).toEqual(before);
      expect(store.list('s1').map((r) => r.content)).toEqual(['a', 'b']);
    });

    it('refuses an unknown message, an unknown anchor, and an anchor in another session', () => {
      const a = enqueue(store, 's1', 'a');
      const elsewhere = enqueue(store, 's2', 'elsewhere');

      expect(store.move('nope', { before: a.id })).toBeUndefined();
      expect(store.move(a.id, { before: 'nope' })).toBeUndefined();
      expect(store.move(a.id, { after: elsewhere.id })).toBeUndefined();
      // Nothing moved between sessions.
      expect(store.list('s2').map((r) => r.content)).toEqual(['elsewhere']);
    });
  });

  describe('clear', () => {
    it('returns the removed rows IN ORDER and empties the queue', () => {
      enqueue(store, 's1', 'one');
      enqueue(store, 's1', 'two');
      enqueue(store, 's1', 'three');
      enqueue(store, 's2', 'other session');

      const removed = store.clear('s1');

      expect(removed.map((r) => r.content)).toEqual(['one', 'two', 'three']);
      expect(store.list('s1')).toEqual([]);
      // A sibling session keeps its queue.
      expect(store.list('s2').map((r) => r.content)).toEqual(['other session']);
    });

    it('returns the reordered order, not the enqueue order', () => {
      const a = enqueue(store, 's1', 'a');
      const b = enqueue(store, 's1', 'b');
      store.move(b.id, { before: a.id });

      expect(store.clear('s1').map((r) => r.content)).toEqual(['b', 'a']);
    });

    it('is empty and harmless for a session with no queue', () => {
      expect(store.clear('never-used')).toEqual([]);
    });
  });

  describe('rekeySession', () => {
    it('moves every row onto the canonical id, preserving order', () => {
      enqueue(store, 'request-uuid', 'one');
      enqueue(store, 'request-uuid', 'two');
      enqueue(store, 'request-uuid', 'three');

      store.rekeySession('request-uuid', 'canonical');

      expect(store.list('request-uuid')).toEqual([]);
      expect(store.list('canonical').map((r) => r.content)).toEqual(['one', 'two', 'three']);
    });

    it('is a no-op when the ids match', () => {
      enqueue(store, 's1', 'one');
      const before = positions(db, 's1');

      store.rekeySession('s1', 's1');

      expect(positions(db, 's1')).toEqual(before);
      expect(store.list('s1').map((r) => r.content)).toEqual(['one']);
    });

    it('is a no-op when the source has no rows', () => {
      enqueue(store, 'canonical', 'already here');

      store.rekeySession('empty', 'canonical');

      expect(store.list('canonical').map((r) => r.content)).toEqual(['already here']);
    });

    it('is idempotent: re-running it changes nothing', () => {
      enqueue(store, 'request-uuid', 'one');
      enqueue(store, 'request-uuid', 'two');

      store.rekeySession('request-uuid', 'canonical');
      const afterFirst = positions(db, 'canonical');
      store.rekeySession('request-uuid', 'canonical');

      expect(positions(db, 'canonical')).toEqual(afterFirst);
      expect(store.list('canonical').map((r) => r.content)).toEqual(['one', 'two']);
    });

    it('appends behind rows the destination already has rather than interleaving', () => {
      enqueue(store, 'canonical', 'destination first');
      enqueue(store, 'request-uuid', 'source first');
      enqueue(store, 'request-uuid', 'source second');

      store.rekeySession('request-uuid', 'canonical');

      expect(store.list('canonical').map((r) => r.content)).toEqual([
        'destination first',
        'source first',
        'source second',
      ]);
    });
  });

  describe('listSessionIds', () => {
    it('names each session once, however many messages it is holding', () => {
      enqueue(store, 's1', 'one');
      enqueue(store, 's1', 'two');
      enqueue(store, 's2', 'three');

      expect(store.listSessionIds().sort()).toEqual(['s1', 's2']);
    });

    it('is empty when nothing is queued', () => {
      expect(store.listSessionIds()).toEqual([]);
    });
  });

  describe('deleteForSessions', () => {
    it('deletes every row of the named sessions and reports the count', () => {
      enqueue(store, 's1', 'one');
      enqueue(store, 's1', 'two');
      enqueue(store, 's2', 'three');
      enqueue(store, 's3', 'kept');

      expect(store.deleteForSessions(['s1', 's2'])).toBe(3);

      expect(store.list('s1')).toEqual([]);
      expect(store.list('s2')).toEqual([]);
      expect(store.list('s3').map((r) => r.content)).toEqual(['kept']);
    });

    it('does nothing for an empty list', () => {
      enqueue(store, 's1', 'one');
      expect(store.deleteForSessions([])).toBe(0);
      expect(store.list('s1')).toHaveLength(1);
    });
  });

  describe('durability', () => {
    it('survives a restart: rows written by one process are read by the next', () => {
      // A "restart" is a brand-new store over the SAME database handle holding
      // no in-memory state — the queue lives entirely in SQLite.
      enqueue(store, 's1', 'typed before the crash');
      enqueue(store, 's1', 'and this one too');

      const afterRestart = new MessageQueueStore(db);

      expect(afterRestart.list('s1').map((r) => r.content)).toEqual([
        'typed before the crash',
        'and this one too',
      ]);
    });
  });
});
