import type { AdapterDelivery } from '../adapter-delivery.js';
/** Real Core GC/rebuild/reopen proofs; receipt clock never substitutes process lifetime. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import { RECEIPT_RETENTION_MS, type DeliveryReceiptStore } from '../delivery-receipt-store.js';
import { noopLogger, type AdapterRegistryLike, type DeliveryResult } from '../types.js';

const SUBJECT = 'relay.agent.example';
const LOCAL = { loginEnabled: false } as const;
const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const cores: RelayCore[] = [];
const databases = new Set<Db>();
const directories = new Set<string>();
const completions: Promise<void>[] = [];
async function fixture(database?: Db, directory?: string) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'receipt-lifecycle-'));
  directories.add(dir);
  const db = database ?? createDb(join(dir, 'db.sqlite'));
  runMigrations(db);
  databases.add(db);
  let now = 0;
  let resolve!: (result: DeliveryResult | null) => void;
  const promise = new Promise<DeliveryResult | null>((yes) => (resolve = yes));
  const registry = {
    deliver: vi.fn((subject: string) => (subject === SUBJECT ? promise : Promise.resolve(null))),
    setRelay() {},
    shutdown: async () => {},
  } satisfies AdapterRegistryLike;
  const notice = vi.fn();
  const warn = vi.fn();
  const relay = new RelayCore({
    db,
    dataDir: dir,
    adapterRegistry: registry,
    receiptNow: () => now,
    onDeadLetter: notice,
    logger: { ...noopLogger, warn },
    gcIntervalMs: 3_600_000,
    ttlSweepIntervalMs: 3_600_000,
  });
  cores.push(relay);
  const internals = relay as unknown as {
    gc: { deps: { pruneDeliveryReceipts: () => number } };
    publishPipeline: {
      deps: {
        receiptStore: DeliveryReceiptStore;
        adapterDelivery: {
          finishDetached: (...args: unknown[]) => Promise<void>;
          deliver: AdapterDelivery['deliver'];
        };
      };
    };
  };
  const adapter = internals.publishPipeline.deps.adapterDelivery;
  const actualFinish = adapter.finishDetached.bind(adapter);
  vi.spyOn(adapter, 'finishDetached').mockImplementation((...args) => {
    const completion = actualFinish(...args);
    completions.push(completion);
    return completion;
  });
  const refund = vi.fn();
  const actualDeliver = adapter.deliver.bind(adapter);
  vi.spyOn(adapter, 'deliver').mockImplementation((subject, envelope, builder, opts) => {
    const ownedRefund = opts?.refundTurn;
    return actualDeliver(subject, envelope, builder, {
      ...opts,
      refundTurn: ownedRefund
        ? () => {
            refund();
            ownedRefund();
          }
        : undefined,
    });
  });
  // Finish construction-time/ordinary GC before advancing the receipt-only clock.
  await relay.runGcSweep();
  return {
    relay,
    db,
    dir,
    registry,
    notice,
    warn,
    refund,
    resolve,
    clock: (value: number) => (now = value),
    store: internals.publishPipeline.deps.receiptStore,
    readyPrune: internals.gc.deps.pruneDeliveryReceipts,
  };
}
function options() {
  return { from: 'local-client', receiptContext: { ownerUserId: null, onReceiptCreated() {} } };
}
async function settled() {
  await Promise.resolve();
  await Promise.all(completions.splice(0));
}
function rows(db: Db, table: string) {
  return db.$client.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
}
afterEach(async () => {
  await settled();
  for (const db of databases)
    if (db.$client.open && db.$client.inTransaction) db.$client.exec('ROLLBACK');
  for (const core of cores.splice(0)) await core.close();
  vi.restoreAllMocks();
  for (const db of databases) if (db.$client.open) db.$client.close();
  databases.clear();
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
  directories.clear();
});

it('keeps unused Core constructor/sweeps out of a live database observer', async () => {
  const first = await fixture();
  const accepted = await first.relay.publish(SUBJECT, 'x', options());
  const before = rows(first.db, 'relay_receipt_observer_owner');
  const second = await fixture(first.db);
  expect((await second.relay.runGcSweep())?.receiptsPruned).toBe(0);
  expect(rows(first.db, 'relay_receipt_observer_owner')).toEqual(before);
  expect(first.relay.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
  expect(second.registry.deliver).not.toHaveBeenCalled();
});

it('prunes exactly one ordered 500-row batch then one, preserving unrelated storage', async () => {
  const value = await fixture();
  value.clock(RECEIPT_RETENTION_MS + 10);
  const future = await value.relay.publish(SUBJECT, 'future', options());
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const ids = Array.from({ length: 501 }, (_, i) => ({
    id: ID.slice(0, 24) + alphabet[Math.floor(i / 32)] + alphabet[i % 32],
    at: i % 2,
  }));
  // Seed the GC population in one fixture-only transaction; durable per-publish
  // acceptance is separately proven by the normal tracked publication above.
  const seed = value.db.$client.prepare(`INSERT INTO relay_delivery_receipts
    (message_id,subject,owner_user_id,state,boot_epoch,accepted_at,updated_at,expires_at)
    VALUES (?, ?, NULL, 'accepted', ?, ?, ?, ?)`);
  value.db.$client.transaction(() => {
    for (const { id, at } of [...ids].reverse()) {
      const acceptedAt = new Date(at).toISOString();
      seed.run(
        id,
        SUBJECT,
        value.store.ownerToken,
        acceptedAt,
        acceptedAt,
        new Date(at + RECEIPT_RETENTION_MS).toISOString()
      );
    }
  })();
  value.clock(2);
  value.store.settle(ids[0].id, { state: 'delivered' });
  value.store.settle(ids[1].id, { state: 'failed', code: 'at_capacity' });
  value.store.settle(ids[2].id, { state: 'outcome_unknown' });
  const expected = [...ids].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const inbox = 'relay.inbox.persistent-proof';
  const endpoint = await value.relay.registerEndpoint(inbox);
  const mail = await value.relay.publish(inbox, { sentinel: 'payload' }, { from: 'local-client' });
  const payloadPath = join(value.dir, 'mailboxes', endpoint.hash, 'new', mail.messageId + '.json');
  const payload = readFileSync(payloadPath);
  value.db.$client
    .prepare(
      `INSERT INTO session_message_acceptance_receipts
    (id,source_kind,source_id,source_generation,queue_message_id,session_id,agent_id,
    origin_runtime,origin_agent_path,origin_authority_digest,state,accepted_at)
    VALUES ('private','connector_event','source','generation','queue','session','agent',
    'claude-code','/agent','digest','accepted',?)`
    )
    .run(new Date().toISOString());
  value.db.$client
    .prepare(
      `INSERT INTO relay_traces
    (id,message_id,trace_id,subject,status,sent_at) VALUES ('trace','trace-message','trace-id',
    'relay.agent.other','delivered',?)`
    )
    .run(new Date().toISOString());
  const index = rows(value.db, 'relay_index');
  const traces = rows(value.db, 'relay_traces');
  const privateRows = rows(value.db, 'session_message_acceptance_receipts');
  value.clock(RECEIPT_RETENTION_MS + 1);
  const first = await value.relay.runGcSweep();
  expect(first?.receiptsPruned).toBe(500);
  expect(
    rows(value.db, 'relay_delivery_receipts')
      .map((row) => (row as { message_id: string }).message_id)
      .sort()
  ).toEqual([expected[500].id, future.messageId].sort());
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(1);
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(0);
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(1);
  expect(rows(value.db, 'relay_index')).toEqual(index);
  expect(rows(value.db, 'relay_traces')).toEqual(traces);
  expect(rows(value.db, 'session_message_acceptance_receipts')).toEqual(privateRows);
  expect(readFileSync(payloadPath)).toEqual(payload);
});

it('keeps expiry fixed through reads/actual settlement and hides it exactly before physical GC', async () => {
  const value = await fixture();
  const accepted = await value.relay.publish(SUBJECT, 'x', options());
  value.clock(1);
  expect(value.relay.getDeliveryReceipt(accepted.messageId, LOCAL)?.expiresAt).toBe(
    accepted.receipt?.expiresAt
  );
  value.resolve({ success: true });
  await settled();
  value.clock(RECEIPT_RETENTION_MS - 1);
  expect(value.relay.getDeliveryReceipt(accepted.messageId, LOCAL)).toMatchObject({
    state: 'delivered',
    expiresAt: accepted.receipt?.expiresAt,
  });
  value.clock(RECEIPT_RETENTION_MS);
  expect(value.relay.getDeliveryReceipt(accepted.messageId, LOCAL)).toBeNull();
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(1);
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(1);
  expect(rows(value.db, 'relay_delivery_receipts')).toEqual([]);
});

it('isolates failed receipt pruning while normal derived expiry proceeds, then retries', async () => {
  const value = await fixture();
  const accepted = await value.relay.publish(SUBJECT, 'x', options());
  value.clock(RECEIPT_RETENTION_MS);
  value.db.$client.exec(`CREATE TRIGGER block_prune BEFORE DELETE ON relay_delivery_receipts
    BEGIN SELECT RAISE(ABORT,'private failure detail'); END`);
  value.db.$client
    .prepare(
      `INSERT INTO relay_index
    (id,subject,endpoint_hash,status,created_at,expires_at) VALUES
    ('expired','relay.agent.other','*','delivered',?,?)`
    )
    .run(new Date(0).toISOString(), new Date(1).toISOString());
  const sweep = await value.relay.runGcSweep();
  expect(sweep?.receiptsPruned).toBe(0);
  expect(sweep?.expiredRemoved).toBe(1);
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(1);
  expect(value.warn).toHaveBeenCalledWith(
    'RelayGc: receipt retention phase failed: Delivery receipt status is unavailable.'
  );
  expect(JSON.stringify(value.warn.mock.calls)).not.toContain('private failure detail');
  value.db.$client.exec('DROP TRIGGER block_prune');
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(1);
  expect(value.relay.getDeliveryReceipt(accepted.messageId, LOCAL)).toBeNull();
});

it('refuses only receipt-phase caller transaction without committing or rolling it back', async () => {
  const value = await fixture();
  await value.relay.publish(SUBJECT, 'x', options());
  value.clock(RECEIPT_RETENTION_MS);
  value.db.$client.exec(
    "CREATE TEMP TABLE caller_sentinel (value TEXT); BEGIN; INSERT INTO caller_sentinel VALUES ('owned')"
  );
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(0);
  expect(value.db.$client.inTransaction).toBe(true);
  expect(value.db.$client.prepare('SELECT value FROM caller_sentinel').pluck().get()).toBe('owned');
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(1);
  value.db.$client.exec('ROLLBACK');
  expect(value.db.$client.prepare('SELECT count(*) FROM caller_sentinel').pluck().get()).toBe(0);
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(1);
});

it('preserves terminal receipt bytes through actual derived rebuild and database close/reopen', async () => {
  const value = await fixture();
  const accepted = await value.relay.publish(SUBJECT, 'x', options());
  value.resolve({ success: true });
  await settled();
  const snapshot = rows(value.db, 'relay_delivery_receipts');
  const inbox = 'relay.inbox.rebuild-proof';
  await value.relay.registerEndpoint(inbox);
  await value.relay.publish(inbox, 'payload', { from: 'local-client' });
  expect(await value.relay.rebuildIndex()).toBe(1);
  expect(rows(value.db, 'relay_delivery_receipts')).toEqual(snapshot);
  await value.relay.close();
  value.db.$client.close();
  const reopenedDb = createDb(join(value.dir, 'db.sqlite'));
  const reopened = await fixture(reopenedDb, value.dir);
  expect(reopened.relay.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('delivered');
  expect(rows(reopenedDb, 'relay_delivery_receipts')).toEqual(snapshot);
  expect(reopened.registry.deliver).not.toHaveBeenCalled();
});

it('late actual adapter success after Core GC cannot recreate a receipt or manufacture failure effects', async () => {
  const value = await fixture();
  const accepted = await value.relay.publish(SUBJECT, 'x', options());
  value.clock(RECEIPT_RETENTION_MS);
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(1);
  value.resolve({ success: true });
  await settled();
  expect(value.relay.getDeliveryReceipt(accepted.messageId, LOCAL)).toBeNull();
  expect(rows(value.db, 'relay_delivery_receipts')).toEqual([]);
  expect(value.registry.deliver).toHaveBeenCalledTimes(1);
  expect(value.notice).not.toHaveBeenCalled();
  expect(value.refund).not.toHaveBeenCalled();
  expect((await value.relay.runGcSweep())?.receiptsPruned).toBe(0);
});

it('closed observer callback cannot acquire or prune a successor, and active stale token blocks', async () => {
  const value = await fixture();
  await value.relay.publish(SUBJECT, 'first', options());
  await value.relay.close();
  const successor = await fixture(value.db);
  await successor.relay.publish(SUBJECT, 'next', options());
  successor.clock(RECEIPT_RETENTION_MS);
  const before = rows(value.db, 'relay_receipt_observer_owner');
  expect(value.readyPrune()).toBe(0);
  expect(await value.relay.runGcSweep()).toBeUndefined();
  expect(rows(value.db, 'relay_receipt_observer_owner')).toEqual(before);
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(2);
  const token = successor.store.ownerToken;
  value.db.$client
    .prepare('UPDATE relay_receipt_observer_owner SET owner_token=?')
    .run('stale-token');
  expect((await successor.relay.runGcSweep())?.receiptsPruned).toBe(0);
  expect(rows(value.db, 'relay_delivery_receipts')).toHaveLength(2);
  value.db.$client.prepare('UPDATE relay_receipt_observer_owner SET owner_token=?').run(token);
  expect((await successor.relay.runGcSweep())?.receiptsPruned).toBe(2);
});
