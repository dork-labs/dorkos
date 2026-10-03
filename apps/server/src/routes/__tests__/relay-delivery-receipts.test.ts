/** Real Core/SQLite HTTP receipts; only delivery and explicit response faults are controlled. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, user, type Db } from '@dorkos/db';
import {
  RelayCore,
  noopLogger,
  type AdapterRegistryLike,
  type DeliveryResult,
} from '@dorkos/relay';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createRelayRouter } from '../relay.js';
import { initAuth, readOwnerAccount, sessionGate } from '../../services/core/auth/index.js';
import { initConfigManager, configManager } from '../../services/core/config-manager.js';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';

const target = swappableServer();
const SUBJECT = 'relay.agent.receipt-test';
const UNKNOWN = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const SECRET = 'private-error-payload-sentinel';
let dir: string;
let db: Db;
let core: RelayCore;
let app: express.Express;
let registry: AdapterRegistryLike & { deliver: ReturnType<typeof vi.fn> };
let resolveDelivery: (value: DeliveryResult | null) => void;
let finished: Promise<void>[];
let receiptClock: number;
let auth: ReturnType<typeof initAuth>;
let store: { ensureReady(): void };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'http-receipts-'));
  initConfigManager(dir);
  configManager.set('auth', { enabled: false });
  db = createDb(join(dir, 'receipts.db'));
  runMigrations(db);
  db.insert(user)
    .values({
      id: 'install-owner',
      name: 'Owner',
      email: 'owner@receipt.test',
      createdAt: new Date(1),
      updatedAt: new Date(1),
    })
    .run();
  auth = initAuth(db, dir);
  receiptClock = Date.now();
  const delivery = new Promise<DeliveryResult | null>((resolve) => {
    resolveDelivery = resolve;
  });
  registry = {
    deliver: vi.fn((subject: string) => (subject === SUBJECT ? delivery : Promise.resolve(null))),
    setRelay() {},
    shutdown: async () => {},
  };
  core = new RelayCore({
    db,
    dataDir: join(dir, 'relay'),
    adapterRegistry: registry,
    logger: noopLogger,
    receiptNow: () => receiptClock,
  });
  const internal = core as unknown as {
    database: { receipts: { ensureReady(): void } };
    publishPipeline: {
      deps: {
        adapterDelivery: {
          finishDetached(...args: unknown[]): Promise<void>;
          finishDetachedRejection(...args: unknown[]): Promise<void>;
        };
      };
    };
  };
  store = internal.database.receipts;
  finished = [];
  for (const method of ['finishDetached', 'finishDetachedRejection'] as const) {
    const adapter = internal.publishPipeline.deps.adapterDelivery;
    const original = adapter[method].bind(adapter);
    vi.spyOn(adapter, method).mockImplementation((...args) => {
      const promise = original(...args);
      finished.push(promise);
      return promise;
    });
  }
  app = express();
  app.use(express.json());
  app.use(sessionGate);
  target.mount(app);
});

afterEach(async () => {
  resolveDelivery({ success: true });
  await Promise.resolve();
  await Promise.all(finished);
  if (db.$client.open && db.$client.inTransaction) db.$client.exec('ROLLBACK');
  vi.restoreAllMocks();
  await core.close();
  if (db.$client.open) db.$client.close();
  configManager.set('auth', { enabled: false });
  rmSync(dir, { recursive: true, force: true });
});

function mount(manager?: AdapterManager) {
  app.use('/api/relay', createRelayRouter(core, manager));
}
function send(extra: Record<string, unknown> = {}) {
  return request(target.server)
    .post('/api/relay/messages')
    .send({
      subject: SUBJECT,
      from: 'relay.human.console.forged',
      payload: { secret: SECRET },
      ...extra,
    });
}
function rows() {
  return db.$client.prepare('SELECT * FROM relay_delivery_receipts').all() as Array<{
    message_id: string;
    owner_user_id: string | null;
    state: string;
  }>;
}
function counts() {
  return {
    receipts: rows().length,
    index: db.$client.prepare('SELECT count(*) AS n FROM relay_index').get(),
    calls: registry.deliver.mock.calls.length,
    mailboxes: existsSync(join(dir, 'relay', 'mailboxes'))
      ? readdirSync(join(dir, 'relay', 'mailboxes'))
      : [],
  };
}
async function key(userId: string) {
  return (await auth.api.createApiKey({ body: { userId, name: 'receipt-fixture' } })).key;
}

it('POST accepted then actual deferred typed at_capacity GET without replyTo is terminal and minimized', async () => {
  mount();
  const post = await send();
  expect(post.status).toBe(200);
  expect(post.body.deliveredTo).toBe(1);
  expect(post.body.receipt.state).toBe('accepted');
  expect(post.body.statusUrl).toBe(`/api/relay/messages/${post.body.messageId}/status`);
  expect(rows()[0].message_id).toBe(post.body.messageId);
  expect(registry.deliver).toHaveBeenCalledTimes(1);
  resolveDelivery({ success: false, code: 'at_capacity', error: SECRET });
  await Promise.resolve();
  const completed = [...finished];
  expect(completed).toHaveLength(1);
  await completed[0];
  const status = await request(target.server).get(post.body.statusUrl);
  process.stdout.write(
    JSON.stringify({
      oracle: 'detached-http',
      completedHelpers: completed.length,
      status: status.status,
      receipt: status.body,
    }) + '\n'
  );
  // Primary mutation oracle: completion comes from the real helper, never receipt polling.
  expect(status.body.state).toBe('failed');
  expect(status.status).toBe(200);
  expect(status.headers['cache-control']).toBe('no-store');
  expect(status.body.failure).toEqual({
    code: 'at_capacity',
    message: 'The agent was busy and did not take this message.',
  });
  expect(Object.keys(status.body).sort()).toEqual([
    'acceptedAt',
    'expiresAt',
    'failure',
    'messageId',
    'scope',
    'settledAt',
    'state',
    'updatedAt',
  ]);
  expect(JSON.stringify(status.body)).not.toContain(SECRET);
});

it('returns a fresh fast terminal snapshot and leaves ordinary non-agent responses additive-free', async () => {
  resolveDelivery({ success: true });
  mount();
  const post = await send();
  expect(post.status).toBe(200);
  expect(post.body.receipt.state).toBe('delivered');
  const ordinary = await send({ subject: 'relay.custom.topic' });
  expect(ordinary.status).toBe(200);
  expect(ordinary.body).not.toHaveProperty('receipt');
  expect(ordinary.body).not.toHaveProperty('statusUrl');
});

it('real insert failure is safe storage503 with no locator or delivery/accounting/Maildir effects', async () => {
  mount();
  const subscriber = vi.fn();
  core.subscribe(SUBJECT, subscriber);
  db.$client.exec(
    `CREATE TRIGGER reject_receipt BEFORE INSERT ON relay_delivery_receipts BEGIN SELECT RAISE(ABORT,'${SECRET}'); END`
  );
  const response = await send();
  resolveDelivery({ success: true });
  await Promise.resolve();
  await Promise.all([...finished]);
  const captured = {
    counts: counts(),
    subscriberCalls: subscriber.mock.calls.length,
    response: response.body,
  };
  // Complete exact-owned resources before the primary zero-effects assertion can fail.
  await core.close();
  db.$client.close();
  process.stdout.write(JSON.stringify({ oracle: 'acceptance-insert', ...captured }) + '\n');
  expect(captured.counts.calls).toBe(0);
  expect(captured.subscriberCalls).toBe(0);
  expect(captured.counts).toEqual({ receipts: 0, index: { n: 0 }, calls: 0, mailboxes: [] });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('RELAY_RECEIPT_STORAGE_UNAVAILABLE');
  expect(response.body).not.toHaveProperty('messageId');
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
});

it('matched agent delivery has one external effect after the genuine insertion fault is removed', async () => {
  mount();
  db.$client.exec(
    `CREATE TRIGGER reject_receipt BEFORE INSERT ON relay_delivery_receipts BEGIN SELECT RAISE(ABORT,'${SECRET}'); END`
  );
  db.$client.exec('DROP TRIGGER reject_receipt');
  const response = await send();
  resolveDelivery({ success: true });
  await Promise.resolve();
  const completed = [...finished];
  expect(completed).toHaveLength(1);
  await completed[0];
  expect(registry.deliver).toHaveBeenCalledTimes(1);
  expect(registry.deliver.mock.calls[0][1].id).toBe(response.body.messageId);
  expect(rows()).toEqual([
    expect.objectContaining({ message_id: response.body.messageId, state: 'delivered' }),
  ]);
});

it('caller BEGIN refuses before ID/effects without committing caller work', async () => {
  mount();
  const subscriber = vi.fn();
  core.subscribe(SUBJECT, subscriber);
  db.$client.exec('BEGIN');
  const response = await send();
  expect(counts()).toEqual({ receipts: 0, index: { n: 0 }, calls: 0, mailboxes: [] });
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('RELAY_RECEIPT_TRANSACTION_ACTIVE');
  expect(response.body).not.toHaveProperty('messageId');
  expect(db.$client.inTransaction).toBe(true);
  expect(subscriber).not.toHaveBeenCalled();
});

it('a second real Core observer is busy with zero loser effects', async () => {
  store.ensureReady();
  const loser = new RelayCore({
    db,
    dataDir: join(dir, 'loser'),
    logger: noopLogger,
    adapterRegistry: registry,
  });
  app.use('/api/relay', createRelayRouter(loser));
  try {
    const response = await send();
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('RELAY_RECEIPT_OBSERVER_BUSY');
    const status = await request(target.server).get(`/api/relay/messages/${UNKNOWN}/status`);
    expect(status.status).toBe(503);
    expect(status.body.code).toBe('RELAY_RECEIPT_OBSERVER_BUSY');
    expect(status.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toHaveProperty('messageId');
    expect(rows()).toEqual([]);
    expect(registry.deliver).not.toHaveBeenCalled();
  } finally {
    await loser.close();
  }
});

it('real accounting failure after durable acceptance retains exact locator before publish returns', async () => {
  mount();
  db.$client.exec(
    `CREATE TRIGGER reject_index BEFORE INSERT ON relay_index BEGIN SELECT RAISE(ABORT,'${SECRET}'); END`
  );
  const response = await send();
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('RELAY_RECEIPT_RESPONSE_UNAVAILABLE');
  expect(response.body.messageId).toBe(rows()[0].message_id);
  expect(response.body.statusUrl).toBe(`/api/relay/messages/${rows()[0].message_id}/status`);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  expect(registry.deliver).not.toHaveBeenCalled();
  expect((await request(target.server).get(response.body.statusUrl)).body.state).toBe(
    'outcome_unknown'
  );
});

it('snapshot read outage after effects retains locator, without replay, and status retry reads SQL', async () => {
  mount();
  const prepare = db.$client.prepare.bind(db.$client);
  let fail = true;
  vi.spyOn(db.$client, 'prepare').mockImplementation((sql) => {
    if (fail && sql === 'SELECT * FROM relay_delivery_receipts WHERE message_id = ?') {
      fail = false;
      throw new Error(SECRET);
    }
    return prepare(sql);
  });
  const response = await send();
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('RELAY_RECEIPT_RESPONSE_UNAVAILABLE');
  expect(response.body.messageId).toBe(rows()[0].message_id);
  expect(registry.deliver).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  expect((await request(target.server).get(response.body.statusUrl)).status).toBe(200);
  expect(registry.deliver).toHaveBeenCalledTimes(1);
});

it('one-shot Express serialization failure keeps the callback-owned locator and safe error', async () => {
  let failed = false;
  app.set('json replacer', (name: string, value: unknown) => {
    if (name === 'statusUrl' && !failed) {
      failed = true;
      throw new Error(SECRET);
    }
    return value;
  });
  mount();
  const response = await send();
  expect(failed).toBe(true);
  expect(response.status).toBe(503);
  expect(response.body.messageId).toBe(rows()[0].message_id);
  expect(response.body.statusUrl).toBe(`/api/relay/messages/${rows()[0].message_id}/status`);
  expect(response.body.code).toBe('RELAY_RECEIPT_RESPONSE_UNAVAILABLE');
  expect(JSON.stringify(response.body)).not.toContain(SECRET);
  expect(registry.deliver).toHaveBeenCalledTimes(1);
});

it('headers already sent prevent a second response or receipt rewrite', async () => {
  let sends = 0;
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body) => {
      sends++;
      if (body.statusUrl && body.receipt) {
        res.type('json').end(JSON.stringify({ lost: true }));
        throw new Error(SECRET);
      }
      return json(body);
    };
    next();
  });
  mount();
  const response = await send();
  expect(response.body).toEqual({ lost: true });
  expect(sends).toBe(1);
  expect(rows()[0].state).toBe('accepted');
  expect(registry.deliver).toHaveBeenCalledTimes(1);
});

it.each(['throw', 'reject', 'lookup'] as const)(
  'activity %s is best effort and keeps accepted200/locator',
  async (mode) => {
    const emit = vi.fn(() => {
      if (mode === 'throw') throw new Error(SECRET);
      return Promise.reject(new Error(SECRET));
    });
    app.locals.activityService = { emit };
    const manager = {
      getRegistry: () => {
        if (mode === 'lookup') throw new Error(SECRET);
        return { getBySubject: () => ({ id: 'fixture' }) };
      },
      resolveAdapterName: () => 'Fixture',
    } as unknown as AdapterManager;
    mount(manager);
    const response = await send();
    expect(emit).toHaveBeenCalledTimes(mode === 'lookup' ? 0 : 1);
    expect(response.status).toBe(200);
    expect(response.body.receipt.state).toBe('accepted');
    expect(response.body.messageId).toBe(rows()[0].message_id);
    expect(response.body.statusUrl).toBeDefined();
    expect(JSON.stringify(response.body)).not.toContain(SECRET);
  }
);

it('real authentication precedes malformed IDs and POST validation', async () => {
  configManager.set('auth', { enabled: true });
  mount();
  for (const path of [
    '/api/relay/messages/not-an-id/status',
    `/api/relay/messages/${UNKNOWN}/status`,
  ]) {
    const response = await request(target.server).get(path);
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('AUTH_REQUIRED');
  }
  expect((await send({ from: 'relay.system.forged' })).status).toBe(401);
  expect(rows()).toEqual([]);
  expect(registry.deliver).not.toHaveBeenCalled();
});

it('verified ownership ignores forged body/from/replyTo and uniform404 hides other owners', async () => {
  db.insert(user).values({ id: 'other-user', name: 'Other', email: 'other@receipt.test' }).run();
  const ownerKey = await key('install-owner');
  const otherKey = await key('other-user');
  configManager.set('auth', { enabled: true });
  mount();
  const post = await send({
    ownerUserId: 'other-user',
    from: 'relay.agent.other-user',
    replyTo: 'relay.human.other-user',
  }).set('Authorization', `Bearer ${ownerKey}`);
  expect(post.status).toBe(200);
  expect(rows()[0].owner_user_id).toBe('install-owner');
  expect(
    (
      await request(target.server)
        .get(post.body.statusUrl)
        .set('Authorization', `Bearer ${ownerKey}`)
    ).status
  ).toBe(200);
  const hidden = await request(target.server)
    .get(post.body.statusUrl)
    .set('Authorization', `Bearer ${otherKey}`);
  const missing = await request(target.server)
    .get(`/api/relay/messages/${UNKNOWN}/status`)
    .set('Authorization', `Bearer ${otherKey}`);
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual(missing.body);
  expect(hidden.headers['cache-control']).toBe('no-store');
});

// Operational install-owner bars must not restrict each authenticated account's own receipts.
it('lets a real authenticated noninstallowner publish and read only their own receipt', async () => {
  db.insert(user).values({ id: 'other-user', name: 'Other', email: 'other@receipt.test' }).run();
  const otherKey = await key('other-user');
  const ownerKey = await key('install-owner');
  configManager.set('auth', { enabled: true });
  expect(readOwnerAccount()?.id).toBe('install-owner');
  mount();
  const post = await send({ ownerUserId: 'install-owner' }).set(
    'Authorization',
    `Bearer ${otherKey}`
  );
  expect(post.status).toBe(200);
  expect(rows()).toMatchObject([
    { message_id: post.body.messageId, owner_user_id: 'other-user', state: 'accepted' },
  ]);
  const own = await request(target.server)
    .get(post.body.statusUrl)
    .set('Authorization', `Bearer ${otherKey}`);
  expect(own.status).toBe(200);
  expect(own.body.messageId).toBe(post.body.messageId);
  const hidden = await request(target.server)
    .get(post.body.statusUrl)
    .set('Authorization', `Bearer ${ownerKey}`);
  const missing = await request(target.server)
    .get(`/api/relay/messages/${UNKNOWN}/status`)
    .set('Authorization', `Bearer ${ownerKey}`);
  expect(hidden.status).toBe(404);
  expect(hidden.body).toEqual(missing.body);
  expect(hidden.headers['cache-control']).toBe('no-store');
});

it('off-to-on historic null owner is adopted only by verified install owner; off again restores local trust', async () => {
  mount();
  const post = await send();
  expect(rows()[0].owner_user_id).toBeNull();
  db.insert(user).values({ id: 'other-user', name: 'Other', email: 'other@receipt.test' }).run();
  const ownerKey = await key('install-owner');
  const otherKey = await key('other-user');
  configManager.set('auth', { enabled: true });
  expect(
    (
      await request(target.server)
        .get(post.body.statusUrl)
        .set('Authorization', `Bearer ${ownerKey}`)
    ).status
  ).toBe(200);
  expect(
    (
      await request(target.server)
        .get(post.body.statusUrl)
        .set('Authorization', `Bearer ${otherKey}`)
    ).status
  ).toBe(404);
  expect(rows()[0].owner_user_id).toBeNull();
  configManager.set('auth', { enabled: false });
  expect((await request(target.server).get(post.body.statusUrl)).status).toBe(200);
});

it('no install owner grants no historic ownership, even with a controlled verified identity', async () => {
  // Controlled identity seam proves fail-closed ownership; it is not a credential verification claim.
  app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.user = { userId: 'absent-owner' };
    next();
  });
  target.mount(app);
  mount();
  const post = await send();
  db.delete(user).run();
  configManager.set('auth', { enabled: true });
  expect((await request(target.server).get(post.body.statusUrl)).status).toBe(404);
});

it('invalid400 follows auth and unknown/untracked/expired locators share exact404/no-store', async () => {
  mount();
  const malformed = await request(target.server).get('/api/relay/messages/not-an-id/status');
  expect(malformed.status).toBe(400);
  expect(malformed.body.code).toBe('INVALID_RELAY_MESSAGE_ID');
  const ordinary = await send({ subject: 'relay.custom.topic' });
  const tracked = await send();
  receiptClock = Date.parse(tracked.body.receipt.expiresAt);
  const missing = await request(target.server).get(`/api/relay/messages/${UNKNOWN}/status`);
  const untracked = await request(target.server).get(
    `/api/relay/messages/${ordinary.body.messageId}/status`
  );
  const expired = await request(target.server).get(tracked.body.statusUrl);
  for (const response of [missing, untracked, expired]) {
    expect(response.status).toBe(404);
    expect(response.body).toEqual(missing.body);
    expect(response.headers['cache-control']).toBe('no-store');
  }
  expect(rows()).toHaveLength(1);
  expect((await request(target.server).get(`/api/relay/messages/${UNKNOWN}/trace`)).body).toEqual({
    error: 'Tracing not available',
  });
  expect((await request(target.server).get(`/api/relay/messages/${UNKNOWN}`)).body).toEqual({
    error: 'Message not found',
  });
});

it('GET transaction and real storage outages remain distinct503, never missing404', async () => {
  mount();
  const post = await send();
  db.$client.exec('BEGIN');
  const transaction = await request(target.server).get(post.body.statusUrl);
  expect(transaction.status).toBe(503);
  expect(transaction.body.code).toBe('RELAY_RECEIPT_TRANSACTION_ACTIVE');
  expect(transaction.headers['cache-control']).toBe('no-store');
  db.$client.exec('ROLLBACK');
  db.$client.exec('ALTER TABLE relay_delivery_receipts RENAME TO unavailable_receipts');
  try {
    const storage = await request(target.server).get(post.body.statusUrl);
    expect(storage.status).toBe(503);
    expect(storage.body.code).toBe('RELAY_RECEIPT_STORAGE_UNAVAILABLE');
    expect(storage.headers['cache-control']).toBe('no-store');
  } finally {
    db.$client.exec('ALTER TABLE unavailable_receipts RENAME TO relay_delivery_receipts');
  }
});
