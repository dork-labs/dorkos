/** @vitest-environment node */
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import {
  AdapterRegistry,
  WebhookAdapter,
  type RelayCore,
  type RelayPublisher,
} from '@dorkos/relay';
import express from 'express';
import { env } from '../env.js';
import { errorHandler } from '../middleware/error-handler.js';
import { createAdapterRouter } from '../routes/relay-adapters.js';
import { createApp, finalizeApp } from '../app.js';
import { composedListener } from '../http/__tests__/composed-listener.js';
import { createRelayRouter } from '../routes/relay.js';
import type { AdapterManager } from '../services/relay/adapter-manager.js';
import { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { initConfigManager, configManager } from '../services/core/config-manager.js';
import { initAuth } from '../services/core/auth/index.js';

// Real app middleware, receiver, registry-started adapter and cryptography.
// Only the downstream publisher and manager's lookup facade are test doubles;
// no signature or inbound implementation is replaced. Requests send literal UTF-8
// strings because superagent serializes a Buffer object when Content-Type is JSON.
const target = swappableServer();
const SECRET = 'signed-json-fixture-secret-at-least-sixteen';
const ADAPTER_ID = 'signed-json';
const SUBJECT = 'relay.webhook.signed-json';
const URL = `/api/relay/webhooks/${ADAPTER_ID}`;
const EXACT = Buffer.from('{\n  "event": "push", "text": "café 🚀", "count": 1\n}\n', 'utf8');
let home: string;
let db: Db;
let registry: AdapterRegistry;
let adapter: WebhookAdapter;
let admission: MainRequestAdmission;
let manager: AdapterManager;
let inbound: MockInstance<WebhookAdapter['handleInbound']>;
const publish = vi.fn<RelayPublisher['publish']>(async () => ({
  messageId: 'fixture-message',
  deliveredTo: 1,
}));
const publisher: RelayPublisher = {
  publish,
  onSignal: () => () => {},
  subscribe: () => () => {},
};

/** Sign the actual UTF-8 body bytes, not a parsed/reserialized representation. */
function signed(
  body = EXACT,
  nonce = randomUUID(),
  timestamp = String(Math.floor(Date.now() / 1000))
) {
  return {
    'X-Signature': createHmac('sha256', SECRET).update(`${timestamp}.`).update(body).digest('hex'),
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };
}

/** Send literal UTF-8 so application/json does not reserialize a Buffer wrapper. */
function send(body = EXACT, headers = signed(body)) {
  return request(target.server)
    .post(URL)
    .set('Content-Type', 'application/json')
    .set(headers)
    .send(body.toString('utf8'));
}

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-signed-json-'));
  initConfigManager(home);
  db = createDb(path.join(home, 'auth.db'));
  runMigrations(db);
  initAuth(db, home);
});

beforeEach(async () => {
  configManager.set('auth', { enabled: false });
  publish.mockClear();
  registry = new AdapterRegistry();
  registry.setRelay(publisher);
  adapter = new WebhookAdapter(ADAPTER_ID, {
    inbound: { subject: SUBJECT, secret: SECRET },
    outbound: { url: 'http://127.0.0.1:9/not-used', secret: SECRET },
  });
  await registry.register(adapter);
  inbound = vi.spyOn(adapter, 'handleInbound'); // Default spy calls the real method.
  manager = {
    getRegistry: () => registry,
    getAdapter: (id: string) =>
      id === ADAPTER_ID
        ? {
            config: { id, type: 'webhook', enabled: true },
            status: adapter.getStatus(),
          }
        : undefined,
  } as unknown as AdapterManager;
  admission = new MainRequestAdmission();
  const app = createApp({ admission });
  app.all('/api/relay/webhooks-neighbor', (req, res) =>
    res.json({ body: req.body, isBuffer: Buffer.isBuffer(req.body) })
  );
  app.put(URL, (req, res) => res.json({ body: req.body, isBuffer: Buffer.isBuffer(req.body) }));
  app.post('/api/ordinary-json-probe', (req, res) =>
    res.json({ body: req.body, isBuffer: Buffer.isBuffer(req.body) })
  );
  app.use('/api/relay', createRelayRouter(publisher as unknown as RelayCore, manager));
  finalizeApp(app);
  target.mount(composedListener(app, admission));
});

afterEach(async () => {
  await registry.shutdown(); // Clears the real adapter's nonce pruning timer.
  vi.restoreAllMocks();
  configManager.set('auth', { enabled: false });
});

afterAll(async () => {
  db.$client.close();
  await fs.rm(home, { recursive: true, force: true });
});

describe('signed Relay JSON through the finalized application', () => {
  it('preserves whitespace and Unicode bytes for a real HMAC receiver', async () => {
    const headers = signed();
    const result = await request(target.server)
      .post(URL)
      .set('Content-Type', 'application/json')
      .set(headers)
      .send(EXACT.toString('utf8'));
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
    expect(inbound.mock.calls[0]![0]).toEqual(EXACT);
    expect(Buffer.isBuffer(inbound.mock.calls[0]![0])).toBe(true);
    expect(publish).toHaveBeenCalledExactlyOnceWith(
      SUBJECT,
      {
        type: 'webhook',
        data: JSON.parse(EXACT.toString()),
        metadata: { platform: 'webhook', adapterId: ADAPTER_ID, nonce: headers['X-Nonce'] },
        responseContext: { platform: 'webhook' },
      },
      { from: `relay.webhook.${ADAPTER_ID}` }
    );
  });

  it('keeps ordinary JSON parsed through the app', async () => {
    const response = await request(target.server)
      .post('/api/ordinary-json-probe')
      .send({ ordinary: 'café 🚀' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ body: { ordinary: 'café 🚀' }, isBuffer: false });
    expect(inbound).toHaveBeenCalledTimes(0);
  });

  it('verifies signed malformed JSON before parsing and consumes only verified nonces', async () => {
    const malformed = Buffer.from('{broken');
    const headers = signed(malformed);
    const response = await send(malformed, headers);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: 'Publish failed' });
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(0);
    const replay = await send(EXACT, signed(EXACT, headers['X-Nonce']));
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Nonce already seen (replay)' });
    expect(inbound).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(0);

    const invalid = { ...signed(malformed), 'X-Signature': '0'.repeat(64) };
    const rejected = await send(malformed, invalid);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ error: 'Invalid signature' });
    expect(inbound).toHaveBeenCalledTimes(3);
    const control = await send(EXACT, signed(EXACT, invalid['X-Nonce']));
    expect(control.status).toBe(200);
    expect(inbound).toHaveBeenCalledTimes(4);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('refuses a skipped raw parser body without treating it as a Buffer', async () => {
    const response = await request(target.server)
      .post(URL)
      .set(signed())
      .send(EXACT.toString('utf8'))
      .unset('Content-Type');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Send a request body with a content type.' });
    expect(inbound).toHaveBeenCalledTimes(0);
    expect(publish).toHaveBeenCalledTimes(0);
    expect((await send()).status).toBe(200);
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-secret', 'changed-payload', 'changed-whitespace'] as const)(
    'refuses %s without publishing or consuming the nonce',
    async (kind) => {
      const headers = signed();
      let body = EXACT;
      if (kind === 'wrong-secret') {
        headers['X-Signature'] = createHmac('sha256', 'different-fixture-secret')
          .update(`${headers['X-Timestamp']}.`)
          .update(EXACT)
          .digest('hex');
      } else if (kind === 'changed-payload') {
        body = Buffer.from(EXACT.toString().replace('push', 'pull'));
      } else {
        body = Buffer.concat([EXACT, Buffer.from(' ')]);
      }
      const rejected = await send(body, headers);
      expect(rejected.status).toBe(401);
      expect(rejected.body).toEqual({ error: 'Invalid signature' });
      expect(inbound).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(0);
      const control = await send(EXACT, signed(EXACT, headers['X-Nonce']));
      expect(control.status).toBe(200);
      expect(inbound).toHaveBeenCalledTimes(2);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  );

  it('accepts a signed request once and rejects its replay', async () => {
    const headers = signed();
    expect((await send(EXACT, headers)).status).toBe(200);
    const replay = await send(EXACT, headers);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: 'Nonce already seen (replay)' });
    expect(inbound).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['full-app', 'standalone-receiver'] as const)(
    'accepts more than 100kb but below 1mb in %s',
    async (composition) => {
      if (composition === 'standalone-receiver') {
        const app = express();
        app.use('/api/relay', createAdapterRouter(manager));
        app.use(errorHandler);
        target.mount(app);
      }
      const padding = 'x'.repeat(200 * 1024);
      const body = Buffer.from(JSON.stringify({ padding }));
      expect(body.length).toBeGreaterThan(100 * 1024);
      expect(body.length).toBeLessThan(1024 * 1024);
      const result = await send(body);
      expect(result.status).toBe(200);
      expect(inbound).toHaveBeenCalledTimes(1);
      expect(inbound.mock.calls[0]![0]).toEqual(body);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]![1]).toMatchObject({ data: { padding } });
    }
  );

  it.each(['full-app', 'standalone-receiver'] as const)(
    'refuses more than 1mb before adapter verification in %s',
    async (composition) => {
      if (composition === 'standalone-receiver') {
        const app = express();
        app.use('/api/relay', createAdapterRouter(manager));
        app.use(errorHandler);
        target.mount(app);
      }
      const body = Buffer.from(JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }));
      const headers = signed(body);
      const result = await send(body, headers);
      expect(result.status).toBe(413);
      expect(result.body.code).toBe('REQUEST_TOO_LARGE');
      expect(inbound).toHaveBeenCalledTimes(0);
      expect(publish).toHaveBeenCalledTimes(0);
      const control = await send(EXACT, signed(EXACT, headers['X-Nonce']));
      expect(control.status).toBe(200);
      expect(inbound).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  );

  it('preserves ordinary malformed and oversized JSON responses', async () => {
    const malformed = await request(target.server)
      .post('/api/ordinary-json-probe')
      .set('Content-Type', 'application/json')
      .send('{broken');
    expect(malformed.status).toBe(500);
    expect(malformed.body.code).toBe('INTERNAL_ERROR');
    const oversized = await request(target.server)
      .post('/api/ordinary-json-probe')
      .send({ padding: 'x'.repeat(1024 * 1024) });
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe('REQUEST_TOO_LARGE');
    expect(inbound).toHaveBeenCalledTimes(0);
    expect(publish).toHaveBeenCalledTimes(0);
  });

  it('keeps neighboring and non-POST Relay paths under normal JSON parsing', async () => {
    const body = { ordinary: 'café 🚀' };
    const neighbor = await request(target.server).post('/api/relay/webhooks-neighbor').send(body);
    const otherMethod = await request(target.server).put(URL).send(body);
    for (const result of [neighbor, otherMethod]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ body, isBuffer: false });
    }
    expect(inbound).toHaveBeenCalledTimes(0);
    expect(publish).toHaveBeenCalledTimes(0);
  });

  it('keeps the real login gate on signed JSON and accepts a real local session', async () => {
    configManager.set('auth', { enabled: true });
    const headers = signed();
    const rejected = await send(EXACT, headers);
    expect(rejected.status).toBe(401);
    expect(rejected.body).toEqual({ error: 'Unauthorized', code: 'AUTH_REQUIRED' });
    expect(inbound).toHaveBeenCalledTimes(0);
    expect(publish).toHaveBeenCalledTimes(0);

    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const email = 'fixture' + '@' + 'dork.test';
    const password = 'fixture-password-not-an-operator-credential';
    const signup = await request(target.server)
      .post('/api/auth/sign-up/email')
      .set('Origin', origin)
      .send({ email, password, name: 'Fixture owner' });
    expect(signup.status).toBe(200);
    const signin = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .send({ email, password });
    expect(signin.status).toBe(200);
    const cookies = signin.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const accepted = await request(target.server)
      .post(URL)
      .set('Content-Type', 'application/json')
      .set(headers)
      .set('Cookie', cookies)
      .send(EXACT.toString('utf8'));
    expect(accepted.status).toBe(200);
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['host', 'origin', 'admission'] as const)(
    'preserves the %s refusal ahead of adapter verification',
    async (gate) => {
      const headers = signed();
      let pending = request(target.server)
        .post(URL)
        .set('Content-Type', 'application/json')
        .set(headers);
      if (gate === 'host') pending = pending.set('Host', 'hostile.example');
      if (gate === 'origin') pending = pending.set('Origin', 'https://hostile.example');
      if (gate === 'admission') admission.close();
      const result = await pending.send(EXACT.toString('utf8'));
      expect(result.status).toBe(gate === 'host' ? 403 : gate === 'admission' ? 503 : 500);
      expect(result.body.code).toBe(
        gate === 'host'
          ? 'HOST_NOT_ALLOWED'
          : gate === 'admission'
            ? 'SERVER_STOPPING'
            : 'INTERNAL_ERROR'
      );
      expect(inbound).toHaveBeenCalledTimes(0);
      expect(publish).toHaveBeenCalledTimes(0);
      // The same listener/observer has a successful counterpart. Admission is
      // terminal, so build a fresh admitted app only for that control.
      if (gate === 'admission') {
        const controlApp = createApp({ admission: new MainRequestAdmission() });
        controlApp.use('/api/relay', createRelayRouter(publisher as unknown as RelayCore, manager));
        finalizeApp(controlApp);
        target.mount(controlApp);
      }
      expect((await send(EXACT, headers)).status).toBe(200);
      expect(inbound).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(1);
    }
  );

  it('keeps empty typed bodies at the real receiver but refuses an untyped absent body', async () => {
    const empty = Buffer.alloc(0);
    const typed = await send(empty);
    expect(typed.status).toBe(401);
    expect(typed.body).toEqual({ error: 'Publish failed' });
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0]![0]).toEqual(empty);
    const untyped = await request(target.server).post(URL).set(signed(empty));
    expect(untyped.status).toBe(400);
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(0);
  });
});
