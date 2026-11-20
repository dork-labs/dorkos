import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { session, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import request, { type Test } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { PERSON_PROOF_HEADER } from '@dorkos/shared/person-session';
import { createApiApp } from '../../http/api-chain.js';
import { mountBetterAuth } from '../../http/better-auth.js';
import { frontDoorListener } from '../../http/front-door.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { requirePersonAtThisComputer } from '../../lib/caller-authority.js';
import { initAuth } from '../../services/core/auth/index.js';
import { personProofFor } from '../../services/core/auth/person-proof.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { auditEvents } from '@dorkos/db';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { BrowserViewerRegistry } from '../../services/session/browser-viewers/viewer-registry.js';
import type {
  ViewerFrame,
  ViewerPage,
} from '../../services/session/browser-viewers/viewer-contract.js';
import { browserViewerBodyRule, createBrowserViewerRoutes } from '../browser-viewers.js';
import { createPersonSessionRoutes } from '../person-session.js';
import { createLocalBrowserRoutes } from '../local-browser.js';
import type { LocalBrowserService } from '../../services/session/local-browser/service.js';

const target = swappableServer();
const origin = `http://localhost:${env.DORKOS_PORT}`;
const marker = 'MADE_UP_VIEWER_PIXELS_7b13';
const markerForms = [
  marker,
  Buffer.from(marker).toString('base64'),
  Buffer.from(marker).toString('hex'),
  JSON.stringify([...Buffer.from(marker)]),
];
let directory: string;
let db: Db;
let registry: BrowserViewerRegistry;
let cookie: string;
let proof: string;
let sessionId: string;
let publish: (frame: ViewerFrame) => void;
let admitted: (() => void) | undefined;
let tunnelFacts = false;
let logEntries: unknown[] = [];
let reporters = [...logger.options.reporters];

function asOwner(call: Test): Test {
  return call
    .set('Host', `localhost:${env.DORKOS_PORT}`)
    .set('Origin', origin)
    .set('Cookie', cookie)
    .set(PERSON_PROOF_HEADER, proof)
    .set('X-Client-Id', 'owner-window');
}

async function subscribe(): Promise<{ viewerId: string; nonce: string }> {
  const response = await asOwner(request(target.server).post('/api/browser-viewers')).send({
    chatId: 'fixture-chat',
  });
  expect(response.status).toBe(201);
  return response.body;
}

function frame(): void {
  publish({ sequence: 1, generation: 1, width: 640, height: 480, bytes: Buffer.from(marker) });
}

beforeEach(async () => {
  tunnelFacts = false;
  directory = await mkdtemp(path.join(tmpdir(), 'viewer-session-'));
  initConfigManager(directory);
  db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({
      db,
      installId: 'viewer-fixture',
      readOwnerAccount: () => null,
    }),
  });
  logEntries = [];
  reporters = [...logger.options.reporters];
  logger.addReporter({
    log: (entry) => {
      logEntries.push(entry.args);
    },
  });
  const auth = initAuth(db, directory);
  let navigation = new AbortController();
  let page: ViewerPage = {
    identity: {
      chatId: 'fixture-chat',
      profileId: 'fixture-profile',
      connectionId: 'fixture-connection',
      tabId: 'fixture-tab',
    },
    signal: navigation.signal,
    assertLive: () => undefined,
    assertCurrent: async () => {
      const ready = admitted;
      admitted = undefined;
      ready?.();
    },
    start: async (receive) => {
      publish = receive;
      return async () => undefined;
    },
  };
  registry = new BrowserViewerRegistry(async () => page);
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    bodyRules: [browserViewerBodyRule],
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth, maxAttempts: 1000 }),
  });
  app.route('/api/person-session', createPersonSessionRoutes());
  app.route(
    '/api/local-browser',
    createLocalBrowserRoutes({
      handover: {
        navigate: async () => {
          navigation.abort();
          navigation = new AbortController();
          page = { ...page, signal: navigation.signal };
          return { ok: true };
        },
      },
    } as unknown as LocalBrowserService)
  );
  // The real session/proof gate runs first; only the router's transport facts change.
  app.use('/api/browser-viewers/*', async (c, next) => {
    if (tunnelFacts) {
      markIngress(c.env.incoming, 'own-tunnel');
      Object.defineProperties(c.env.incoming.socket, {
        remoteAddress: { configurable: true, value: '198.51.100.17' },
        encrypted: { configurable: true, value: true },
      });
      const facts = honoRequestFacts(c);
      expect(facts.user).toMatchObject({ credential: 'cookie', sessionId });
      expect(facts.connectionEncrypted).toBe(true);
      expect(facts.peerAddress).toBe('198.51.100.17');
      expect(requirePersonAtThisComputer(facts)).toBeUndefined();
    }
    return next();
  });
  app.route(
    '/api/browser-viewers',
    createBrowserViewerRoutes(registry, () => true)
  );
  target.mount(frontDoorListener(app));
  const signup = await request(target.server)
    .post('/api/auth/sign-up/email')
    .set('Origin', origin)
    .send({
      email: 'owner' + '@' + 'fixture.test',
      password: 'made-up-owner-password-123',
      name: 'Fixture owner',
    });
  expect(signup.status).toBe(200);
  const cookies = signup.headers['set-cookie'] as unknown as string[];
  cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  sessionId = db.select().from(session).get()!.id;
  proof = (await personProofFor(sessionId))!;
});

afterEach(async () => {
  admitted = undefined;
  await registry.close();
  resetAuditTrail();
  logger.setReporters(reporters);
  await rm(directory, { recursive: true, force: true });
});

describe('viewer sessions on the real HTTP chain', () => {
  it('keeps the stepped-up owner after navigation, reconnect and an idle frame', async () => {
    const steppedUp = await request(target.server)
      .post('/api/person-session')
      .set('Host', `localhost:${env.DORKOS_PORT}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ password: 'made-up-owner-password-123' });
    expect(steppedUp.status).toBe(200);
    cookie = (steppedUp.headers['set-cookie'] as unknown as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    proof = steppedUp.body.proof;
    const first = await subscribe();
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const pending = asOwner(
      request(target.server).post(`/api/browser-viewers/${first.viewerId}/frame`)
    )
      .send({ nonce: first.nonce })
      .then((response) => response);
    await ready;
    const navigated = await asOwner(
      request(target.server).post('/api/local-browser/navigate')
    ).send({ url: 'https://example.test/' });
    expect(navigated.status).toBe(200);
    expect((await pending).status).toBe(409);
    const next = await subscribe();
    frame();
    const delivered = await asOwner(
      request(target.server).post(`/api/browser-viewers/${next.viewerId}/frame`)
    ).send({ nonce: next.nonce });
    expect(delivered.status).toBe(200);
    const idle = await asOwner(
      request(target.server).post(`/api/browser-viewers/${next.viewerId}/frame`)
    ).send({ nonce: next.nonce, receipt: delivered.headers['x-frame-receipt'] });
    expect(idle.status).toBe(204);
    publish({ sequence: 2, generation: 1, width: 640, height: 480, bytes: Buffer.from(marker) });
    const resumed = await asOwner(
      request(target.server).post(`/api/browser-viewers/${next.viewerId}/frame`)
    ).send({ nonce: next.nonce });
    expect(resumed.status).toBe(200);
  });

  it('keeps local viewing local for an owner over an encrypted tunnel', async () => {
    tunnelFacts = true;
    const response = await asOwner(request(target.server).post('/api/browser-viewers')).send({
      chatId: 'fixture-chat',
    });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('viewer_local_only');
  });

  it('delivers pixels only beside the live owner cookie and app proof', async () => {
    const viewer = await subscribe();
    frame();
    const response = await asOwner(
      request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/frame`)
    ).send({ nonce: viewer.nonce });
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/jpeg');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-frame-receipt']).toMatch(/^[\w-]{43}$/);
    expect(JSON.parse(response.headers['x-frame-metadata'])).toMatchObject({
      sequence: 1,
      byteLength: Buffer.byteLength(marker),
    });
    expect(Buffer.from(response.body).toString()).toBe(marker);
    const closed = await asOwner(
      request(target.server).delete(`/api/browser-viewers/${viewer.viewerId}`)
    ).send({ nonce: viewer.nonce });
    expect(closed.status).toBe(204);
    // The real audit fallback and request logger observed this delivery, not stub sinks.
    expect(db.select().from(auditEvents).all().length).toBeGreaterThan(0);
    for (const planted of markerForms)
      expect(JSON.stringify(db.select().from(auditEvents).all())).not.toContain(planted);
    logger.info('Viewer fixture control line');
    expect(JSON.stringify(logEntries)).toContain('Viewer fixture control line');
    for (const planted of markerForms) expect(JSON.stringify(logEntries)).not.toContain(planted);
  });

  it('refuses a cookie without its app proof even on this computer', async () => {
    const response = await request(target.server)
      .post('/api/browser-viewers')
      .set('Host', `localhost:${env.DORKOS_PORT}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Client-Id', 'owner-window')
      .send({ chatId: 'fixture-chat' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('viewer_person_only');
  });

  it('rechecks a session that ends during a pending frame request', async () => {
    const viewer = await subscribe();
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const waiting = asOwner(
      request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/frame`)
    )
      .send({ nonce: viewer.nonce })
      .then((response) => response);
    await ready;
    db.delete(session).where(eq(session.id, sessionId)).run();
    frame();
    const response = await waiting;
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('viewer_denied');
    expect(JSON.stringify(response.body)).not.toContain(marker);
  });

  it('bounds compressed and plain JSON envelopes before resolving a page', async () => {
    const response = await asOwner(request(target.server).post('/api/browser-viewers')).send({
      chatId: 'fixture-chat',
      padding: 'x'.repeat(16 * 1024),
    });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('viewer_bad_request');
  });
});
