/** Real migrated SQLite proves transaction and recovery boundaries, not mocked query calls. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDb,
  runMigrations,
  canvasDocuments,
  canvasDocChannels,
  eq,
  type Db,
} from '@dorkos/db';
import {
  DocChannelStore,
  DocChannelCorruptionError,
  DocChannelClosedError,
  DocChannelStateConflictError,
} from '../store.js';

const NOW = '2026-10-01T12:00:00.000Z';
const LATER = '2026-10-01T12:01:00.000Z';
const connections: Db[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function open(file = ':memory:'): { db: Db; store: DocChannelStore } {
  const db = createDb(file);
  connections.push(db);
  runMigrations(db);
  return { db, store: new DocChannelStore(db) };
}
function filePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'doc-channel-store-'));
  directories.push(directory);
  return join(directory, 'channel.db');
}
function channel(store: DocChannelStore, documentId = 'document-1'): void {
  store.initialize({ documentId, scope: 'session:session-1', createdAt: NOW, updatedAt: NOW });
}
function event(documentId = 'document-1', eventId = 'event-1') {
  return {
    documentId,
    eventId,
    direction: 'upstream' as const,
    type: 'task.comment',
    payload: { text: 'Private content' },
    envelopeHash: 'a'.repeat(64),
    receivedAt: NOW,
    provenance: { transport: 'widget', actorId: 'person-1' },
  };
}
function grant(documentId = 'document-1') {
  return {
    grantId: `grant-${documentId}`,
    documentId,
    routeId: 'route-1',
    normalizedRoute: { on: 'task.*', to: 'agent:owner' },
    routeHash: 'b'.repeat(64),
    declarationHash: 'c'.repeat(64),
    approvedBy: 'person-1',
    approvalEvidence: { verdict: 'approved' },
    allowedTypes: ['task.comment'],
    limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    createdAt: NOW,
  };
}
function batch(documentId = 'document-1', batchId = 'batch-1') {
  return {
    batchId,
    documentId,
    scope: 'session:session-1',
    routeId: 'route-1',
    grantId: `grant-${documentId}`,
    grantRevision: 1,
    generation: 'generation-1',
    inputEventIds: ['event-1'],
    effectivePayload: { events: ['event-1'] },
    dueAt: NOW,
    status: 'pending' as const,
    createdAt: NOW,
    updatedAt: NOW,
  };
}
function seedBatch(store: DocChannelStore): void {
  channel(store);
  store.insertGrant(grant());
  store.appendEvent(event());
  store.insertBatch(batch());
}

function delivery() {
  return {
    documentId: 'document-1',
    eventId: 'event-1',
    routeId: 'route-1',
    batchId: 'batch-1',
    status: 'pending' as const,
    updatedAt: NOW,
  };
}

describe('DocChannelStore real SQLite boundaries', () => {
  it('initializes once, appends ordered document-local events and bounds replay pages', () => {
    const { store } = open();
    channel(store);
    store.initialize({
      documentId: 'document-1',
      scope: 'session:other',
      state: { wrong: true },
      createdAt: LATER,
      updatedAt: LATER,
    });
    expect(store.getChannel('document-1')).toMatchObject({
      scope: 'session:session-1',
      state: {},
      stateRev: 0,
      nextDocSeq: 1,
      retentionFloor: 1,
    });
    expect(store.appendEvent(event()).docSeq).toBe(1);
    expect(store.appendEvent(event('document-1', 'event-2')).docSeq).toBe(2);
    channel(store, 'document-2');
    expect(store.appendEvent(event('document-2')).docSeq).toBe(1);
    expect(store.pageEvents('document-1', 0, 1)).toHaveLength(1);
    expect(store.pageEvents('document-1', 0, 200, 1).map((row) => row.eventId)).toEqual([
      'event-1',
    ]);
    expect(store.pageEvents('document-1', 1, 200).map((row) => row.eventId)).toEqual(['event-2']);
    expect(() => store.pageEvents('document-1', 0, 201)).toThrow(RangeError);
    expect(() => store.pageEvents('document-1', -1, 1)).toThrow(RangeError);
    expect(store.getEvent('document-1', 'missing')).toBeUndefined();
  });

  it('rolls sequence/event/grant/batch/delivery mutations back when a real final write aborts', () => {
    const { db, store } = open();
    channel(store);
    db.$client.exec(`CREATE TRIGGER reject_channel_delivery BEFORE INSERT ON canvas_doc_deliveries
      BEGIN SELECT RAISE(ABORT, 'delivery storage refused'); END`);
    expect(() =>
      store.transaction((tx) => {
        store.appendEvent(event(), tx);
        store.insertGrant(grant(), tx);
        store.insertBatch(batch(), tx);
        store.insertDelivery(delivery(), tx);
      })
    ).toThrow('delivery storage refused');
    expect(store.getChannel('document-1')?.nextDocSeq).toBe(1);
    expect(store.pageEvents('document-1', 0, 200)).toEqual([]);
    expect(store.getGrant('grant-document-1')).toBeUndefined();
    expect(store.getBatch('batch-1')).toBeUndefined();
    expect(store.listDeliveries('document-1', 'event-1')).toEqual([]);
    db.$client.exec('DROP TRIGGER reject_channel_delivery');
    store.transaction((tx) => {
      store.appendEvent(event(), tx);
      store.insertGrant(grant(), tx);
      store.insertBatch(batch(), tx);
      store.insertDelivery(delivery(), tx);
    });
    expect(store.getEvent('document-1', 'event-1')?.docSeq).toBe(1);
    expect(store.listDeliveries('document-1', 'event-1')).toHaveLength(1);
  });

  it('does not consume a sequence when the event id already exists', () => {
    const { store } = open();
    channel(store);
    store.appendEvent(event());
    expect(() => store.appendEvent(event())).toThrow();
    expect(store.getChannel('document-1')?.nextDocSeq).toBe(2);
    expect(store.appendEvent(event('document-1', 'event-2')).docSeq).toBe(2);
  });

  it('two file connections allocate distinct sequences and one lease winner, then reject stale attempts', () => {
    const path = filePath();
    const first = open(path);
    seedBatch(first.store);
    const second = open(path);
    expect(second.store.appendEvent(event('document-1', 'event-2')).docSeq).toBe(2);
    expect(first.store.appendEvent(event('document-1', 'event-3')).docSeq).toBe(3);
    const lease = {
      batchId: 'batch-1',
      generation: 'generation-1',
      status: 'pending' as const,
      now: NOW,
      leaseUntil: LATER,
    };
    expect(first.store.acquireLease(lease)?.attempt).toBe(1);
    expect(second.store.acquireLease(lease)).toBeUndefined();
    expect(
      second.store.acquireLease({
        ...lease,
        generation: 'wrong',
        now: LATER,
        leaseUntil: '2026-10-01T12:02:00.000Z',
      })
    ).toBeUndefined();
    expect(
      second.store.acquireLease({ ...lease, now: LATER, leaseUntil: '2026-10-01T12:02:00.000Z' })
        ?.attempt
    ).toBe(2);
    expect(
      first.store.transitionBatch({
        batchId: 'batch-1',
        generation: 'generation-1',
        attempt: 1,
        expectedStatus: 'pending',
        status: 'accepted',
        updatedAt: LATER,
      })
    ).toBe(false);
    expect(
      second.store.transitionBatch({
        batchId: 'batch-1',
        generation: 'generation-1',
        attempt: 2,
        expectedStatus: 'pending',
        status: 'accepted',
        updatedAt: LATER,
      })
    ).toBe(true);
    expect(
      second.store.transitionBatch({
        batchId: 'batch-1',
        generation: 'wrong',
        attempt: 2,
        expectedStatus: 'accepted',
        status: 'dispatching',
        updatedAt: LATER,
      })
    ).toBe(false);
    expect(first.store.getBatch('batch-1')).toMatchObject({ status: 'accepted', attempt: 2 });
  });

  it('freezes accepted input and uses compare-and-set on delivery and grant evidence', () => {
    const { store } = open();
    seedBatch(store);
    store.insertDelivery(delivery());
    const merge = {
      batchId: 'batch-1',
      generation: 'generation-1',
      status: 'pending' as const,
      inputEventIds: ['event-1', 'event-2'],
      effectivePayload: { count: 2 },
      updatedAt: LATER,
    };
    expect(store.updatePendingBatch(merge)).toBe(true);
    expect(
      store.transitionBatch({
        batchId: 'batch-1',
        generation: 'generation-1',
        attempt: 0,
        expectedStatus: 'pending',
        status: 'accepted',
        updatedAt: LATER,
      })
    ).toBe(true);
    expect(store.updatePendingBatch({ ...merge, inputEventIds: ['changed'] })).toBe(false);
    expect(store.getBatch('batch-1')?.inputEventIds).toEqual(['event-1', 'event-2']);
    const update = {
      documentId: 'document-1',
      eventId: 'event-1',
      routeId: 'route-1',
      expectedStatus: 'pending' as const,
      changes: { status: 'waiting' as const, updatedAt: LATER },
    };
    expect(store.updateDelivery(update)).toBe(true);
    expect(store.updateDelivery(update)).toBe(false);
    expect(store.revokeGrant('grant-document-1', 2, LATER)).toBe(false);
    expect(store.revokeGrant('grant-document-1', 1, LATER)).toBe(true);
    expect(store.revokeGrant('grant-document-1', 1, LATER)).toBe(false);
  });

  it('state CAS and state event commit together; failed event insertion restores state and sequence', () => {
    const { db, store } = open();
    channel(store);
    const input = {
      documentId: 'document-1',
      expectedStateRev: 0,
      state: { done: true },
      event: { ...event(), direction: 'system' as const, type: 'state.changed' },
    };
    db.$client.exec(`CREATE TRIGGER reject_state_event BEFORE INSERT ON canvas_doc_events
      BEGIN SELECT RAISE(ABORT, 'state event storage refused'); END`);
    expect(() => store.replaceState(input)).toThrow('state event storage refused');
    expect(store.getChannel('document-1')).toMatchObject({ state: {}, stateRev: 0, nextDocSeq: 1 });
    db.$client.exec('DROP TRIGGER reject_state_event');
    expect(store.replaceState(input).docSeq).toBe(1);
    expect(store.getChannel('document-1')).toMatchObject({
      state: { done: true },
      stateRev: 1,
      nextDocSeq: 2,
    });
    expect(() => store.replaceState({ ...input, event: event('document-1', 'event-2') })).toThrow(
      DocChannelStateConflictError
    );
    expect(store.getChannel('document-1')?.stateRev).toBe(1);
    expect(store.pageEvents('document-1', 0, 200)).toHaveLength(1);
    expect(() =>
      store.replaceState({ ...input, expectedStateRev: 1, state: { huge: 'x'.repeat(256 * 1024) } })
    ).toThrow(TypeError);
    expect(store.getChannel('document-1')?.stateRev).toBe(1);
  });

  it('retains closure and accepted evidence after the physical document is removed', () => {
    const { db, store } = open();
    seedBatch(store);
    db.insert(canvasDocuments)
      .values({
        id: 'document-1',
        scope: 'session:session-1',
        content: { type: 'url', url: 'https://example.test' },
        title: 'Example',
        contentType: 'url',
        authorId: 'person-1',
        pinned: false,
        rev: 1,
        lastTouchedBy: 'person-1',
        lastTouchedAt: NOW,
        openedAt: NOW,
        lastActiveAt: NOW,
      })
      .run();
    store.transaction((tx) => {
      expect(store.markClosed('document-1', LATER, { reason: 'evicted' }, tx)).toBe(true);
      tx.delete(canvasDocuments).run();
    });
    expect(store.getChannel('document-1')).toMatchObject({
      closedAt: LATER,
      closureEvidence: { reason: 'evicted' },
    });
    expect(store.getEvent('document-1', 'event-1')).toBeDefined();
    expect(store.getBatch('batch-1')).toBeDefined();
    expect(store.markClosed('document-1', LATER, { reason: 'different' })).toBe(false);
    expect(() => store.appendEvent(event('document-1', 'event-2'))).toThrow(DocChannelClosedError);
  });

  it('restart preserves immutable batch generation, state and independent repair evidence', () => {
    const path = filePath();
    const { db, store } = open(path);
    seedBatch(store);
    store.insertIdentityIntent({
      intentId: 'move-1',
      documentId: 'document-1',
      fromScope: 'session:session-1',
      toScope: 'session:canonical',
      sourceId: 'batch-1',
      sourceGeneration: 'generation-1',
      evidence: { receiptId: null },
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
    });
    store.insertWriteIntent({
      intentId: 'write-1',
      documentId: 'document-1',
      eventId: 'write-event',
      envelopeHash: 'd'.repeat(64),
      grantId: 'grant-document-1',
      sourceIdentity: { file: 'tasks.md' },
      resolvedCwd: '/fixture',
      treeKind: 'agent-cwd',
      canonicalPath: '/fixture/tasks.md',
      operation: 'checkbox-toggle',
      input: { line: 1, done: true },
      beforeHash: 'before',
      afterHash: 'after',
      expectedVersion: 'version-1',
      status: 'prepared',
      createdAt: NOW,
      updatedAt: NOW,
    });
    db.$client.close();
    connections.splice(connections.indexOf(db), 1);
    const restarted = open(path).store;
    expect(restarted.getBatch('batch-1')).toMatchObject({
      generation: 'generation-1',
      admissionReceiptId: null,
    });
    expect(restarted.getChannel('document-1')).toMatchObject({ state: {}, nextDocSeq: 2 });
    expect(restarted.getIdentityIntent('move-1')).toMatchObject({
      sourceId: 'batch-1',
      sourceGeneration: 'generation-1',
    });
    expect(restarted.getWriteIntent('write-1')).toMatchObject({
      beforeHash: 'before',
      afterHash: 'after',
    });
    expect(
      restarted.transitionIdentityIntent('move-1', 'pending', {
        status: 'applied',
        errorCode: null,
        updatedAt: LATER,
      })
    ).toBe(true);
    expect(
      restarted.transitionIdentityIntent('move-1', 'pending', {
        status: 'failed',
        errorCode: 'stale',
        updatedAt: LATER,
      })
    ).toBe(false);
    expect(
      restarted.transitionWriteIntent('write-1', 'prepared', {
        status: 'replaced',
        errorCode: null,
        evidence: { verified: true },
        updatedAt: LATER,
      })
    ).toBe(true);
  });

  it.each(['{invalid', '{"__proto__":{"secret":"sensitive"}}', '{"number":1e999}', '[]', 'null'])(
    'reports malformed or unsafe persisted JSON as typed corruption without payload disclosure: %s',
    (raw) => {
      const { db, store } = open();
      channel(store);
      db.$client
        .prepare('UPDATE canvas_doc_channels SET state = ? WHERE document_id = ?')
        .run(raw, 'document-1');
      expect(() => store.getChannel('document-1')).toThrow(DocChannelCorruptionError);
      try {
        store.getChannel('document-1');
      } catch (error) {
        expect((error as Error).message).not.toContain(raw);
        expect((error as DocChannelCorruptionError).recordId).toBe('document-1');
      }
    }
  );

  it('rejects too-deep data and refuses asynchronous transaction callbacks without retaining writes', () => {
    const { store } = open();
    channel(store);
    let deep: unknown = {};
    for (let count = 0; count < 34; count++) deep = { nested: deep };
    expect(() => store.appendEvent({ ...event(), payload: deep })).toThrow(TypeError);
    expect(store.getChannel('document-1')?.nextDocSeq).toBe(1);
    expect(() =>
      // @ts-expect-error Promise callbacks are deliberately probed at the runtime boundary.
      store.transaction((tx) => {
        store.appendEvent(event(), tx);
        return Promise.resolve();
      })
    ).toThrow('must be synchronous');
    expect(store.getEvent('document-1', 'event-1')).toBeUndefined();
  });
});

it('persists legal JSON null event columns without violating SQLite NOT NULL', () => {
  const { store } = open();
  channel(store);
  store.appendEvent({ ...event(), payload: null, provenance: null });
  const reopened = store.getEvent('document-1', 'event-1')!;
  expect(reopened.payload).toBeNull();
  expect(reopened.provenance).toBeNull();
  expect(reopened.docSeq).toBe(1);
});

it('blocks a rejected transaction continuation and retained query handles after rollback', async () => {
  const { db, store } = open();
  channel(store);
  let continued: Promise<void> | undefined;
  let runLater: (() => unknown) | undefined;
  expect(() =>
    // @ts-expect-error Promise callbacks are deliberately probed at the runtime boundary.
    store.transaction((tx) => {
      const statement = tx
        .update(canvasDocChannels)
        .set({ nextDocSeq: 99 })
        .where(eq(canvasDocChannels.documentId, 'document-1'));
      runLater = () => statement.run();
      continued = Promise.resolve().then(() => {
        store.appendEvent(event(), tx);
      });
      return continued;
    })
  ).toThrow('must be synchronous');
  await expect(continued).rejects.toThrow('transaction is no longer active');
  expect(runLater).toThrow('transaction is no longer active');
  expect(db.select().from(canvasDocChannels).get()?.nextDocSeq).toBe(1);
  expect(store.getEvent('document-1', 'event-1')).toBeUndefined();
});

it('retires retained statements after a successful transaction too', () => {
  const { store } = open();
  channel(store);
  let runLater: (() => unknown) | undefined;
  store.transaction((tx) => {
    const statement = tx.update(canvasDocChannels).set({ nextDocSeq: 99 });
    runLater = () => statement.run();
  });
  expect(runLater).toThrow('transaction is no longer active');
  expect(store.getChannel('document-1')?.nextDocSeq).toBe(1);
});

it('persists JSON null batch payloads on insert and pending replacement', () => {
  const { store } = open();
  channel(store);
  store.insertGrant(grant());
  store.appendEvent(event());
  store.insertBatch({ ...batch(), effectivePayload: null });
  expect(store.getBatch('batch-1')?.effectivePayload).toBeNull();
  expect(
    store.updatePendingBatch({
      batchId: 'batch-1',
      generation: 'generation-1',
      status: 'pending',
      inputEventIds: ['event-1'],
      effectivePayload: null,
      updatedAt: LATER,
    })
  ).toBe(true);
  expect(store.getBatch('batch-1')?.effectivePayload).toBeNull();
});

it('rejects an async callback before its resumed write can escape rollback', async () => {
  const { store } = open();
  channel(store);
  expect(() =>
    // @ts-expect-error The unsafe callback is intentional runtime regression input.
    store.transaction(async (tx) => {
      await Promise.resolve();
      store.appendEvent(event(), tx);
    })
  ).toThrow('must be synchronous');
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(store.getEvent('document-1', 'event-1')).toBeUndefined();
  expect(store.getChannel('document-1')?.nextDocSeq).toBe(1);
});

it('retires a rolled-back savepoint handle before its outer transaction exits', () => {
  const { store } = open();
  channel(store);
  store.transaction((tx) => {
    let runLater: (() => unknown) | undefined;
    expect(() =>
      tx.transaction((nested) => {
        const statement = nested.update(canvasDocChannels).set({ nextDocSeq: 99 });
        runLater = () => statement.run();
        throw new Error('savepoint refused');
      })
    ).toThrow('savepoint refused');
    expect(runLater).toThrow('transaction is no longer active');
  });
  expect(store.getChannel('document-1')?.nextDocSeq).toBe(1);
});
