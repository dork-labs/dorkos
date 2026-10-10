/** @vitest-environment node */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  createDb,
  runMigrations,
  agents,
  sessionMetadata,
  canvasDocChannels,
  canvasDocEvents,
  user,
  account,
  sql,
  eq,
  type Db,
} from '@dorkos/db';
import { createApp, finalizeApp } from '../../app.js';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../services/rooms/index.js';
import { RoomRepoStore } from '../../services/rooms/repo/room-repo-store.js';
import { createDocChannelHttpComposition } from '../../services/canvas/doc-channel/http-composition.js';
import { ApprovalService } from '../../services/core/approvals/approval-service.js';
import { initAuth, readOwnerAccount, getAuth } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createServerPrincipal } from '../../services/connectors/principal/server-principal.js';
import { DocChannelMetrics } from '../../services/observability/doc-channel-metrics.js';
import { DocChannelService } from '../../services/canvas/doc-channel/service.js';
import { logger } from '../../lib/logger.js';
import { env } from '../../env.js';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
const origin = `http://localhost:${env.DORKOS_PORT}`;
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>;
const fixture = swappableServer();
const server = fixture.server;
let cookies: string[];
let memberCookies: string[];
let apiKey: string;
let metrics: DocChannelMetrics;
let rooms: RoomSubsystem;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let approvals: ApprovalService;
let sessionId: string;
let agentId: string;
let project: string;
let documentId: string;
const event = (payload: unknown = { done: true }) => ({
  v: 1 as const,
  id: randomUUID(),
  type: 'task.changed',
  payload,
});
const endpoint = () => `/api/canvas/docs/${documentId}`;
const post = (body: object) => request(server).post(`${endpoint()}/events`).send(body);
function operator() {
  return {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'user', userId: readOwnerAccount()!.id },
    }),
  };
}
function localDocument() {
  documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
    type: 'file',
    sourcePath: path.join(project, 'tasks.md'),
  }).id;
}
function manifest(types: Record<string, unknown>, limits?: Record<string, number>) {
  fs.mkdirSync(path.join(project, '.dork'), { recursive: true });
  fs.writeFileSync(
    path.join(project, '.dork/app.json'),
    JSON.stringify({ v: 1, types, ...(limits ? { limits } : {}) })
  );
}
function configure() {
  http.grants.configure(
    documentId,
    {
      routes: [
        {
          id: 'tasks',
          on: 'task.*',
          to: 'agent:owner',
          turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
        },
      ],
    },
    operator(),
    agentId
  );
}
function grant(limits?: { envelopeBytes?: number; eventsPerMinute?: number }) {
  const input = {
    documentId,
    routeId: 'tasks',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    limits,
  };
  const pending = http.grants.grant(input, operator());
  if (pending.kind !== 'approval_required') throw new Error('Expected approval');
  approvals.grant(pending.ticket.approvalId);
  const granted = http.grants.grant(input, operator(), pending.ticket.token);
  if (granted.kind !== 'granted') throw new Error('Expected grant');
  return granted.grant;
}
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-metrics-http-'));
  initConfigManager(dir);
  db = createDb(path.join(dir, 'http.db'));
  runMigrations(db);
  initAuth(db, dir);
  configManager.set('auth', { enabled: false });
  const admission = new MainRequestAdmission();
  app = createApp({ admission });
  finalizeApp(app);
  fixture.mount(composedListener(app, admission));
  const signup = await request(server)
    .post('/api/auth/sign-up/email')
    .set('Origin', origin)
    .send({ email: 'owner@dork.test', password: 'correct-horse-battery-staple', name: 'Owner' });
  expect(signup.status).toBe(200);
  const login = await request(server)
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .send({ email: 'owner@dork.test', password: 'correct-horse-battery-staple' });
  expect(login.status).toBe(200);
  cookies = login.headers['set-cookie'] as unknown as string[];
  const owner = db.select().from(user).get()!;
  const credential = db.select().from(account).get()!;
  const memberId = randomUUID();
  // Seed a future invited member, then use the actual password/session endpoints.
  db.insert(user)
    .values({ ...owner, id: memberId, email: 'member@dork.test', role: 'member' })
    .run();
  db.insert(account)
    .values({ ...credential, id: randomUUID(), accountId: memberId, userId: memberId })
    .run();
  const memberLogin = await request(server)
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .send({ email: 'member@dork.test', password: 'correct-horse-battery-staple' });
  expect(memberLogin.status).toBe(200);
  memberCookies = memberLogin.headers['set-cookie'] as unknown as string[];
  apiKey = (await getAuth()!.api.createApiKey({ body: { userId: owner.id, name: 'metrics-http' } }))
    .key;
});
beforeEach(() => {
  configManager.set('auth', { enabled: false });
  rooms = createRoomSubsystem({ db });
  setRoomService(rooms.service);
  approvals = new ApprovalService(db);
  http = createDocChannelHttpComposition({
    db,
    documents: rooms.canvasDocuments,
    rooms: rooms.service,
    roomStore: rooms.store,
    roomRepos: new RoomRepoStore(db, dir),
    approvals,
    installationId: 'test-install',
  });
  metrics = new DocChannelMetrics(db);
  app.locals.docChannelHttp = { ...http, metrics };
  app.locals.debugDeps = { docChannelMetrics: metrics };
  project = fs.mkdtempSync(path.join(dir, 'source-'));
  fs.writeFileSync(path.join(project, 'tasks.md'), 'Tasks');
  sessionId = randomUUID();
  agentId = randomUUID();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: agentId,
      name: 'test',
      runtime: 'claude-code',
      projectPath: project,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: 'claude-code', agentPath: project, createdAt: now })
    .run();
  documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
    type: 'url',
    url: `https://example.test/${sessionId}`,
  }).id;
});
afterEach(() => {
  configManager.set('auth', { enabled: false });
  resetAgentIdentityService();
  vi.restoreAllMocks();
});
afterAll(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const debug = () => request(server).get('/api/debug/doc-channels');
const attempts = () => metrics.readCommittedSnapshot().requestAttempts;
const unavailable = {
  code: 'DOC_CHANNEL_METRICS_UNAVAILABLE',
  error: 'Document metrics are not available.',
};

describe('document metrics through the full app', () => {
  it('allows the real owner cookie and denies member, API key, agent and approval credentials', async () => {
    configManager.set('auth', { enabled: true });
    expect((await debug()).status).toBe(401);
    expect((await debug().set('Cookie', cookies)).body.window).toBe('retained_current_state');
    expect((await debug().set('Cookie', memberCookies)).status).toBe(403);
    expect((await debug().set('Authorization', `Bearer ${apiKey}`)).status).toBe(403);
    expect((await debug().set('Cookie', cookies).set('X-DorkOS-Agent', 'forged')).status).toBe(403);
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: project, displayName: 'test' });
    expect((await debug().set('Cookie', cookies).set('X-DorkOS-Agent', token)).status).toBe(403);
    expect((await debug().set('Cookie', cookies).set('X-DorkOS-Approval', 'token')).status).toBe(
      403
    );
  });
  it('keeps login-off local access behind HostGuard and the same agent bar', async () => {
    expect((await debug()).status).toBe(200);
    expect((await debug().set('Host', 'attacker.test')).status).toBe(403);
    expect((await debug().set('X-DorkOS-Agent', 'forged')).status).toBe(403);
    expect((await debug().set('X-DorkOS-Approval', 'token')).status).toBe(403);
  });
  it('fails closed when the real owner lookup is empty, even with a cached owner cookie', async () => {
    configManager.set('auth', { enabled: true });
    const cached = await request(server).get('/api/auth/get-session').set('Cookie', cookies);
    const cachedCookies = [
      ...cookies,
      ...((cached.headers['set-cookie'] ?? []) as unknown as string[]),
    ];
    db.$client.exec('BEGIN');
    db.delete(user).run();
    try {
      expect(readOwnerAccount()).toBeNull();
      expect((await debug().set('Cookie', cachedCookies)).status).toBe(403);
    } finally {
      db.$client.exec('ROLLBACK');
    }
  });
  it('returns the same constant 503 for absent instance, native transaction and failed SQL', async () => {
    delete app.locals.debugDeps;
    expect((await debug()).body).toEqual(unavailable);
    app.locals.debugDeps = { docChannelMetrics: metrics };
    db.$client.exec('BEGIN');
    try {
      const res = await debug();
      expect(res.status).toBe(503);
      expect(res.body).toEqual(unavailable);
    } finally {
      db.$client.exec('ROLLBACK');
    }
    db.$client.exec('ALTER TABLE canvas_doc_batches RENAME TO temporarily_missing_batches');
    try {
      const res = await debug();
      expect(res.status).toBe(503);
      expect(res.body).toEqual(unavailable);
    } finally {
      db.$client.exec('ALTER TABLE temporarily_missing_batches RENAME TO canvas_doc_batches');
    }
  });
  it('counts actual parser and schema refusals once and leaves early app denials uncounted', async () => {
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('Content-Type', 'application/json')
          .send('{')
      ).status
    ).toBe(400);
    expect((await post(event({ text: 'x'.repeat(17000) }))).status).toBe(413);
    expect((await post({ ...event(), scope: 'forged' })).status).toBe(400);
    expect((await post(event()).set('Host', 'attacker.test')).status).toBe(403);
    configManager.set('auth', { enabled: true });
    expect((await post(event())).status).toBe(401);
    expect(attempts().rejectedRequestsByClass).toMatchObject({
      invalid: 2,
      too_large: 1,
      authority: 0,
    });
    expect(Object.values(attempts().rejectedRequestsByClass).reduce((a, b) => a + b, 0)).toBe(3);
  });
  it.each([
    {
      label: 'malformed JSON',
      body: '{',
      status: 400,
      code: 'INVALID_DOC_EVENT',
      reason: 'invalid',
      error: 'The document event is not valid.',
      variant: 'EVENTS',
    },
    {
      label: 'oversized JSON',
      body: JSON.stringify({ text: 'x'.repeat(17000) }),
      status: 413,
      code: 'DOC_EVENT_TOO_LARGE',
      reason: 'too_large',
      error: 'The document event is too large.',
      variant: 'EvEnTs',
    },
  ] as const)('counts parser refusals for $label case variants', async (scenario) => {
    localDocument();
    configManager.set('auth', { enabled: true });
    for (const suffix of ['events', scenario.variant]) {
      const response = await request(server)
        .post(`${endpoint()}/${suffix}`)
        .set('Cookie', cookies)
        .set('Content-Type', 'application/json')
        .send(scenario.body);
      expect(response.status).toBe(scenario.status);
      expect(response.body).toEqual({ code: scenario.code, error: scenario.error });
    }
    expect(attempts().rejectedRequestsByClass[scenario.reason]).toBe(2);
    // The same mounted uppercase route also reaches schema validation for valid JSON.
    for (const suffix of ['events', 'EVENTS']) {
      const response = await request(server)
        .post(`${endpoint()}/${suffix}`)
        .set('Cookie', cookies)
        .send({});
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        code: 'INVALID_DOC_EVENT',
        error: 'The document event or query is not valid.',
      });
    }
    expect(attempts().rejectedRequestsByClass.invalid).toBe(scenario.reason === 'invalid' ? 4 : 2);
    expect((await debug().set('Cookie', cookies)).body.requestAttempts).toEqual(attempts());
  });
  it('preserves real duplicate, rate Retry-After, manifest, conflict, storage and authority outcomes', async () => {
    localDocument();
    manifest({
      'task.changed': {
        type: 'object',
        required: ['done'],
        properties: { done: { type: 'boolean' } },
        additionalProperties: false,
      },
    });
    configure();
    grant({ eventsPerMinute: 1 });
    const input = event();
    expect((await post(input)).status).toBe(201);
    expect((await post(input)).status).toBe(200);
    expect((await post({ ...input, payload: { done: false } })).status).toBe(409);
    const limited = await post(event());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await post(event({ wrong: true }))).status).toBe(422);
    documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'url',
      url: 'https://example.test/storage',
    }).id;
    db.$client.exec(
      "CREATE TRIGGER fail_metrics_input BEFORE INSERT ON canvas_doc_events BEGIN SELECT RAISE(ABORT,'forced'); END;"
    );
    const failed = event();
    try {
      expect((await post(failed)).status).toBe(507);
      expect(http.channels.getEvent(documentId, failed.id)).toBeUndefined();
    } finally {
      db.$client.exec('DROP TRIGGER fail_metrics_input');
    }
    documentId = 'missing';
    expect((await post(event())).status).toBe(404);
    expect(attempts().rejectedRequestsByClass).toMatchObject({
      conflict: 1,
      rate_backlog: 1,
      manifest: 1,
      storage: 1,
      authority: 1,
    });
    expect(Object.values(attempts().rejectedRequestsByClass).reduce((a, b) => a + b, 0)).toBe(5);
  });
  it('records closed-channel refusal and an actual uncomposed acceptance engine as separate classes', async () => {
    db.update(canvasDocChannels)
      .set({ closedAt: new Date().toISOString() })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
    expect((await post(event())).status).toBe(404);
    documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'url',
      url: 'https://example.test/not-composed',
    }).id;
    app.locals.docChannelHttp = {
      ...http,
      metrics,
      service: new DocChannelService(rooms.canvasDocuments, http.channels, http.authorization),
    };
    const unavailable = await post(event());
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.code).toBe('DOC_CHANNEL_UNAVAILABLE');
    expect(attempts().rejectedRequestsByClass).toMatchObject({ authority: 1, unavailable: 1 });
  });
  it('counts only actual retention reset responses, including repeated reset attempts', async () => {
    const input = event();
    expect((await post(input)).status).toBe(201);
    const cold = await request(server).get(`${endpoint()}/channel?since=0`);
    expect(cold.body).toMatchObject({ retentionFloor: 1, resetRequired: false });
    expect(attempts().replayRetentionResetResponses).toBe(0);
    db.update(canvasDocEvents)
      .set({ payload: sql`'null'`, payloadPrunedAt: new Date().toISOString() })
      .where(eq(canvasDocEvents.eventId, input.id))
      .run();
    db.update(canvasDocChannels)
      .set({ retentionFloor: 2 })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
    for (let i = 0; i < 2; i++)
      expect((await request(server).get(`${endpoint()}/channel?since=0`)).body.resetRequired).toBe(
        true
      );
    expect((await request(server).get(`${endpoint()}/channel?since=1`)).body.resetRequired).toBe(
      false
    );
    expect((await request(server).get(`${endpoint()}/events/${input.id}`)).status).toBe(200);
    expect(attempts().replayRetentionResetResponses).toBe(2);
  });
  it('cannot retry, alter responses or log when the observer throws after finish', async () => {
    localDocument();
    configure();
    grant({ eventsPerMinute: 1 });
    const log = vi.spyOn(logger, 'error');
    const observer = vi.spyOn(metrics, 'recordHttpResult').mockImplementation(() => {
      throw new Error('private observer detail');
    });
    const input = event();
    const first = await post(input);
    const duplicate = await post(input);
    expect(first.status).toBe(201);
    expect(duplicate.status).toBe(200);
    expect(first.body.receipt.docSeq).toBe(1);
    expect(duplicate.body.receipt.docSeq).toBe(1);
    expect((await request(server).get(`${endpoint()}/channel`)).body.events).toEqual([
      expect.objectContaining({
        docSeq: 1,
        event: expect.objectContaining({
          id: input.id,
          type: input.type,
          direction: 'upstream',
          payload: input.payload,
        }),
      }),
      expect.objectContaining({
        docSeq: 2,
        event: expect.objectContaining({
          type: 'event.status',
          direction: 'system',
          payload: {
            eventId: input.id,
            routeId: 'tasks',
            status: 'pending',
            batchId: first.body.deliveries[0].batchId,
          },
        }),
      }),
    ]);
    expect((await post({ ...input, payload: { different: true } })).status).toBe(409);
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('Content-Type', 'application/json')
          .send('{')
      ).status
    ).toBe(400);
    const limited = await post(event());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect(observer).toHaveBeenCalledTimes(6);
    expect(log).not.toHaveBeenCalled();
  });
});
