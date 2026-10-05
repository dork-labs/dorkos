/** Real Core/SQLite effect boundaries after subscriber and Maildir awaits. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { RelayCore } from '../relay-core.js';
import type { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { WatcherManager } from '../watcher-manager.js';

const SUBJECT = 'relay.agent.example';
const LOCAL = { loginEnabled: false } as const;
const fixtures: { relay: RelayCore; db: Db; dir: string }[] = [];
function fixture() {
  const db = createDb(':memory:');
  runMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), 'receipt-effect-fence-'));
  const notices = vi.fn(() => db.$client.inTransaction);
  const relay = new RelayCore({
    db,
    onDeadLetter: notices,
    dataDir: dir,
    gcIntervalMs: 3_600_000,
    ttlSweepIntervalMs: 3_600_000,
  });
  fixtures.push({ relay, db, dir });
  const internals = relay as unknown as {
    endpointDeps: { watcherManager: WatcherManager };
    publishPipeline: { deps: { maildirStore: MaildirStore; sqliteIndex: SqliteIndex } };
  };
  return { relay, db, dir, internals, notices };
}
afterEach(async () => {
  for (const { relay, db, dir } of fixtures.splice(0)) {
    if (db.$client.inTransaction) db.$client.exec('ROLLBACK');
    await relay.close();
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it.each([false, true])(
  'fences each direct subscriber (caller transaction: %s)',
  async (transaction) => {
    const { relay, db } = fixture();
    let locator = '';
    const first = vi.fn(async () => {
      expect(db.$client.inTransaction).toBe(false);
      if (transaction) db.$client.exec('BEGIN');
    });
    const second = vi.fn(async () => {
      expect(db.$client.inTransaction).toBe(false);
    });
    relay.subscribe(SUBJECT, first);
    relay.subscribe(SUBJECT, second);
    const publication = relay.publish(SUBJECT, 'payload', {
      from: 'local-client',
      receiptContext: { ownerUserId: null, onReceiptCreated: (id) => (locator = id) },
    });
    let error: unknown;
    const result = await publication.catch((caught: unknown) => {
      error = caught;
      return undefined;
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(transaction ? 0 : 1);
    if (transaction) {
      expect(error).toMatchObject({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' });
      expect(db.$client.inTransaction).toBe(true);
      db.$client.exec('ROLLBACK');
    } else {
      expect(error).toBeUndefined();
      expect(result?.deliveredTo).toBe(2);
    }
    expect(relay.getDeliveryReceipt(locator, LOCAL)).not.toBeNull();
  }
);

it.each([
  'normal',
  'deliver',
  'claim',
  'handler',
  'handler-sync',
  'handler-error',
  'complete',
  'fail',
] as const)('fences Maildir effects after %s awaits', async (boundary) => {
  const { relay, db, dir, internals } = fixture();
  const endpoint = await relay.registerEndpoint(SUBJECT);
  // Exclude watcher dispatch: this proof binds the actual synchronous publication path.
  await internals.endpointDeps.watcherManager.closeAll();
  const { maildirStore, sqliteIndex } = internals.publishPipeline.deps;
  const actualClaim = maildirStore.claim.bind(maildirStore);
  const actualComplete = maildirStore.complete.bind(maildirStore);
  const actualFail = maildirStore.fail.bind(maildirStore);
  vi.spyOn(maildirStore, 'claim');
  const complete = vi.spyOn(maildirStore, 'complete');
  const fail = vi.spyOn(maildirStore, 'fail');
  const index = vi.spyOn(sqliteIndex, 'updateStatus');
  const insert = vi.spyOn(sqliteIndex, 'insertMessage');
  if (boundary === 'deliver') {
    const real = maildirStore.deliver.bind(maildirStore);
    vi.spyOn(maildirStore, 'deliver').mockImplementation(async (...args) => {
      const result = await real(...args);
      db.$client.exec('BEGIN');
      return result;
    });
  }
  if (boundary === 'claim') {
    vi.mocked(maildirStore.claim).mockImplementation(async (...args) => {
      const result = await actualClaim(...args);
      db.$client.exec('BEGIN');
      return result;
    });
  }
  if (boundary === 'complete') {
    complete.mockImplementation(async (...args) => {
      const result = await actualComplete(...args);
      db.$client.exec('BEGIN');
      return result;
    });
  }
  if (boundary === 'fail') {
    fail.mockImplementation(async (...args) => {
      const result = await actualFail(...args);
      db.$client.exec('BEGIN');
      return result;
    });
  }
  const subscriber = vi.fn(async () => {
    expect(db.$client.inTransaction).toBe(false);
    if (boundary === 'handler-sync') db.$client.exec('BEGIN');
    if (boundary === 'handler' || boundary === 'handler-error') {
      await Promise.resolve();
      db.$client.exec('BEGIN');
    }
    if (boundary === 'handler-error' || boundary === 'fail') throw new Error('handler failure');
  });
  relay.subscribe(SUBJECT, subscriber);
  const secondSubscriber = vi.fn(async () => {});
  if (boundary === 'handler-sync') relay.subscribe(SUBJECT, secondSubscriber);
  let locator = '';
  let error: unknown;
  const result = await relay
    .publish(SUBJECT, 'payload', {
      from: 'local-client',
      receiptContext: { ownerUserId: null, onReceiptCreated: (id) => (locator = id) },
    })
    .catch((caught: unknown) => {
      error = caught;
      return undefined;
    });
  const mailbox = join(dir, 'mailboxes', endpoint.hash);
  if (boundary === 'normal') {
    expect(error).toBeUndefined();
    expect(result?.deliveredTo).toBe(1);
    expect(subscriber).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledExactlyOnceWith(endpoint.hash, locator);
    expect(index).toHaveBeenCalledExactlyOnceWith(locator, endpoint.hash, 'delivered');
    expect(fail).not.toHaveBeenCalled();
    expect(readdirSync(join(mailbox, 'cur'))).toEqual([]);
  } else {
    // Assert primary effects before checking the public error code.
    expect(subscriber).toHaveBeenCalledTimes(
      boundary === 'deliver' || boundary === 'claim' ? 0 : 1
    );
    expect(index).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(boundary === 'complete' ? 1 : 0);
    expect(fail).toHaveBeenCalledTimes(boundary === 'fail' ? 1 : 0);
    expect(
      insert.mock.calls.filter(([entry]) => entry.endpointHash === endpoint.hash)
    ).toHaveLength(boundary === 'deliver' ? 0 : 1);
    expect(secondSubscriber).not.toHaveBeenCalled();
    if (
      boundary === 'claim' ||
      boundary === 'handler' ||
      boundary === 'handler-sync' ||
      boundary === 'handler-error'
    ) {
      expect(readdirSync(join(mailbox, 'cur'))).toEqual([locator + '.json']);
      expect(readdirSync(join(mailbox, 'failed'))).toEqual([]);
    }
    if (boundary === 'complete') expect(readdirSync(join(mailbox, 'cur'))).toEqual([]);
    if (boundary === 'fail') {
      expect(readdirSync(join(mailbox, 'cur'))).toEqual([]);
      expect(readdirSync(join(mailbox, 'failed')).sort()).toEqual(
        [locator + '.json', locator + '.reason.json'].sort()
      );
    }
    expect(error).toMatchObject({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' });
    expect(db.$client.inTransaction).toBe(true);
    db.$client.exec('ROLLBACK');
    expect(relay.getDeliveryReceipt(locator, LOCAL)?.state).toBe('accepted');
    const status = db.$client
      .prepare('SELECT status FROM relay_index WHERE id=? AND endpoint_hash=?')
      .pluck()
      .get(locator, endpoint.hash);
    expect(status).toBe(boundary === 'deliver' ? undefined : 'pending');
  }
});

it.each(['gate', 'no-match', 'endpoint-failure'] as const)(
  'fences real failed-file continuation for %s rejection',
  async (mode) => {
    for (const transaction of [false, true]) {
      const { relay, db, dir, internals, notices } = fixture();
      const { maildirStore, sqliteIndex } = internals.publishPipeline.deps;
      let endpointHash = SUBJECT;
      if (mode === 'endpoint-failure') {
        const endpoint = await relay.registerEndpoint(SUBJECT);
        endpointHash = endpoint.hash;
        await internals.endpointDeps.watcherManager.closeAll();
        const temporaryPath = join(dir, 'mailboxes', endpointHash, 'tmp');
        rmSync(temporaryPath, { recursive: true });
        writeFileSync(temporaryPath, 'blocks actual Maildir delivery');
      }
      const actualFail = maildirStore.failDirect.bind(maildirStore);
      const failedFile = vi
        .spyOn(maildirStore, 'failDirect')
        .mockImplementation(async (...args) => {
          const result = await actualFail(...args);
          expect(result.ok).toBe(true);
          if (transaction) db.$client.exec('BEGIN');
          return result;
        });
      const insert = vi.spyOn(sqliteIndex, 'insertMessage');
      let locator = '';
      let error: unknown;
      const result = await relay
        .publish(SUBJECT, 'payload', {
          from: 'local-client',
          ...(mode === 'gate' ? { budget: { callBudgetRemaining: 0 } } : {}),
          receiptContext: { ownerUserId: null, onReceiptCreated: (id) => (locator = id) },
        })
        .catch((caught: unknown) => {
          error = caught;
          return undefined;
        });
      // A failed file already written by the real primitive stays on disk. Later
      // accounting/arrival effects must stop without pretending that file rolled back.
      expect(failedFile).toHaveBeenCalledTimes(1);
      expect(readdirSync(join(dir, 'mailboxes', endpointHash, 'failed')).sort()).toEqual(
        [locator + '.json', locator + '.reason.json'].sort()
      );
      const failedWrites = insert.mock.calls.filter(([entry]) => entry.status === 'failed');
      expect(failedWrites).toHaveLength(transaction ? 0 : 1);
      expect(notices).toHaveBeenCalledTimes(transaction ? 0 : 1);
      expect(notices.mock.results.map((result) => result.value)).toEqual(
        transaction ? [] : [false]
      );
      expect(
        db.$client
          .prepare("SELECT count(*) FROM relay_index WHERE id=? AND status='failed'")
          .pluck()
          .get(locator)
      ).toBe(transaction ? 0 : 1);
      if (transaction) {
        expect(error).toMatchObject({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' });
        expect(db.$client.inTransaction).toBe(true);
        db.$client.exec('ROLLBACK');
      } else {
        expect(error).toBeUndefined();
        expect(result?.messageId).toBe(locator);
      }
      expect(relay.getDeliveryReceipt(locator, LOCAL)).not.toBeNull();
    }
  }
);

it('keeps ordinary untracked dead-letter arrival behavior without acquiring a receipt observer', async () => {
  const { relay, db, notices } = fixture();
  const result = await relay.publish(SUBJECT, 'payload', {
    from: 'local-client',
    budget: { callBudgetRemaining: 0 },
  });
  expect(notices).toHaveBeenCalledTimes(1);
  expect(notices.mock.results.map((result) => result.value)).toEqual([false]);
  expect(
    db.$client
      .prepare("SELECT count(*) FROM relay_index WHERE id=? AND status='failed'")
      .pluck()
      .get(result.messageId)
  ).toBe(1);
  expect(db.$client.prepare('SELECT count(*) FROM relay_delivery_receipts').pluck().get()).toBe(0);
  expect(
    db.$client.prepare('SELECT count(*) FROM relay_receipt_observer_owner').pluck().get()
  ).toBe(0);
});
