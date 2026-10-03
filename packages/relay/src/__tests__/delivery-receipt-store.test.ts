/** Real SQLite proofs for metadata durability, transaction isolation and observer fencing. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import * as liveness from '@dorkos/shared/process-liveness';
import { DeliveryReceiptStore, RECEIPT_RETENTION_MS } from '../delivery-receipt-store.js';

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ID2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const SUBJECT = 'relay.agent.example';
const LOCAL = { loginEnabled: false } as const;
const handles: Db[] = [];
const dirs: string[] = [];
function database(path = ':memory:'): Db {
  const db = createDb(path);
  runMigrations(db);
  handles.push(db);
  return db;
}
function holder(
  db: Db,
  pid: number,
  host = hostname(),
  claimedAt = new Date().toISOString()
): void {
  db.$client
    .prepare(`INSERT INTO relay_receipt_observer_owner VALUES ('observer','previous',?,?,?)`)
    .run(pid, host, claimedAt);
}
function state(db: Db, id = ID): unknown {
  return db.$client
    .prepare('SELECT state FROM relay_delivery_receipts WHERE message_id=?')
    .pluck()
    .get(id);
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of handles.splice(0)) {
    if (db.$client.inTransaction) db.$client.exec('ROLLBACK');
    db.$client.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('DeliveryReceiptStore', () => {
  it('commits acceptance independently, minimizes reads and fixes expiry at acceptance', () => {
    const db = database();
    let now = 1_000_000;
    const store = new DeliveryReceiptStore(db, { now: () => now });
    const receipt = store.create(ID, SUBJECT, null);
    expect(db.$client.inTransaction).toBe(false);
    expect(Object.keys(receipt).sort()).toEqual([
      'acceptedAt',
      'expiresAt',
      'messageId',
      'scope',
      'state',
      'updatedAt',
    ]);
    expect(receipt.expiresAt).toBe(new Date(now + RECEIPT_RETENTION_MS).toISOString());
    // A later caller rollback must never erase the accepted locator.
    db.$client.exec('BEGIN');
    db.$client.exec('ROLLBACK');
    expect(store.get(ID, LOCAL)).toEqual(receipt);
    now += 1;
    expect(store.settle(ID, { state: 'delivered' })).toBe(true);
    expect(store.get(ID, LOCAL)?.expiresAt).toBe(receipt.expiresAt);
    now = 1_000_000 + RECEIPT_RETENTION_MS - 1;
    expect(store.get(ID, LOCAL)?.state).toBe('delivered');
    now += 1;
    expect(store.get(ID, LOCAL)).toBeNull();
    expect(state(db)).toBe('delivered');
  });

  it('blocks a same-process sibling on the same handle even with a historical expiry clock', () => {
    const db = database();
    const first = new DeliveryReceiptStore(db, { now: () => 0 });
    first.create(ID, SUBJECT, null);
    const owner = db.$client.prepare('SELECT * FROM relay_receipt_observer_owner').get() as {
      pid: number;
      claimed_at: string;
    };
    expect(owner.pid).toBe(process.pid);
    expect(Date.parse(owner.claimed_at)).toBeGreaterThan(Date.now() - 10_000);
    const second = new DeliveryReceiptStore(db);
    expect(() => second.ensureReady()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(state(db)).toBe('accepted');
    expect(first.settle(ID, { state: 'delivered' })).toBe(true);
    expect(state(db)).toBe('delivered');
  });

  it('arbitrates two file handles through the singleton, not a handle/path lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipt-handles-'));
    dirs.push(dir);
    const path = join(dir, 'db.sqlite');
    const a = database(path);
    const b = database(path);
    const first = new DeliveryReceiptStore(a);
    const second = new DeliveryReceiptStore(b);
    first.create(ID, SUBJECT, null);
    expect(() => second.create(ID2, SUBJECT, null)).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(state(b)).toBe('accepted');
    expect(state(b, ID2)).toBeUndefined();
    expect(first.settle(ID, { state: 'delivered' })).toBe(true);
    expect(state(b)).toBe('delivered');
    first.close();
    second.ensureReady();
    expect(second.get(ID, LOCAL)?.state).toBe('delivered');
  });

  it.each(['live-confirmed', 'live-unconfirmed'] as const)(
    'blocks %s holders without touching their pending row',
    (verdict) => {
      const db = database();
      holder(db, 42);
      const probe = vi.spyOn(liveness, 'assessProcessLiveness').mockReturnValue(verdict);
      expect(() => new DeliveryReceiptStore(db).ensureReady()).toThrow(
        expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
      );
      expect(probe).toHaveBeenCalledWith(42, expect.any(Date));
      expect(
        db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
      ).toBe('previous');
    }
  );

  it.each([
    [42, 'different-host', new Date().toISOString()],
    [42, hostname(), 'not-a-date'],
    [0, hostname(), new Date().toISOString()],
    [2_147_483_648, hostname(), new Date().toISOString()],
    [42, hostname(), '2026-10-02'],
  ])('blocks malformed or foreign metadata (%s,%s,%s)', (pid, host, at) => {
    const db = database();
    holder(db, pid as number, host as string, at as string);
    const probe = vi.spyOn(liveness, 'assessProcessLiveness').mockReturnValue('gone');
    expect(() => new DeliveryReceiptStore(db).ensureReady()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it('recovers metadata from a proven earlier lifetime of the current numeric PID', () => {
    const db = database();
    const first = new DeliveryReceiptStore(db);
    first.create(ID, SUBJECT, null);
    first.create(ID2, SUBJECT, null);
    first.settle(ID2, { state: 'delivered' });
    const earlierLifetime = new Date(0);
    expect(liveness.assessProcessLiveness(process.pid, earlierLifetime)).toBe('gone');
    db.$client
      .prepare('UPDATE relay_receipt_observer_owner SET claimed_at=?')
      .run(earlierLifetime.toISOString());
    const next = new DeliveryReceiptStore(db);
    next.ensureReady();
    expect(next.get(ID, LOCAL)).toMatchObject({
      state: 'outcome_unknown',
      failure: { code: 'observation_lost' },
    });
    expect(next.get(ID2, LOCAL)?.state).toBe('delivered');
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(next.ownerToken);
    expect(next.recover()).toBe(0);
    expect(() => first.settle(ID, { state: 'delivered' })).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
  });

  it.each(['live-confirmed', 'live-unconfirmed'] as const)(
    'blocks a current numeric PID with %s lifetime evidence',
    (verdict) => {
      const db = database();
      holder(db, process.pid);
      const probe = vi.spyOn(liveness, 'assessProcessLiveness').mockReturnValue(verdict);
      expect(() => new DeliveryReceiptStore(db).ensureReady()).toThrow(
        expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
      );
      expect(probe).toHaveBeenCalledWith(process.pid, expect.any(Date));
      expect(
        db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
      ).toBe('previous');
    }
  );

  it('recovers only older accepted rows after a corroborated dead/recycled holder', () => {
    const db = database();
    const first = new DeliveryReceiptStore(db);
    first.create(ID, SUBJECT, null);
    first.create(ID2, SUBJECT, null);
    first.settle(ID2, { state: 'delivered' });
    db.$client.prepare('UPDATE relay_receipt_observer_owner SET pid=42').run();
    vi.spyOn(liveness, 'assessProcessLiveness').mockReturnValue('gone');
    const next = new DeliveryReceiptStore(db);
    next.ensureReady();
    expect(next.get(ID, LOCAL)).toMatchObject({
      state: 'outcome_unknown',
      failure: { code: 'observation_lost' },
    });
    expect(next.get(ID2, LOCAL)?.state).toBe('delivered');
    expect(() => first.settle(ID, { state: 'delivered' })).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(() => first.close()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(next.ownerToken);
    expect(next.recover()).toBe(0);
  });

  it.each(['create', 'get', 'settle', 'recover', 'prune', 'close', 'acquire'] as const)(
    'rejects caller-owned transactions for %s without commit/rollback',
    (action) => {
      const db = database();
      const store = new DeliveryReceiptStore(db);
      if (action !== 'acquire') store.create(ID, SUBJECT, null);
      db.$client.exec('BEGIN');
      const calls = {
        create: () => store.create(ID2, SUBJECT, null),
        get: () => store.get(ID, LOCAL),
        settle: () => store.settle(ID, { state: 'delivered' }),
        recover: () => store.recover(),
        prune: () => store.pruneExpired(),
        close: () => store.close(),
        acquire: () => store.ensureReady(),
      };
      expect(calls[action]).toThrow(
        expect.objectContaining({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' })
      );
      expect(db.$client.inTransaction).toBe(true);
      db.$client.exec('ROLLBACK');
      expect(state(db, ID2)).toBeUndefined();
      if (action !== 'acquire') expect(state(db)).toBe('accepted');
    }
  );

  it('latches close on transaction failure and retries release without letting late callbacks write', () => {
    const db = database();
    const first = new DeliveryReceiptStore(db);
    first.create(ID, SUBJECT, null);
    db.$client.exec('BEGIN');
    expect(() => first.close()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_TRANSACTION_ACTIVE' })
    );
    expect(first.settle(ID, { state: 'delivered' })).toBe(false);
    expect(db.$client.inTransaction).toBe(true);
    expect(state(db)).toBe('accepted');
    db.$client.exec('ROLLBACK');
    const next = new DeliveryReceiptStore(db);
    expect(() => next.ensureReady()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    expect(first.settle(ID, { state: 'delivered' })).toBe(false);
    expect(state(db)).toBe('accepted');
    first.close();
    next.ensureReady();
    expect(next.get(ID, LOCAL)?.state).toBe('outcome_unknown');
    expect(first.settle(ID, { state: 'delivered' })).toBe(false);
    first.close();
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(next.ownerToken);
  });

  it('rolls back failed close cleanup and retains durable ownership until a successful retry', () => {
    const db = database();
    const first = new DeliveryReceiptStore(db);
    first.create(ID, SUBJECT, null);
    db.$client.exec(`CREATE TRIGGER fail_release BEFORE DELETE ON relay_receipt_observer_owner
      BEGIN SELECT RAISE(ABORT,'private storage sentinel'); END`);
    expect(() => first.close()).toThrow(
      expect.objectContaining({
        code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
        message: 'Delivery receipt status is unavailable.',
      })
    );
    expect(state(db)).toBe('accepted');
    expect(db.$client.inTransaction).toBe(false);
    expect(() => new DeliveryReceiptStore(db).ensureReady()).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' })
    );
    db.$client.exec('DROP TRIGGER fail_release');
    first.close();
    expect(state(db)).toBe('outcome_unknown');
    expect(
      db.$client.prepare('SELECT count(*) FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(0);
  });

  it('enforces trusted ownership transitions and terminal CAS without exposing internal columns', () => {
    const db = database();
    const store = new DeliveryReceiptStore(db);
    store.create(ID, SUBJECT, 'alice');
    store.create(ID2, SUBJECT, null);
    expect(
      store.get(ID, { loginEnabled: true, userId: 'bob', installOwnerUserId: 'alice' })
    ).toBeNull();
    expect(
      store.get(ID2, { loginEnabled: true, userId: 'bob', installOwnerUserId: 'alice' })
    ).toBeNull();
    expect(
      store.get(ID2, { loginEnabled: true, userId: 'alice', installOwnerUserId: 'alice' })?.state
    ).toBe('accepted');
    expect(store.settle(ID, { state: 'failed', code: 'at_capacity' })).toBe(true);
    expect(store.settle(ID, { state: 'delivered' })).toBe(false);
    expect(store.get(ID, LOCAL)).toMatchObject({
      state: 'failed',
      failure: {
        code: 'at_capacity',
        message: 'The agent was busy and did not take this message.',
      },
    });
    expect(store.get(ID, LOCAL)).not.toHaveProperty('ownerUserId');
    expect(store.get(ID, LOCAL)).not.toHaveProperty('subject');
    expect(store.get(ID, LOCAL)).not.toHaveProperty('bootEpoch');
    expect(store.settle('01ARZ3NDEKTSV4RRFFQ69G5FAX', { state: 'delivered' })).toBe(false);
  });

  it('does not mutate or release a successor token through any stale observer method', () => {
    const db = database();
    const stale = new DeliveryReceiptStore(db);
    stale.create(ID, SUBJECT, null);
    db.$client.prepare('UPDATE relay_receipt_observer_owner SET owner_token=?').run('successor');
    const operations = [
      () => stale.create(ID2, SUBJECT, null),
      () => stale.get(ID, LOCAL),
      () => stale.settle(ID, { state: 'delivered' }),
      () => stale.recover(),
      () => stale.pruneExpired(),
      () => stale.close(),
    ];
    operations.forEach((operation) =>
      expect(operation).toThrow(expect.objectContaining({ code: 'RELAY_RECEIPT_OBSERVER_BUSY' }))
    );
    expect(state(db)).toBe('accepted');
    expect(state(db, ID2)).toBeUndefined();
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe('successor');
  });

  it('rolls back acquisition when recovery storage fails and safely retries metadata only', () => {
    const db = database();
    const old = new DeliveryReceiptStore(db);
    old.create(ID, SUBJECT, null);
    db.$client.prepare('UPDATE relay_receipt_observer_owner SET pid=42').run();
    vi.spyOn(liveness, 'assessProcessLiveness').mockReturnValue('gone');
    db.$client.exec(`CREATE TRIGGER fail_recovery BEFORE UPDATE ON relay_delivery_receipts
      BEGIN SELECT RAISE(ABORT,'secret sentinel'); END`);
    const next = new DeliveryReceiptStore(db);
    expect(() => next.ensureReady()).toThrow(
      expect.objectContaining({
        code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
        message: 'Delivery receipt status is unavailable.',
      })
    );
    expect(state(db)).toBe('accepted');
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(old.ownerToken);
    expect(db.$client.inTransaction).toBe(false);
    db.$client.exec('DROP TRIGGER fail_recovery');
    next.ensureReady();
    expect(next.get(ID, LOCAL)?.state).toBe('outcome_unknown');
    next.create(ID2, SUBJECT, null);
    expect(next.recover()).toBe(0);
    expect(state(db, ID2)).toBe('accepted');
  });

  it('keeps rollback failure typed and never fabricates a successful release or receipt', () => {
    const db = database();
    const store = new DeliveryReceiptStore(db);
    store.ensureReady();
    db.$client.exec(`CREATE TRIGGER fail_create BEFORE INSERT ON relay_delivery_receipts
      BEGIN SELECT RAISE(ABORT,'insert sentinel'); END`);
    const realExec = db.$client.exec.bind(db.$client);
    const fault = vi.spyOn(db.$client, 'exec').mockImplementation((statement) => {
      if (statement === 'ROLLBACK') throw new Error('private rollback sentinel');
      return realExec(statement);
    });
    expect(() => store.create(ID, SUBJECT, null)).toThrow(
      expect.objectContaining({
        code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE',
        message: 'Delivery receipt status is unavailable.',
      })
    );
    expect(db.$client.inTransaction).toBe(true);
    expect(state(db)).toBeUndefined();
    expect(
      db.$client.prepare('SELECT owner_token FROM relay_receipt_observer_owner').pluck().get()
    ).toBe(store.ownerToken);
    fault.mockRestore();
    db.$client.exec('ROLLBACK');
    expect(state(db)).toBeUndefined();
    store.close();
  });

  it('distinguishes storage failure from absence and stores only safe terminal text', () => {
    const db = database();
    const store = new DeliveryReceiptStore(db);
    store.create(ID, SUBJECT, null);
    expect(store.settle(ID, { state: 'outcome_unknown' })).toBe(true);
    expect(store.get(ID, LOCAL)?.failure).toEqual({
      code: 'observation_lost',
      message: 'DorkOS could not confirm how this delivery ended.',
    });
    expect(store.get(ID2, LOCAL)).toBeNull();
    db.$client.exec('DROP TABLE relay_delivery_receipts');
    expect(() => store.get(ID, LOCAL)).toThrow(
      expect.objectContaining({ code: 'RELAY_RECEIPT_STORAGE_UNAVAILABLE' })
    );
    expect(db.$client.inTransaction).toBe(false);
  });

  it('prunes exactly 500 ordered expired rows and late settlement cannot recreate them', () => {
    const db = database();
    let now = 0;
    const store = new DeliveryReceiptStore(db, { now: () => now });
    // Use unique, valid Crockford IDs without relying on wall-clock order.
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const ids = Array.from(
      { length: 501 },
      (_, i) => ID.slice(0, 24) + alphabet[Math.floor(i / 32)] + alphabet[i % 32]
    );
    ids.forEach((id) => store.create(id, SUBJECT, null));
    db.$client
      .prepare(
        `INSERT INTO relay_index (id,subject,endpoint_hash,status,created_at)
      VALUES ('unrelated','relay.mailbox.example','endpoint','pending','1970-01-01T00:00:00.000Z')`
      )
      .run();
    const liveId = '02ARZ3NDEKTSV4RRFFQ69G5FAW';
    now = 1;
    store.create(liveId, SUBJECT, null);
    now = RECEIPT_RETENTION_MS;
    expect(store.pruneExpired()).toBe(500);
    expect(
      db.$client.prepare('SELECT message_id FROM relay_delivery_receipts').pluck().all()
    ).toEqual([ids[500], liveId].sort());
    expect(store.settle(ids[0], { state: 'delivered' })).toBe(false);
    expect(store.get(ids[0], LOCAL)).toBeNull();
    expect(store.pruneExpired()).toBe(1);
    expect(store.pruneExpired()).toBe(0);
    expect(store.get(liveId, LOCAL)?.state).toBe('accepted');
    expect(db.$client.prepare('SELECT count(*) FROM relay_index').pluck().get()).toBe(1);
  });
});
