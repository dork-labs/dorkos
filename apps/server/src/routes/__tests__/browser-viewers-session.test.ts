import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { session, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import request, { type Test } from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { PERSON_PROOF_HEADER } from '@dorkos/shared/person-session';
import {
  heldProtocolCall,
  leaseFixture,
} from '../../services/session/local-browser/__tests__/page-leases-fixture.js';
import { PERSON_SAFETY_EXPRESSION } from '../../services/session/local-browser/leases/viewer-control/person-safety.js';
import { createApiApp } from '../../http/api-chain.js';
import { mountBetterAuth } from '../../http/better-auth.js';
import { frontDoorListener } from '../../http/front-door.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { honoRequestFacts } from '../../http/request-facts.js';
import { requirePersonAtThisComputer } from '../../lib/caller-authority.js';
import { initAuth } from '../../services/core/auth/index.js';
import * as sessionGate from '../../services/core/auth/session-gate.js';
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
let inputEnabled = true;
let activeService: LocalBrowserService | undefined;
let resolvePage = vi.fn();
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
  publish({
    sequence: 1,
    generation: 1,
    navigationGeneration: 0,
    controlEpoch: 0,
    viewport: { generation: 1, width: 640, height: 480, offsetTop: 0, scale: 1 },
    width: 640,
    height: 480,
    bytes: Buffer.from(marker),
  });
}

beforeEach(async () => {
  tunnelFacts = false;
  inputEnabled = true;
  activeService = undefined;
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
    facts: () => ({ revision: 0, navigationGeneration: 0, controlEpoch: 0 }),
    onChange: () => () => undefined,
    takeControl: async () => {
      throw Error('unused');
    },
    handBack: async () => undefined,
    binding: {
      sessionId: 'fixture-chat',
      profileId: 'fixture-profile',
      connectionId: 'fixture-connection',
      profileConnectionGeneration: 'fixture-generation',
      leaseId: 'fixture-tab',
      tabId: 'fixture-tab',
    },
    abandon: async () => undefined,
    close: async () => undefined,
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
  resolvePage = vi.fn(async () => page);
  registry = new BrowserViewerRegistry(resolvePage, () => inputEnabled);
  const app = createApiApp({
    admission: new MainRequestAdmission(),
    bodyRules: [browserViewerBodyRule],
    beforeBodyParsing: (early) => mountBetterAuth(early, { auth, maxAttempts: 1000 }),
  });
  app.route('/api/person-session', createPersonSessionRoutes());
  app.route(
    '/api/local-browser',
    createLocalBrowserRoutes(
      {
        personState: (chatId: string | null) => activeService!.personState(chatId),
        personSession: (chatId: string | null) => {
          if (activeService) return activeService.personSession(chatId);
          expect(chatId).toBe('fixture-chat');
          return {
            handover: {
              navigate: async () => {
                navigation.abort();
                navigation = new AbortController();
                page = { ...page, signal: navigation.signal };
                return { ok: true };
              },
            },
          };
        },
      } as unknown as LocalBrowserService,
      undefined,
      registry
    )
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
    createBrowserViewerRoutes(
      registry,
      () => true,
      () => inputEnabled
    )
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
  it('S1: refuses viewer address state when the session ends during the read', async () => {
    const f = await leaseFixture();
    activeService = f.service;
    try {
      await f.open('fixture-chat');
      f.contexts[0].pages[0].navigate('https://example.com');
      resolvePage.mockImplementation(f.service.viewerPages.resolve);
      const viewer = await subscribe();
      const read = f.service.personState.bind(f.service);
      const reading = vi.spyOn(f.service, 'personState').mockImplementationOnce(async (chatId) => {
        const state = await read(chatId);
        expect(state).toMatchObject({ status: 'connected', sessionId: 'fixture-chat' });
        db.delete(session).where(eq(session.id, sessionId)).run();
        return state;
      });
      try {
        const response = await asOwner(
          request(target.server).get('/api/local-browser/state?sessionId=fixture-chat')
        )
          .set('X-Viewer-Id', viewer.viewerId)
          .set('X-Viewer-Nonce', viewer.nonce);
        expect(reading).toHaveBeenCalledExactlyOnceWith('fixture-chat');
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('viewer_denied');
        expect(response.body).not.toHaveProperty('viewerAddress');
        expect(response.body).not.toHaveProperty('url');
      } finally {
        reading.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  });

  it.each(['navigationGeneration', 'controlEpoch'] as const)(
    'S2: drops a JPEG and clears its receipt when %s changes during stillPerson',
    async (generation) => {
      const viewer = await subscribe();
      const page: ViewerPage = await resolvePage.mock.results[0].value;
      let facts = { ...page.facts() };
      const changed = vi.spyOn(page, 'facts').mockImplementation(() => facts);
      const gate = heldProtocolCall();
      const framePath = `/api/browser-viewers/${viewer.viewerId}/frame`;
      const deliver = registry.frame.bind(registry);
      let capturedReceipt: string | undefined;
      let frameResolved = false;
      const delivered = vi.spyOn(registry, 'frame').mockImplementationOnce(async (...args) => {
        const result = await deliver(...args);
        expect(result).not.toBeNull();
        capturedReceipt = result!.receipt;
        frameResolved = true;
        return result;
      });
      const decide = sessionGate.decideSessionGate;
      const admission = vi
        .spyOn(sessionGate, 'decideSessionGate')
        .mockImplementation(async (...args) => {
          const decision = await decide(...args);
          if (frameResolved && args[1] === framePath) {
            frameResolved = false;
            expect(decision).toMatchObject({ allowed: true, user: { sessionId } });
            await gate.run();
          }
          return decision;
        });
      try {
        frame();
        const waiting = asOwner(request(target.server).post(framePath))
          .send({ nonce: viewer.nonce })
          .then((response) => response);
        await gate.started;
        facts = { ...facts, revision: facts.revision + 1, [generation]: facts[generation] + 1 };
        gate.release();
        const response = await waiting;
        expect(response.status).toBe(204);
        expect(response.text).toBe('');
        expect(response.headers['content-type']).toBeUndefined();
        expect(response.headers['x-frame-receipt']).toBeUndefined();
        expect(capturedReceipt).toMatch(/^[\w-]{43}$/);
        const replay = await asOwner(request(target.server).post(framePath)).send({
          nonce: viewer.nonce,
          receipt: capturedReceipt,
        });
        expect(replay.status).toBe(403);
        expect(replay.body.code).toBe('viewer_denied');
        publish({
          sequence: 2,
          generation: 1,
          navigationGeneration: facts.navigationGeneration,
          controlEpoch: facts.controlEpoch,
          viewport: { generation: 1, width: 640, height: 480, offsetTop: 0, scale: 1 },
          width: 640,
          height: 480,
          bytes: Buffer.from(marker),
        });
        // No previous receipt is required after the stale delivery was discarded.
        const next = await asOwner(request(target.server).post(framePath)).send({
          nonce: viewer.nonce,
        });
        expect(next.status).toBe(200);
        expect(next.headers['x-frame-receipt']).not.toBe(capturedReceipt);
      } finally {
        gate.release();
        admission.mockRestore();
        delivered.mockRestore();
        changed.mockRestore();
      }
    }
  );

  it('drives the six finite routes through real cookie/proof and broker paint authority', async () => {
    const f = await leaseFixture();
    activeService = f.service;
    try {
      await f.open('fixture-chat');
      f.contexts[0].pages[0].navigate('https://example.com');
      resolvePage.mockImplementation(f.service.viewerPages.resolve);
      const viewer = await subscribe();
      const post = (verb: string, body: object) =>
        asOwner(
          request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/${verb}`)
        ).send(body);
      const taken = await post('take-over', { nonce: viewer.nonce });
      expect(taken.status).toBe(200);
      expect(taken.body.metadata.control.ready).toBe(false);
      const streams = () =>
        f.protocolSessions.filter((s) =>
          s.send.mock.calls.some(([m]) => m === 'Page.startScreencast')
        );
      await vi.waitFor(() => expect(streams().at(-1)!.detach).not.toHaveBeenCalled());
      streams()
        .at(-1)!
        .events.emit('Page.screencastFrame', {
          sessionId: 1,
          data: Buffer.from([
            255, 216, 255, 192, 0, 11, 8, 1, 224, 2, 128, 1, 1, 17, 0, 255, 217,
          ]).toString('base64'),
          metadata: {
            deviceWidth: 640,
            deviceHeight: 480,
            offsetTop: 0,
            pageScaleFactor: 1,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
          },
        });
      const pixels = await post('frame', { nonce: viewer.nonce });
      expect(pixels.status).toBe(200);
      const view = JSON.parse(pixels.headers['x-frame-metadata']).view;
      const address = await asOwner(
        request(target.server).get('/api/local-browser/state?sessionId=fixture-chat')
      )
        .set('X-Viewer-Id', viewer.viewerId)
        .set('X-Viewer-Nonce', viewer.nonce);
      expect(address.status).toBe(200);
      expect(address.body.viewerAddress.receipt).toMatch(/^[\w-]{43}$/);
      const painted = await post('frame', {
        nonce: viewer.nonce,
        receipt: pixels.headers['x-frame-receipt'],
        paint: {
          addressReceipt: address.body.viewerAddress.receipt,
          viewportGeneration: view.viewport.generation,
        },
      });
      expect(painted.status).toBe(204);
      const meta = JSON.parse(painted.headers['x-viewer-metadata']);
      expect(meta.control.ready).toBe(true);
      const op = {
        nonce: viewer.nonce,
        controllerId: meta.control.id,
        controlEpoch: meta.control.epoch,
        navigationGeneration: meta.navigationGeneration,
        viewportGeneration: meta.viewport.generation,
        sequence: 1,
      };
      const edge = await post('input', {
        ...op,
        input: {
          kind: 'pointer',
          type: 'mousePressed',
          x: meta.viewport.width,
          y: 1,
          button: 'left',
          clickCount: 1,
        },
      });
      expect(edge.status).toBe(409);
      expect(edge.body.code).toBe('viewer_stale');
      const input = await post('input', {
        ...op,
        input: { kind: 'text', text: 'made-up typed marker' },
      });
      expect(input.status).toBe(200);
      expect(input.body.outcome.status).toBe('done');
      expect(f.contexts[0].pages[0].page.keyboard.insertText).toHaveBeenCalledWith(
        'made-up typed marker'
      );
      const duplicate = await post('input', {
        ...op,
        input: { kind: 'text', text: 'never twice' },
      });
      expect(duplicate.body.outcome.status).toBe('done');
      expect(f.contexts[0].pages[0].page.keyboard.insertText).not.toHaveBeenCalledWith(
        'never twice'
      );
      for (const session of f.protocolSessions) {
        const original = session.send.getMockImplementation()! as (
          method: string,
          params?: Record<string, unknown>
        ) => Promise<unknown>;
        session.send.mockImplementation(async (method: string, params?: { expression?: string }) =>
          method === 'Runtime.evaluate' &&
          String(params?.expression).includes('window.getSelection')
            ? { result: { value: { text: 'made-up selected marker', password: false } } }
            : original(method, params)
        );
      }
      const copied = await post('copy', { ...op, sequence: 2 });
      expect(copied.body.text).toBe('made-up selected marker');
      const copyReplay = await post('copy', { ...op, sequence: 2 });
      expect(copyReplay.body.text).toBeUndefined();
      const pasted = await post('paste', { ...op, sequence: 3, text: 'made-up paste' });
      expect(pasted.body.outcome.status).toBe('done');
      const setFiles = vi.fn(
        async (_files: readonly { name: string; buffer: Buffer }[]) => undefined
      );
      f.contexts[0].pages[0].events.emit('filechooser', { isMultiple: () => false, setFiles });
      const chooserPoll = await post('frame', { nonce: viewer.nonce });
      expect(chooserPoll.status).toBe(204);
      const chooser = JSON.parse(chooserPoll.headers['x-viewer-metadata']).chooser;
      expect(chooser.host).toBe('example.com');
      const uploaded = await asOwner(
        request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/files`)
      )
        .set('X-Viewer-Control', JSON.stringify({ ...op, sequence: 4, ticketId: chooser.id }))
        .attach('files', Buffer.from('made-up file'), 'fixture.txt');
      expect(uploaded.status).toBe(200);
      expect(uploaded.body.outcome.status).toBe('done');
      expect(setFiles).toHaveBeenCalledTimes(1);
      const payload = setFiles.mock.calls[0][0][0];
      expect(payload.name).toBe('fixture.txt');
      expect(payload.buffer.every((b) => b === 0)).toBe(true);
      // No captured chooser: refuse before touching or buffering a multipart payload.
      const files = await asOwner(
        request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/files`)
      )
        .set('X-Viewer-Control', JSON.stringify({ ...op, sequence: 5, ticketId: 't'.repeat(43) }))
        .attach('files', Buffer.from('made-up file'), 'fixture.txt');
      expect(files.status).toBe(409);
      expect(files.body.code).toBe('viewer_stale');
      const ended = await post('hand-back', {
        nonce: viewer.nonce,
        controllerId: op.controllerId,
        controlEpoch: op.controlEpoch,
        action: 'resume',
      });
      expect(ended.status).toBe(200);
      expect(ended.body.metadata.control).toBeNull();
      await expect(f.observe('fixture-chat')).resolves.toBeDefined();
      const audit = JSON.stringify(db.select().from(auditEvents).all()),
        logs = JSON.stringify(logEntries);
      for (const value of [
        'made-up typed marker',
        'never twice',
        'made-up selected marker',
        'made-up paste',
        'made-up file',
      ]) {
        expect(audit).not.toContain(value);
        expect(logs).not.toContain(value);
      }
    } finally {
      await registry.close();
      await f.cleanup();
    }
  });

  it.each([
    ['malformed', { title: 12, text: '' }, false],
    ['over-cap', { title: '', text: 'x'.repeat(16_385) }, false],
    ['thrown read', null, true],
  ] as const)(
    'person Resume releases a first takeover refused by %s safety, without a controller',
    async (_label, value, throws) => {
      const f = await leaseFixture();
      activeService = f.service;
      try {
        await f.open('fixture-chat');
        f.contexts[0].pages[0].navigate('https://example.com');
        resolvePage.mockImplementation(f.service.viewerPages.resolve);
        const viewer = await subscribe();
        const attach = vi.mocked(f.contexts[0].context.newCDPSession);
        const original = attach.getMockImplementation()!;
        attach.mockImplementation(async (...args) => {
          const protocol = await original(...args);
          const send = protocol.send.bind(protocol);
          protocol.send = vi.fn(async (method, params) => {
            if (method === 'Runtime.evaluate' && params?.expression === PERSON_SAFETY_EXPRESSION) {
              if (throws) throw Error('Made-up safety read exception');
              return { result: { value } };
            }
            return send(method, params);
          }) as typeof protocol.send;
          return protocol;
        });
        const refused = await asOwner(
          request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/take-over`)
        ).send({ nonce: viewer.nonce });
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('viewer_unavailable');
        expect(refused.body.metadata?.control).toBeUndefined();
        await expect(f.observe('fixture-chat')).rejects.toBeDefined();
        const resumed = await asOwner(
          request(target.server).post('/api/local-browser/resume?sessionId=fixture-chat')
        ).send({});
        expect(resumed.status).toBe(200);
        await expect(f.observe('fixture-chat')).resolves.toBeDefined();
        expect(f.contexts[0].pages[0].page.keyboard.insertText).not.toHaveBeenCalled();
      } finally {
        await registry.close();
        await f.cleanup();
      }
    }
  );

  const verbs = ['take-over', 'input', 'hand-back', 'copy', 'paste', 'files'];
  it.each(verbs)(
    'S1: refuses a valid owner over the encrypted tunnel before parsing %s',
    async (verb) => {
      const viewer = await subscribe();
      resolvePage.mockClear();
      tunnelFacts = true;
      const response = await asOwner(
        request(target.server).post(`/api/browser-viewers/${viewer.viewerId}/${verb}`)
      )
        .set(
          'Content-Type',
          verb === 'files' ? 'multipart/form-data; boundary=fake' : 'application/json'
        )
        .send('{malformed');
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('viewer_local_only');
      expect(resolvePage).not.toHaveBeenCalled();
    }
  );
  it.each(verbs)('refuses missing app proof before malformed %s JSON', async (verb) => {
    const response = await request(target.server)
      .post(`/api/browser-viewers/${'v'.repeat(43)}/${verb}`)
      .set('Host', `localhost:${env.DORKOS_PORT}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .set('X-Client-Id', 'owner-window')
      .set('Content-Type', 'application/json')
      .send('{malformed');
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('viewer_person_only');
    expect(resolvePage).not.toHaveBeenCalled();
  });
  it.each(verbs)('refuses no cookie before malformed %s JSON', async (verb) => {
    const response = await request(target.server)
      .post(`/api/browser-viewers/${'v'.repeat(43)}/${verb}`)
      .set('Host', `localhost:${env.DORKOS_PORT}`)
      .set('Origin', origin)
      .set(PERSON_PROOF_HEADER, proof)
      .set('X-Client-Id', 'owner-window')
      .set('Content-Type', 'application/json')
      .send('{malformed');
    expect([401, 403]).toContain(response.status);
    expect(response.body.code).not.toBe('viewer_bad_request');
    expect(resolvePage).not.toHaveBeenCalled();
  });
  it.each(verbs)('keeps input flag off before parsing %s', async (verb) => {
    inputEnabled = false;
    const response = await asOwner(
      request(target.server).post(`/api/browser-viewers/${'v'.repeat(43)}/${verb}`)
    )
      .set('Content-Type', 'application/json')
      .send('{malformed');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('viewer_unavailable');
    expect(resolvePage).not.toHaveBeenCalled();
  });
  it.each(
    verbs.flatMap((verb) =>
      [
        'x-dorkos-agent',
        'authorization',
        'x-api-key',
        'proxy-authorization',
        'x-dorkos-approval',
      ].map((header) => [verb, header])
    )
  )(
    'refuses %s with mixed program header %s before oversized body parsing',
    async (verb, header) => {
      const response = await asOwner(
        request(target.server).post(`/api/browser-viewers/${'v'.repeat(43)}/${verb}`)
      )
        .set(header, 'not-a-person')
        .set('Content-Type', 'application/json')
        .send('x'.repeat(17 * 1024));
      expect([401, 403]).toContain(response.status);
      expect(response.body.code).not.toBe('viewer_bad_request');
      expect(resolvePage).not.toHaveBeenCalled();
    }
  );

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
      request(target.server).post('/api/local-browser/navigate?sessionId=fixture-chat')
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
    publish({
      sequence: 2,
      generation: 1,
      navigationGeneration: 0,
      controlEpoch: 0,
      viewport: { generation: 1, width: 640, height: 480, offsetTop: 0, scale: 1 },
      width: 640,
      height: 480,
      bytes: Buffer.from(marker),
    });
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
