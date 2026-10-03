/** Real SQLite commits, including native outer transactions, are the observer authority. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import {
  canvasDocChannels,
  canvasDocGrants,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import {
  subscribeCommittedDocEvents,
  queueCommittedDocChannel,
  type CommittedDocEventListener,
} from '../committed-events.js';
import { DocChannelStore } from '../store.js';

const NOW = '2026-10-01T12:00:00.000Z';
const databases: Db[] = [];
const subscriptions: (() => void)[] = [];
afterEach(() => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  for (const db of databases.splice(0)) if (db.$client.open) db.$client.close();
  vi.useRealTimers();
});

function fixture() {
  const db = createDb(':memory:');
  databases.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  store.initialize({ documentId: 'doc-1', scope: 'session:s1', createdAt: NOW, updatedAt: NOW });
  const viewer = vi.fn((_documentId: string): undefined => undefined);
  subscriptions.push(subscribeCommittedDocEvents(db, viewer));
  return { db, store, viewer };
}
function event(eventId = 'event-1', documentId = 'doc-1') {
  return {
    eventId,
    documentId,
    direction: 'upstream' as const,
    type: 'task.comment',
    payload: { text: 'private-page-body' },
    provenance: { viewer: 'private-viewer-id' },
    envelopeHash: `hash-${eventId}`,
    receivedAt: NOW,
  };
}
async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('committed document observers', () => {
  it('notifies only after commit with a document id and coalesces committed events', async () => {
    const { db, store, viewer } = fixture();
    db.transaction((tx) => {
      store.appendEvent(event(), tx);
      store.appendEvent(event('event-2'), tx);
      expect(viewer).not.toHaveBeenCalled();
    });
    expect(viewer).not.toHaveBeenCalled();
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
    expect(store.pageEvents('doc-1', 0, 10)).toHaveLength(2);
    expect(JSON.stringify(viewer.mock.calls)).not.toContain('private-');
  });

  it('suppresses a raw outer rollback even after a successful nested store transaction', async () => {
    const { db, store, viewer } = fixture();
    expect(() =>
      db.transaction(() => {
        store.transaction((tx) => store.appendEvent(event(), tx));
        throw new Error('outer rollback');
      })
    ).toThrow('outer rollback');
    await flush();
    expect(viewer).not.toHaveBeenCalled();
    expect(store.getEvent('doc-1', 'event-1')).toBeUndefined();
  });

  it('suppresses failed nested savepoints while retaining a separately committed event', async () => {
    const { db, store, viewer } = fixture();
    store.initialize({ documentId: 'doc-2', scope: 'session:s1', createdAt: NOW, updatedAt: NOW });
    await flush();
    viewer.mockClear();
    db.transaction((tx) => {
      expect(() =>
        tx.transaction((nested) => {
          store.appendEvent(event('rolled-back', 'doc-2'), nested);
          throw new Error('nested rollback');
        })
      ).toThrow('nested rollback');
      store.appendEvent(event('committed'), tx);
    });
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
    expect(store.getEvent('doc-2', 'rolled-back')).toBeUndefined();
    expect(store.getEvent('doc-1', 'committed')?.docSeq).toBe(1);
  });

  it('shares observers across independent stores and Drizzle wrappers on one native connection', async () => {
    const { db, viewer } = fixture();
    const wrapper = drizzle(db.$client) as unknown as Db;
    new DocChannelStore(wrapper).appendEvent(event());
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
    const other = fixture();
    other.store.appendEvent(event());
    await flush();
    expect(viewer).toHaveBeenCalledTimes(1);
    expect(other.viewer).toHaveBeenCalledTimes(1);
  });

  it('keeps committed persistence and other viewers when an observer throws or returns a rejected thenable', async () => {
    const { db, store, viewer } = fixture();
    subscriptions.push(
      subscribeCommittedDocEvents(db, () => {
        throw new Error('observer failure');
      })
    );
    const asyncObserver = vi.fn(async () => {
      throw new Error('late observer failure');
    });
    subscriptions.push(
      subscribeCommittedDocEvents(db, asyncObserver as unknown as CommittedDocEventListener)
    );
    const later = vi.fn((_id: string): undefined => undefined);
    subscriptions.push(subscribeCommittedDocEvents(db, later));
    expect(() => store.appendEvent(event())).not.toThrow();
    await flush();
    expect(viewer).toHaveBeenCalledOnce();
    expect(asyncObserver).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(store.getEvent('doc-1', 'event-1')).toBeDefined();
  });

  it('observes only the exact persisted identity when rollback reuses an event id and sequence', async () => {
    const { db, store, viewer } = fixture();
    expect(() =>
      db.transaction((tx) => {
        store.appendEvent(event(), tx);
        throw new Error('rollback');
      })
    ).toThrow();
    db.$client
      .prepare(
        `INSERT INTO canvas_doc_events
      (document_id,event_id,doc_seq,direction,type,payload,envelope_hash,received_at,provenance)
      VALUES ('doc-1','event-1',1,'upstream','task.comment','{}','different-hash',?,'{}')`
      )
      .run(NOW);
    await flush();
    expect(viewer).not.toHaveBeenCalled();
  });

  it.each(['COMMIT', 'ROLLBACK'])(
    'waits across a manual BEGIN until %s instead of mistaking visible rows for committed rows',
    async (finish) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { db, store, viewer } = fixture();
      db.$client.exec('BEGIN');
      store.appendEvent(event());
      await flush();
      await vi.advanceTimersByTimeAsync(15);
      expect(viewer).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      db.$client.exec(finish);
      await vi.advanceTimersByTimeAsync(20);
      expect(viewer).toHaveBeenCalledTimes(finish === 'COMMIT' ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('cleans up a manual-transaction retry when the last subscriber leaves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { db, store, viewer } = fixture();
    db.$client.exec('BEGIN');
    store.appendEvent(event());
    await flush();
    subscriptions.pop()!();
    expect(vi.getTimerCount()).toBe(0);
    db.$client.exec('COMMIT');
    await vi.advanceTimersByTimeAsync(1000);
    expect(viewer).not.toHaveBeenCalled();
  });

  it('notifies a new revision-zero channel only after raw outer commit and ignores repeated initialize', async () => {
    const { db, store, viewer } = fixture();
    db.transaction((tx) =>
      store.initialize(
        {
          documentId: 'doc-2',
          scope: 'session:s1',
          createdAt: NOW,
          updatedAt: NOW,
        },
        tx
      )
    );
    expect(viewer).not.toHaveBeenCalled();
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-2']]);
    expect(store.getChannel('doc-2')).toMatchObject({ nextDocSeq: 1, stateRev: 0 });
    store.initialize({ documentId: 'doc-2', scope: 'session:s1', createdAt: NOW, updatedAt: NOW });
    expect(() =>
      db.transaction((tx) => {
        store.initialize(
          { documentId: 'doc-3', scope: 'session:s1', createdAt: NOW, updatedAt: NOW },
          tx
        );
        throw new Error('channel rollback');
      })
    ).toThrow();
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-2']]);
    expect(store.getChannel('doc-3')).toBeUndefined();
  });

  it('notifies grant creation and revocation without events, but ignores rollback at the same timestamp', async () => {
    const { db, store, viewer } = fixture();
    const grant = {
      grantId: 'grant-1',
      documentId: 'doc-1',
      routeId: 'route-1',
      normalizedRoute: { to: 'log' },
      routeHash: 'route-hash',
      declarationHash: 'declaration-hash',
      approvedBy: 'approval-record-1',
      approvalEvidence: { bindingHash: 'evidence-hash' },
      allowedTypes: ['task.comment'],
      limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
      createdAt: NOW,
    };
    expect(() =>
      db.transaction((tx) => {
        store.insertGrant(grant, tx);
        throw new Error('grant rollback');
      })
    ).toThrow();
    await flush();
    expect(viewer).not.toHaveBeenCalled();
    db.transaction((tx) => store.insertGrant(grant, tx));
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
    viewer.mockClear();
    expect(() =>
      db.transaction((tx) => {
        expect(store.revokeGrant(grant.grantId, 1, NOW, tx)).toBe(true);
        throw new Error('revoke rollback');
      })
    ).toThrow();
    await flush();
    expect(viewer).not.toHaveBeenCalled();
    expect(store.getGrant(grant.grantId)?.revokedAt).toBeNull();
    expect(store.revokeGrant(grant.grantId, 1, NOW)).toBe(true);
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
    expect(store.pageEvents('doc-1', 0, 10)).toEqual([]);
  });

  it('rejects a rolled-back grant identity even when a different row reuses its id and creation time', async () => {
    const { db, store, viewer } = fixture();
    const grant = {
      grantId: 'grant-1',
      documentId: 'doc-1',
      routeId: 'route-1',
      normalizedRoute: {},
      routeHash: 'old-hash',
      declarationHash: 'decl-hash',
      approvedBy: 'approval-record-1',
      approvalEvidence: {},
      allowedTypes: [],
      limits: {},
      createdAt: NOW,
    };
    expect(() =>
      db.transaction((tx) => {
        store.insertGrant(grant, tx);
        throw new Error('rollback');
      })
    ).toThrow();
    db.insert(canvasDocGrants)
      .values({ ...grant, routeHash: 'different-hash' })
      .run();
    await flush();
    expect(viewer).not.toHaveBeenCalled();
  });

  it('verifies changed declaration/hash evidence rather than a frozen updated timestamp', async () => {
    const { db, store, viewer } = fixture();
    expect(() =>
      db.transaction((tx) => {
        tx.update(canvasDocChannels)
          .set({ declarationHash: 'new-hash', updatedAt: NOW })
          .where(eq(canvasDocChannels.documentId, 'doc-1'))
          .run();
        queueCommittedDocChannel(db, store.getChannel('doc-1', tx)!);
        throw new Error('declaration rollback');
      })
    ).toThrow();
    await flush();
    expect(viewer).not.toHaveBeenCalled();
    db.transaction((tx) => {
      tx.update(canvasDocChannels)
        .set({ declarationHash: 'new-hash', updatedAt: NOW })
        .where(eq(canvasDocChannels.documentId, 'doc-1'))
        .run();
      queueCommittedDocChannel(db, store.getChannel('doc-1', tx)!);
    });
    await flush();
    expect(viewer.mock.calls).toEqual([['doc-1']]);
  });

  it('keeps separately registered copies of the same observer independent', async () => {
    const { db, store } = fixture();
    const listener = vi.fn((_id: string): undefined => undefined);
    const first = subscribeCommittedDocEvents(db, listener);
    subscriptions.push(subscribeCommittedDocEvents(db, listener));
    first();
    store.appendEvent(event());
    await flush();
    expect(listener).toHaveBeenCalledOnce();
  });
});
