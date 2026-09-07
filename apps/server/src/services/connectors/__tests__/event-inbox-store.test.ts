import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  connections,
  connectorEventInbox,
  connectorEventReceipts,
  connectorEventSubscriptions,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { ConnectorProviderInstanceId } from '@dorkos/shared/connector-schemas';
import { ConnectorEventInboxStore } from '../event-inbox-store.js';

const INSTANCE_ID = 'provider_instance_events' as ConnectorProviderInstanceId;
const BASE = '2026-09-05T12:00:00.000Z';
const tempDirs: string[] = [];

/** Open a real SQLite file with one valid provider, connection, and subscription. */
function openFixture(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dorkos-connector-inbox-'));
  tempDirs.push(dir);
  const path = join(dir, 'dork.db');
  const db = createDb(path);
  runMigrations(db);
  db.insert(connectorProviderInstances)
    .values({
      id: INSTANCE_ID,
      type: 'test',
      mode: 'byo',
      displayName: 'Test',
      custody: 'managed',
      capabilityJson: '{}',
      status: 'available',
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  db.insert(connections)
    .values({
      id: 'connection-events',
      providerInstanceId: INSTANCE_ID,
      externalAccountRef: 'private-event-account',
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  db.insert(connectorEventSubscriptions)
    .values({
      id: 'subscription-1',
      connectionId: 'connection-events',
      agentId: 'agent-a',
      destinationKind: 'agent',
      destinationId: 'agent-a',
      eventType: 'message.received',
      filterJson: '{}',
      filterHash: 'filter-1',
      deliveryMode: 'direct',
      createdBy: 'operator',
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  return { db, path };
}

/** Enqueue one protected event using the common fixture values. */
function enqueue(store: ConnectorEventInboxStore, providerEventId = 'provider-event-1') {
  return store.enqueue({
    providerInstanceId: INSTANCE_ID,
    subscriptionId: 'subscription-1',
    providerEventId,
    payloadSchemaVersion: 1,
    normalizedPayload: '{"subject":"hello"}',
    payloadProtection: 'minimized',
    receivedAt: BASE,
    expiresAt: '2026-09-05T13:00:00.000Z',
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('ConnectorEventInboxStore', () => {
  it('persists the protected payload across restart and deduplicates provider redelivery', () => {
    const { db, path } = openFixture();
    const firstStore = new ConnectorEventInboxStore({ db });
    const first = enqueue(firstStore);
    expect(enqueue(firstStore)).toEqual({ id: first.id, inserted: false });
    db.$client.close();

    const reopened = createDb(path);
    const row = reopened.select().from(connectorEventInbox).get()!;
    expect(row).toMatchObject({
      id: first.id,
      state: 'received',
      attemptCount: 0,
      normalizedPayload: '{"subject":"hello"}',
      payloadProtection: 'minimized',
    });
    expect(reopened.select().from(connectorEventReceipts).all()).toHaveLength(1);
    reopened.$client.close();
  });

  it('allows only one worker to own an active lease and reclaims it after expiry', () => {
    const { db } = openFixture();
    const firstWorker = new ConnectorEventInboxStore({ db });
    const secondWorker = new ConnectorEventInboxStore({ db });
    enqueue(firstWorker);

    const first = firstWorker.claimNext(
      'worker-a',
      '2026-09-05T12:00:01.000Z',
      '2026-09-05T12:00:10.000Z'
    );
    expect(first).toMatchObject({ leaseOwner: 'worker-a', attemptCount: 1 });
    expect(
      secondWorker.claimNext('worker-b', '2026-09-05T12:00:05.000Z', '2026-09-05T12:00:15.000Z')
    ).toBeUndefined();

    const reclaimed = secondWorker.claimNext(
      'worker-b',
      '2026-09-05T12:00:11.000Z',
      '2026-09-05T12:00:21.000Z'
    );
    expect(reclaimed).toMatchObject({ id: first!.id, leaseOwner: 'worker-b', attemptCount: 2 });
    expect(firstWorker.markDispatched(first!.id, 'worker-a', BASE)).toBe(false);
    db.$client.close();
  });

  it('persists retry timing and completes only through the worker-owned state ladder', () => {
    const { db } = openFixture();
    const store = new ConnectorEventInboxStore({ db });
    enqueue(store);
    const first = store.claimNext(
      'worker-a',
      '2026-09-05T12:00:01.000Z',
      '2026-09-05T12:00:10.000Z'
    )!;
    expect(
      store.fail(
        first.id,
        'worker-a',
        '2026-09-05T12:00:02.000Z',
        'destination_offline',
        '2026-09-05T12:00:20.000Z'
      )
    ).toBe(true);
    expect(
      store.claimNext('worker-b', '2026-09-05T12:00:19.000Z', '2026-09-05T12:00:29.000Z')
    ).toBeUndefined();

    const retry = store.claimNext(
      'worker-b',
      '2026-09-05T12:00:20.000Z',
      '2026-09-05T12:00:30.000Z'
    )!;
    expect(retry.attemptCount).toBe(2);
    expect(store.markDispatched(retry.id, 'worker-b', '2026-09-05T12:00:21.000Z')).toBe(true);
    expect(
      store.complete(retry.id, 'worker-b', '2026-09-05T12:00:22.000Z', 'destination-receipt-1')
    ).toBe(true);
    expect(db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'completed',
      attemptCount: 2,
    });
    const receipts = db.select().from(connectorEventReceipts).all();
    expect(receipts.map((receipt) => receipt.state)).toEqual([
      'received',
      'leased',
      'retry_scheduled',
      'leased',
      'dispatched',
      'completed',
    ]);
    expect(receipts.at(-1)?.destinationReceiptId).toBe('destination-receipt-1');
    expect(JSON.stringify(receipts)).not.toContain('subject');
    db.$client.close();
  });

  it('quarantines a dispatched event after its lease expires without a blind resend', () => {
    const { db } = openFixture();
    const store = new ConnectorEventInboxStore({ db });
    const event = enqueue(store);
    expect(
      store.claimNext('worker-a', '2026-09-05T12:00:01.000Z', '2026-09-05T12:00:10.000Z')
    ).toBeDefined();
    expect(store.markDispatched(event.id, 'worker-a', '2026-09-05T12:00:02.000Z')).toBe(true);
    expect(
      store.claimNext('worker-b', '2026-09-05T12:00:09.000Z', '2026-09-05T12:00:19.000Z')
    ).toBeUndefined();
    expect(
      store.claimNext('worker-b', '2026-09-05T12:00:10.000Z', '2026-09-05T12:00:20.000Z')
    ).toBeUndefined();
    expect(db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'failed',
      failureCode: 'dispatch_outcome_unknown',
      attemptCount: 1,
      normalizedPayload: '{"subject":"hello"}',
    });
    expect(
      store.claimNext('worker-c', '2026-09-05T12:00:30.000Z', '2026-09-05T12:00:40.000Z')
    ).toBeUndefined();
    expect(store.sweepRetention('2026-09-05T13:00:00.000Z').cleared).toBe(1);
    db.$client.close();
  });

  it('rejects transitions from a worker whose lease has expired', () => {
    const { db } = openFixture();
    const store = new ConnectorEventInboxStore({ db });
    const event = enqueue(store);
    store.claimNext('worker-a', '2026-09-05T12:00:01.000Z', '2026-09-05T12:00:10.000Z');

    expect(store.markDispatched(event.id, 'worker-a', '2026-09-05T12:00:10.000Z')).toBe(false);
    expect(
      store.fail(
        event.id,
        'worker-a',
        '2026-09-05T12:00:11.000Z',
        'destination_offline',
        '2026-09-05T12:00:20.000Z'
      )
    ).toBe(false);

    const reclaimed = store.claimNext(
      'worker-b',
      '2026-09-05T12:00:11.000Z',
      '2026-09-05T12:00:21.000Z'
    )!;
    expect(store.markDispatched(reclaimed.id, 'worker-b', '2026-09-05T12:00:12.000Z')).toBe(true);
    expect(store.complete(reclaimed.id, 'worker-b', '2026-09-05T12:00:21.000Z')).toBe(false);
    db.$client.close();
  });

  it('expires an event before claim and erases its protected payload', () => {
    const { db } = openFixture();
    const store = new ConnectorEventInboxStore({ db });
    const event = enqueue(store);
    expect(
      store.claimNext('worker-a', '2026-09-05T13:00:00.000Z', '2026-09-05T13:00:10.000Z')
    ).toBeUndefined();
    expect(
      db.select().from(connectorEventInbox).where(eq(connectorEventInbox.id, event.id)).get()
    ).toMatchObject({
      state: 'expired',
      normalizedPayload: '',
      leaseOwner: null,
    });
    expect(db.select().from(connectorEventReceipts).all().at(-1)).toMatchObject({
      state: 'expired',
      destinationReceiptId: null,
    });
    db.$client.close();
  });
});

/** Regressions for early terminal deletion and idle all-state retention. */
describe('connector event content retention', () => {
  it.each(['completed', 'failed'] as const)(
    'clears payload immediately when %s without losing receipts',
    (outcome) => {
      const { db } = openFixture();
      const store = new ConnectorEventInboxStore({ db });
      const event = enqueue(store);
      store.claimNext('worker', BASE, '2026-09-05T12:01:00.000Z');
      if (outcome === 'completed') {
        expect(store.markDispatched(event.id, 'worker', BASE)).toBe(true);
        expect(store.complete(event.id, 'worker', BASE, 'exact-receipt')).toBe(true);
      } else {
        expect(store.fail(event.id, 'worker', BASE, 'destination_removed')).toBe(true);
      }
      expect(db.select().from(connectorEventInbox).get()).toMatchObject({
        id: event.id,
        state: outcome,
        normalizedPayload: '',
      });
      expect(db.select().from(connectorEventReceipts).all().at(-1)).toMatchObject({
        inboxId: event.id,
        state: outcome,
      });
      db.$client.close();
    }
  );

  it('erases residual terminal and idle payloads after restart without rewriting delivery truth', () => {
    const { db, path } = openFixture();
    const store = new ConnectorEventInboxStore({ db });
    for (const state of ['completed', 'failed', 'expired', 'received', 'leased', 'dispatched']) {
      const event = enqueue(store, state);
      db.$client
        .prepare('UPDATE connector_event_inbox SET state = ? WHERE id = ?')
        .run(state, event.id);
    }
    db.$client.close();
    const reopened = createDb(path);
    const resumed = new ConnectorEventInboxStore({ db: reopened });
    expect(resumed.sweepRetention('2026-09-05T13:00:00.000Z')).toEqual({ cleared: 6, expired: 3 });
    expect(resumed.sweepRetention('2026-09-05T13:00:01.000Z')).toEqual({ cleared: 0, expired: 0 });
    const rows = reopened.select().from(connectorEventInbox).all();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.normalizedPayload === '')).toBe(true);
    expect(rows.find((row) => row.providerEventId === 'completed')?.state).toBe('completed');
    expect(rows.find((row) => row.providerEventId === 'failed')?.state).toBe('failed');
    expect(reopened.select().from(connectorEventReceipts).all()).toHaveLength(9);
    reopened.$client.close();
  });
});

it('terminates after eight pre-dispatch attempts instead of retrying until the retention deadline', () => {
  const { db } = openFixture();
  const store = new ConnectorEventInboxStore({ db });
  const event = enqueue(store);
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = new Date(Date.parse(BASE) + attempt * 2_000).toISOString();
    const next = new Date(Date.parse(now) + 1_000).toISOString();
    expect(store.claimNext('worker', now, next)?.attemptCount).toBe(attempt + 1);
    expect(store.fail(event.id, 'worker', now, 'preparation_unavailable', next)).toBe(true);
  }
  expect(
    store.claimNext('ninth-worker', '2026-09-05T12:00:17.000Z', '2026-09-05T12:01:00.000Z')
  ).toBeUndefined();
  expect(db.select().from(connectorEventInbox).get()).toMatchObject({
    state: 'failed',
    normalizedPayload: '',
    attemptCount: 8,
  });
  db.$client.close();
});
