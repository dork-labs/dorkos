/** Real Core/SQLite proofs for durable acceptance before delivery effects. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import type { AdapterRegistryLike, DeliveryResult, RelayOptions } from '../types.js';

const SUBJECT = 'relay.agent.example';
const LOCAL = { loginEnabled: false } as const;
const cores: RelayCore[] = [];
const dbs: Db[] = [];
const dirs: string[] = [];
function database(path = ':memory:'): Db {
  const db = createDb(path);
  runMigrations(db);
  dbs.push(db);
  return db;
}
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-core-'));
  dirs.push(dir);
  return dir;
}
function core(db: Db | undefined, options: Partial<RelayOptions> = {}) {
  const relay = new RelayCore({
    dataDir: directory(),
    db,
    gcIntervalMs: 3_600_000,
    ttlSweepIntervalMs: 3_600_000,
    ...options,
  });
  cores.push(relay);
  return relay;
}
function registry() {
  const deliver = vi.fn<AdapterRegistryLike['deliver']>(
    () => new Promise<DeliveryResult | null>(() => {})
  );
  return {
    deliver,
    shutdown: vi.fn(async () => {}),
    setRelay: vi.fn(),
  } satisfies AdapterRegistryLike;
}
function context(callback: (messageId: string) => void = vi.fn()) {
  return { ownerUserId: 'verified-owner', onReceiptCreated: callback };
}
function count(db: Db, table: string): unknown {
  return db.$client.prepare(`SELECT count(*) FROM ${table}`).pluck().get();
}
afterEach(async () => {
  for (const db of dbs) if (db.$client.inTransaction) db.$client.exec('ROLLBACK');
  for (const relay of cores.splice(0)) await relay.close();
  for (const db of dbs.splice(0)) db.$client.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('commits receipt and invokes locator before accounting, mailbox, subscriber and adapter effects', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, { adapterRegistry: adapters });
  const subscriber = vi.fn();
  relay.subscribe(SUBJECT, subscriber);
  const callback = vi.fn((id: string) => {
    expect(db.$client.inTransaction).toBe(false);
    expect(relay.getDeliveryReceipt(id, LOCAL)?.state).toBe('accepted');
    expect(count(db, 'relay_index')).toBe(0);
    expect(adapters.deliver).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
  });
  const result = await relay.publish(
    SUBJECT,
    { privateSentinel: 'payload' },
    { from: 'local-client', receiptContext: context(callback) }
  );
  expect(callback).toHaveBeenCalledExactlyOnceWith(result.messageId);
  expect(result.receipt).toMatchObject({ messageId: result.messageId, state: 'accepted' });
  expect(result.deliveredTo).toBe(2);
  expect(adapters.deliver).toHaveBeenCalledTimes(1);
  expect(subscriber).toHaveBeenCalledTimes(1);
  const envelope = adapters.deliver.mock.calls[0][1];
  expect(envelope).not.toHaveProperty('receiptContext');
  expect(envelope).not.toHaveProperty('ownerUserId');
  db.$client.exec('BEGIN');
  db.$client.exec('ROLLBACK');
  expect(relay.getDeliveryReceipt(result.messageId, LOCAL)?.state).toBe('accepted');
});

it('refuses caller transaction before any locator or effect, preserving caller rollback control', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, { adapterRegistry: adapters });
  const subscriber = vi.fn();
  relay.subscribe(SUBJECT, subscriber);
  const callback = vi.fn();
  db.$client.exec('BEGIN');
  await expect(
    relay.publish(SUBJECT, 'x', { from: 'local-client', receiptContext: context(callback) })
  ).rejects.toMatchObject({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' });
  expect(db.$client.inTransaction).toBe(true);
  db.$client.exec('ROLLBACK');
  expect(callback).not.toHaveBeenCalled();
  expect(adapters.deliver).not.toHaveBeenCalled();
  expect(subscriber).not.toHaveBeenCalled();
  expect(count(db, 'relay_index')).toBe(0);
  expect(count(db, 'relay_delivery_receipts')).toBe(0);
  expect(count(db, 'relay_receipt_observer_owner')).toBe(0);
});

it('initial insert failure has zero accounting, mailbox, subscriber, buffer and adapter effects', async () => {
  const db = database();
  const adapters = registry();
  const dataDir = directory();
  const relay = core(db, {
    dataDir,
    adapterRegistry: adapters,
    turnCeiling: { perAgent: () => 1, global: () => 1 },
  });
  await relay.registerEndpoint(SUBJECT);
  const subscriber = vi.fn();
  relay.subscribe(SUBJECT, subscriber);
  const callback = vi.fn();
  db.$client.exec(
    `CREATE TRIGGER fail_acceptance BEFORE INSERT ON relay_delivery_receipts BEGIN SELECT RAISE(ABORT,'private failure'); END`
  );
  await expect(
    relay.publish(SUBJECT, 'secret', { from: 'local-client', receiptContext: context(callback) })
  ).rejects.toMatchObject({ code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE' });
  expect(count(db, 'relay_index')).toBe(0);
  expect(count(db, 'relay_delivery_receipts')).toBe(0);
  expect(callback).not.toHaveBeenCalled();
  expect(adapters.deliver).not.toHaveBeenCalled();
  expect(subscriber).not.toHaveBeenCalled();
  const endpoint = relay.getEndpoint(SUBJECT)!;
  expect(readdirSync(join(dataDir, 'mailboxes', endpoint.hash, 'new'))).toEqual([]);
  // No buffered failed publish can be replayed into a later subscriber.
  const later = vi.fn();
  relay.subscribe(SUBJECT, later);
  expect(later).not.toHaveBeenCalled();
  db.$client.exec('DROP TRIGGER fail_acceptance');
  const control = await relay.publish(SUBJECT, 'control', {
    from: 'local-client',
    receiptContext: context(),
  });
  expect(control.receipt?.state).toBe('accepted');
  expect(adapters.deliver).toHaveBeenCalledTimes(1); // Failed insertion consumed no turn reservation.
});

it.each(['invalid', 'denied'] as const)(
  'creates no receipt or locator for %s validation/access refusal',
  async (mode) => {
    const db = database();
    const adapters = registry();
    const relay = core(db, { adapterRegistry: adapters });
    const callback = vi.fn();
    if (mode === 'denied')
      relay.addAccessRule({ from: 'local-client', to: SUBJECT, action: 'deny', priority: 100 });
    await expect(
      relay.publish(mode === 'invalid' ? 'relay.agent..bad' : SUBJECT, 'x', {
        from: 'local-client',
        receiptContext: context(callback),
      })
    ).rejects.toThrow();
    expect(count(db, 'relay_delivery_receipts')).toBe(0);
    expect(callback).not.toHaveBeenCalled();
    expect(adapters.deliver).not.toHaveBeenCalled();
  }
);

it.each(['same-handle', 'two-handles'] as const)(
  'blocks second Core using %s with zero loser effects',
  async (mode) => {
    const path = join(directory(), 'db.sqlite');
    const db = database(path);
    const secondDb = mode === 'same-handle' ? db : database(path);
    const firstAdapter = registry();
    const secondAdapter = registry();
    const first = core(db, { adapterRegistry: firstAdapter });
    const second = core(secondDb, { adapterRegistry: secondAdapter });
    const accepted = await first.publish(SUBJECT, 'x', {
      from: 'local-client',
      receiptContext: context(),
    });
    const callback = vi.fn();
    await expect(
      second.publish(SUBJECT, 'y', { from: 'local-client', receiptContext: context(callback) })
    ).rejects.toMatchObject({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' });
    expect(firstAdapter.deliver).toHaveBeenCalledTimes(1);
    expect(secondAdapter.deliver).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(first.getDeliveryReceipt(accepted.messageId, LOCAL)?.state).toBe('accepted');
    expect(count(db, 'relay_delivery_receipts')).toBe(1);
    // Detached terminal success is intentionally not asserted until task2.2's real settlement wiring.
  }
);

it.each([
  'budget_exceeded',
  'initiate_denied',
  'untrusted_bridge_principal',
  'rate_limited',
] as const)('persists %s gate failure before any adapter effect', async (code) => {
  const db = database();
  const adapters = registry();
  const relay = core(db, {
    adapterRegistry: adapters,
    ...(code === 'rate_limited'
      ? {
          reliability: {
            rateLimit: { enabled: true, windowSecs: 60, maxPerWindow: 0, perSenderOverrides: {} },
          },
        }
      : {}),
  });
  if (code === 'initiate_denied') relay.setInitiateConsentGate(() => ({ allowed: false }));
  const result = await relay.publish(SUBJECT, 'x', {
    from: code === 'untrusted_bridge_principal' ? 'relay.bridge.untrusted' : 'local-client',
    ...(code === 'budget_exceeded' ? { budget: { callBudgetRemaining: 0 } } : {}),
    receiptContext: context(),
  });
  expect(result.receipt).toMatchObject({ state: 'failed', failure: { code } });
  expect(adapters.deliver).not.toHaveBeenCalled();
});

it('registry no-match is failed without a dispatch, even when a subscriber handles the envelope', async () => {
  const db = database();
  const adapters = { ...registry(), getBySubject: () => undefined };
  const relay = core(db, { adapterRegistry: adapters });
  const subscriber = vi.fn();
  relay.subscribe(SUBJECT, subscriber);
  const result = await relay.publish(SUBJECT, 'x', {
    from: 'local-client',
    receiptContext: context(),
  });
  expect(result.deliveredTo).toBe(1);
  expect(result.receipt).toMatchObject({
    state: 'failed',
    failure: { code: 'adapter_unavailable' },
  });
  expect(adapters.deliver).not.toHaveBeenCalled();
  expect(subscriber).toHaveBeenCalledTimes(1);
});

it('agent no-match fails despite successful mailbox fanout, preserving deliveredTo', async () => {
  const db = database();
  const relay = core(db);
  await relay.registerEndpoint(SUBJECT);
  const result = await relay.publish(SUBJECT, 'x', {
    from: 'local-client',
    receiptContext: context(),
  });
  expect(result.deliveredTo).toBe(1);
  expect(result.receipt).toMatchObject({
    state: 'failed',
    failure: { code: 'adapter_unavailable' },
  });
});

it('ceiling refusal remains failed independently of successful mailbox fanout', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, {
    adapterRegistry: adapters,
    turnCeiling: { perAgent: () => 1, global: () => 1 },
  });
  await relay.registerEndpoint(SUBJECT);
  await relay.publish(SUBJECT, 'first', { from: 'local-client', receiptContext: context() });
  const result = await relay.publish(SUBJECT, 'second', {
    from: 'local-client',
    receiptContext: context(),
  });
  expect(result.deliveredTo).toBe(1);
  expect(result.receipt).toMatchObject({ state: 'failed', failure: { code: 'turn_ceiling' } });
  expect(adapters.deliver).toHaveBeenCalledTimes(1);
});

it('retains exact locator and conservatively records unknown after post-acceptance bookkeeping failure', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, { adapterRegistry: adapters });
  let locator = '';
  db.$client.exec(
    `CREATE TRIGGER fail_accounting BEFORE INSERT ON relay_index BEGIN SELECT RAISE(ABORT,'private sentinel'); END`
  );
  await expect(
    relay.publish(SUBJECT, 'x', {
      from: 'local-client',
      receiptContext: context((id) => {
        locator = id;
      }),
    })
  ).rejects.toThrow();
  expect(locator).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  expect(relay.getDeliveryReceipt(locator, LOCAL)).toMatchObject({
    state: 'outcome_unknown',
    failure: { code: 'observation_lost' },
  });
  expect(adapters.deliver).not.toHaveBeenCalled();
});

it('keeps injected DB open, retries failed Core release and conservatively closes pending observations', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, { adapterRegistry: adapters });
  const result = await relay.publish(SUBJECT, 'x', {
    from: 'local-client',
    receiptContext: context(),
  });
  db.$client.exec('BEGIN');
  await expect(relay.close()).rejects.toMatchObject({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' });
  db.$client.exec('ROLLBACK');
  const next = core(db);
  await expect(
    next.publish(SUBJECT, 'x', { from: 'local-client', receiptContext: context() })
  ).rejects.toMatchObject({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' });
  await relay.close();
  expect(db.$client.open).toBe(true);
  expect(next.getDeliveryReceipt(result.messageId, LOCAL)?.state).toBe('outcome_unknown');
  expect(adapters.shutdown).toHaveBeenCalledTimes(1);
  await relay.close();
  expect(adapters.shutdown).toHaveBeenCalledTimes(1);
});

it('standalone migrates and closes its owned handle, reopening authoritative terminal metadata', async () => {
  const dir = directory();
  const relay = core(undefined, { dataDir: dir });
  const result = await relay.publish(SUBJECT, 'x', {
    from: 'local-client',
    receiptContext: context(),
  });
  const ownedHandle = (relay as unknown as { database: { db: Db } }).database.db.$client;
  await relay.close();
  expect(ownedHandle.open).toBe(false);
  const reopened = core(undefined, { dataDir: dir });
  expect(reopened.getDeliveryReceipt(result.messageId, LOCAL)?.state).toBe('failed');
});

it('untracked agent and non-agent publishes keep legacy response fields and do not acquire observers', async () => {
  const db = database();
  const relay = core(db);
  const plain = await relay.publish('relay.human.example', 'x', { from: 'local-client' });
  const agent = await relay.publish(SUBJECT, 'x', { from: 'local-client' });
  expect(plain).not.toHaveProperty('receipt');
  expect(agent).not.toHaveProperty('receipt');
  expect(count(db, 'relay_delivery_receipts')).toBe(0);
  expect(count(db, 'relay_receipt_observer_owner')).toBe(0);
});

it.each(['watcher', 'adapter'] as const)(
  'keeps owned DB open after %s shutdown failure and retries only unfinished cleanup',
  async (phase) => {
    const adapters = registry();
    const relay = core(undefined, { adapterRegistry: adapters });
    const internals = relay as unknown as {
      database: { db: Db };
      endpointDeps: { watcherManager: { closeAll: () => Promise<void> } };
    };
    const db = internals.database.db;
    const watcher = vi.spyOn(internals.endpointDeps.watcherManager, 'closeAll');
    if (phase === 'watcher') watcher.mockRejectedValueOnce(new Error('watcher shutdown failed'));
    else adapters.shutdown.mockRejectedValueOnce(new Error('adapter shutdown failed'));
    const accepted = await relay.publish(SUBJECT, 'x', {
      from: 'local-client',
      receiptContext: context(),
    });
    await expect(relay.close()).rejects.toThrow(`${phase} shutdown failed`);
    expect(db.$client.open).toBe(true);
    expect(db.$client.prepare('SELECT 1').pluck().get()).toBe(1);
    expect(count(db, 'relay_receipt_observer_owner')).toBe(0);
    expect(
      db.$client
        .prepare('SELECT state FROM relay_delivery_receipts WHERE message_id=?')
        .pluck()
        .get(accepted.messageId)
    ).toBe('outcome_unknown');
    await expect(relay.publish(SUBJECT, 'blocked', { from: 'local-client' })).rejects.toThrow(
      'closed'
    );
    expect(adapters.deliver).toHaveBeenCalledTimes(1);
    await relay.close();
    expect(db.$client.open).toBe(false);
    expect(watcher).toHaveBeenCalledTimes(phase === 'watcher' ? 2 : 1);
    expect(adapters.shutdown).toHaveBeenCalledTimes(phase === 'adapter' ? 2 : 1);
    await relay.close();
    expect(watcher).toHaveBeenCalledTimes(phase === 'watcher' ? 2 : 1);
  }
);

it('retains caller-owned DB after a failed shutdown and successful cleanup retry', async () => {
  const db = database();
  const adapters = registry();
  const relay = core(db, { adapterRegistry: adapters });
  adapters.shutdown.mockRejectedValueOnce(new Error('shutdown failed'));
  await expect(relay.close()).rejects.toThrow('shutdown failed');
  expect(db.$client.open).toBe(true);
  await relay.close();
  expect(db.$client.open).toBe(true);
  expect(db.$client.prepare('SELECT 1').pluck().get()).toBe(1);
  expect(adapters.shutdown).toHaveBeenCalledTimes(2);
});

it('coalesces concurrent close requests until one deferred shutdown completes before closing owned DB', async () => {
  const adapters = registry();
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const release = new Promise<void>((resolve) => {
    finish = resolve;
  });
  adapters.shutdown.mockImplementation(() => {
    started();
    return release;
  });
  const relay = core(undefined, { adapterRegistry: adapters });
  const db = (relay as unknown as { database: { db: Db } }).database.db;
  const a = relay.close();
  const b = relay.close();
  await entered;
  expect(adapters.shutdown).toHaveBeenCalledTimes(1);
  expect(db.$client.open).toBe(true);
  finish();
  await Promise.all([a, b]);
  expect(db.$client.open).toBe(false);
  expect(adapters.shutdown).toHaveBeenCalledTimes(1);
});
