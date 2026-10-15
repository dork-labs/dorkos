/** Genuine migrated source connection; absence stays absence under reflected replacement. */
import { afterEach, expect, it, vi } from 'vitest';
import { createDb, runMigrations, canvasDocuments, type Db } from '@dorkos/db';
import { DocChannelStore, requireOriginalDocumentRelayStore } from '../store.js';
const connections: Db[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

it('retains actual constructor store reads and same connection transaction', () => {
  const db = createDb(':memory:');
  connections.push(db);
  runMigrations(db);
  const store = new DocChannelStore(db);
  const original = requireOriginalDocumentRelayStore(store);
  const getBatch = vi.fn(() => ({ batchId: 'fabricated', status: 'accepted' }));
  const getEvent = vi.fn(() => ({ eventId: 'fabricated', direction: 'upstream' }));
  const transaction = vi.fn(() => 'fabricated');
  Object.assign(store, { getBatch, getEvent, transaction, db: {} });
  expect(original.getBatch('absent')).toBeUndefined();
  expect(original.getEvent('absent', 'absent')).toBeUndefined();
  expect(
    original.transaction((tx) => {
      expect(db.$client.inTransaction).toBe(true);
      return tx.select().from(canvasDocuments).all().length;
    })
  ).toBe(0);
  expect(getBatch).not.toHaveBeenCalled();
  expect(getEvent).not.toHaveBeenCalled();
  expect(transaction).not.toHaveBeenCalled();
  expect(db.$client.inTransaction).toBe(false);
});

it('refuses a forged store instead of probing caller methods', () => {
  const transaction = vi.fn();
  expect(() =>
    requireOriginalDocumentRelayStore({ transaction } as unknown as DocChannelStore)
  ).toThrow('DOCUMENT_RELAY_ORIGINAL_STORE_REQUIRED');
  expect(transaction).not.toHaveBeenCalled();
});
