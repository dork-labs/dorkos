import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { RequestUser } from '../../services/core/auth/index.js';
import { PushSubscriptionStore } from '../../services/notifications/push-subscription-store.js';
import { WebPushChannel } from '../../services/notifications/channels/web-push.js';
import { createPushRouter } from '../push.js';

let db: Db;
let dorkHome: string;
let subscriptions: PushSubscriptionStore;
let channel: WebPushChannel;

/** A browser's subscribe body, as `PushSubscription.toJSON()` produces it. */
function subscribeBody(endpoint = 'https://fcm.googleapis.com/one') {
  return { endpoint, keys: { p256dh: 'pub-key', auth: 'auth-key' } };
}

/**
 * Mount the router behind stand-ins for the two middlewares in front of it.
 * `sessionGate` and the agent-identity resolver both write onto `res.locals`,
 * and a case has to present exactly one credential.
 */
function buildApp(
  options: { user?: RequestUser; agentIdentity?: { agentId: string } } = {}
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (options.user) res.locals.user = options.user;
    if (options.agentIdentity) res.locals.agentIdentity = options.agentIdentity;
    next();
  });
  app.use('/api/push', createPushRouter({ subscriptions, channel }));
  return app;
}

/** An agent principal — the caller every route here must refuse. */
const AS_AGENT = { agentIdentity: { agentId: 'agent-1' } };

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  subscriptions = new PushSubscriptionStore(db);
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-push-routes-'));
  channel = new WebPushChannel({
    dorkHome,
    subscriptions,
    sender: { sendNotification: vi.fn().mockResolvedValue({}) },
  });
});

afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('GET /api/push/vapid-public-key', () => {
  it('answers with the key a browser needs to subscribe', async () => {
    const res = await request(buildApp()).get('/api/push/vapid-public-key');

    expect(res.status).toBe(200);
    expect(typeof res.body.key).toBe('string');
    expect(res.body.key.length).toBeGreaterThan(0);
  });

  it('refuses an agent, and does not create a keypair for it', async () => {
    const res = await request(buildApp(AS_AGENT)).get('/api/push/vapid-public-key');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PUSH_OPERATOR_ONLY');
    // Reading the key GENERATES it on first call, so a refusal that had already
    // touched the disk would be a refusal with a side effect.
    expect(fs.existsSync(path.join(dorkHome, 'push', 'vapid.json'))).toBe(false);
  });
});

describe('POST /api/push/subscriptions', () => {
  it('remembers a browser and answers without echoing the endpoint back', async () => {
    const res = await request(buildApp()).post('/api/push/subscriptions').send(subscribeBody());

    expect(res.status).toBe(200);
    expect(res.body.subscription.service).toBe('fcm.googleapis.com');
    // The endpoint is a capability: anybody holding it can push to that browser.
    expect(JSON.stringify(res.body)).not.toContain('/one');
    expect(subscriptions.all()).toHaveLength(1);
  });

  it('is idempotent by endpoint, so calling it on every load costs nothing', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/push/subscriptions').send(subscribeBody());
    const second = await request(app).post('/api/push/subscriptions').send(subscribeBody());

    expect(second.body.subscription.id).toBe(first.body.subscription.id);
    expect(subscriptions.all()).toHaveLength(1);
  });

  it('refuses a body that is not a subscription', async () => {
    const res = await request(buildApp())
      .post('/api/push/subscriptions')
      .send({ endpoint: 'not-a-url', keys: {} });

    expect(res.status).toBe(400);
    expect(subscriptions.all()).toHaveLength(0);
  });

  it('refuses an agent, and stores nothing', async () => {
    const res = await request(buildApp(AS_AGENT))
      .post('/api/push/subscriptions')
      .send(subscribeBody());

    expect(res.status).toBe(403);
    expect(subscriptions.all()).toHaveLength(0);
  });
});

describe('GET /api/push/subscriptions', () => {
  it('lists every device, newest first, with no endpoints', async () => {
    subscriptions.upsert(subscribeBody('https://fcm.googleapis.com/older'));
    subscriptions.upsert(subscribeBody('https://web.push.apple.com/newer'));

    const res = await request(buildApp()).get('/api/push/subscriptions');

    expect(res.status).toBe(200);
    expect(res.body.subscriptions.map((s: { service: string }) => s.service)).toEqual([
      'web.push.apple.com',
      'fcm.googleapis.com',
    ]);
    expect(JSON.stringify(res.body)).not.toContain('newer');
  });

  it('refuses an agent — which devices can be buzzed is not a machine’s question', async () => {
    subscriptions.upsert(subscribeBody());

    const res = await request(buildApp(AS_AGENT)).get('/api/push/subscriptions');

    expect(res.status).toBe(403);
    expect(res.body.subscriptions).toBeUndefined();
  });

  it('refuses an API key too, unlike the Inbox next door', async () => {
    // The Inbox lets a program READ history because that history is the
    // operator's own. A push device is a capability to make a phone buzz, which
    // is a different question with a different answer.
    const res = await request(
      buildApp({ user: { userId: 'u1', credential: 'api-key' } as unknown as RequestUser })
    ).get('/api/push/subscriptions');

    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/push/subscriptions/:id', () => {
  it('removes one device and leaves the rest alone', async () => {
    const keep = subscriptions.upsert(subscribeBody('https://fcm.googleapis.com/keep'));
    const drop = subscriptions.upsert(subscribeBody('https://fcm.googleapis.com/drop'));

    const res = await request(buildApp()).delete(`/api/push/subscriptions/${drop.id}`);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(subscriptions.all().map((row) => row.id)).toEqual([keep.id]);
  });

  it('reports zero rather than 404 for a device that is already gone', async () => {
    // "Stop pushing to this device" is already true of a device with no row, and
    // a second window's list can be a moment out of date.
    const res = await request(buildApp()).delete('/api/push/subscriptions/never-existed');

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
  });

  it('refuses an agent, and removes nothing', async () => {
    const row = subscriptions.upsert(subscribeBody());

    const res = await request(buildApp(AS_AGENT)).delete(`/api/push/subscriptions/${row.id}`);

    expect(res.status).toBe(403);
    expect(subscriptions.all()).toHaveLength(1);
  });
});
