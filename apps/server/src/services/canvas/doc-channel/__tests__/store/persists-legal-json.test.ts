import { NOW, LATER, open, channel, event, grant, batch } from './harness.js';
import { describe, expect, it } from 'vitest';
import { canvasDocChannels, eq } from '@dorkos/db';
import { DocChannelCorruptionError } from '../../store.js';

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

describe('bounded current replay row selections', () => {
  it('keeps document isolation, route order and fresh committed outcomes', () => {
    const { db, store } = open();
    channel(store);
    channel(store, 'document-2');
    store.appendEvent(event());
    store.appendEvent(event('document-2'));
    store.insertDelivery({
      documentId: 'document-1',
      eventId: 'event-1',
      routeId: 'z',
      status: 'pending',
      updatedAt: NOW,
    });
    store.insertDelivery({
      documentId: 'document-1',
      eventId: 'event-1',
      routeId: 'a',
      status: 'saved',
      updatedAt: NOW,
    });
    store.insertDelivery({
      documentId: 'document-2',
      eventId: 'event-1',
      routeId: 'foreign',
      status: 'saved',
      updatedAt: NOW,
    });
    store.transaction((tx) => {
      expect(store.readReplayEvents('document-1', ['event-1'], tx)).toEqual([
        store.getEvent('document-1', 'event-1', tx),
      ]);
      expect(store.readReplayDeliveries('document-1', ['event-1'], tx)).toEqual(
        store.listDeliveries('document-1', 'event-1', tx)
      );
      expect(
        store.readReplayDeliveries('document-1', ['event-1'], tx).map((row) => row.routeId)
      ).toEqual(['a', 'z']);
      expect(() => store.readReplayEvents('document-1', Array(401).fill('event-1'), tx)).toThrow(
        RangeError
      );
      expect(() =>
        store.readReplayDeliveries('document-1', Array(201).fill('event-1'), tx)
      ).toThrow(RangeError);
    });
    store.updateDelivery({
      documentId: 'document-1',
      eventId: 'event-1',
      routeId: 'z',
      expectedStatus: 'pending',
      changes: { status: 'superseded', updatedAt: LATER },
    });
    store.transaction((tx) => {
      expect(
        store
          .readReplayDeliveries('document-1', ['event-1'], tx)
          .find((row) => row.routeId === 'z')!.status
      ).toBe('superseded');
      expect(store.readReplayEvents('document-1', [], tx)).toEqual([]);
      expect(store.readReplayDeliveries('document-1', [], tx)).toEqual([]);
    });
    db.$client
      .prepare('UPDATE canvas_doc_events SET payload=? WHERE document_id=? AND event_id=?')
      .run('{invalid', 'document-1', 'event-1');
    expect(() =>
      store.transaction((tx) => store.readReplayEvents('document-1', ['event-1'], tx))
    ).toThrow(DocChannelCorruptionError);
  });
});
