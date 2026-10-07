/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  canvasDocBatches,
  agentIdentityTokens,
  sql,
  eq,
  type Db,
} from '@dorkos/db';
import { createApp, finalizeApp } from '../../app.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../services/rooms/index.js';
import { RoomRepoStore } from '../../services/rooms/repo/room-repo-store.js';
import { createDocChannelHttpComposition } from '../../services/canvas/doc-channel/http-composition.js';
import { replayServiceCurrentDoc } from '../../services/canvas/doc-channel/service.js';
import { ApprovalService } from '../../services/core/approvals/approval-service.js';
import { initAuth, readOwnerAccount } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createServerPrincipal } from '../../services/connectors/principal/server-principal.js';
import { env } from '../../env.js';
import { initBoundary } from '../../lib/boundary.js';

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
let rooms: RoomSubsystem;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let approvals: ApprovalService;
let sessionId: string;
let agentId: string;
let project: string;
let documentId: string;
let generation: string;
let stopWrites: (() => Promise<void>) | undefined;
const event = (payload: unknown = { done: true }) => ({
  v: 1 as const,
  id: randomUUID(),
  type: 'task.changed',
  payload,
});
const endpoint = () => `/api/canvas/docs/${documentId}`;
const post = (body: object) =>
  request(server)
    .post(`${endpoint()}/events`)
    .set('X-DorkOS-Doc-Generation', generation)
    .send(body);
async function captureGeneration(): Promise<void> {
  // Read the actual current server projection, without an extra observed HTTP request.
  const replay = await replayServiceCurrentDoc(http.service, documentId, operator());
  if (!replay.incarnation) throw new Error('Original document incarnation is unavailable.');
  generation = replay.incarnation.generation;
}
function operator() {
  return {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'user', userId: readOwnerAccount()!.id },
    }),
  };
}
async function localDocument(): Promise<void> {
  documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
    type: 'file',
    sourcePath: path.join(project, 'tasks.md'),
  }).id;
  await captureGeneration();
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
beforeEach(async () => {
  stopWrites = undefined;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-http-')));
  await initBoundary(dir);
  initConfigManager(dir);
  db = createDb(path.join(dir, 'http.db'));
  runMigrations(db);
  initAuth(db, dir);
  configManager.set('auth', { enabled: false });
  app = createApp({ admission: new MainRequestAdmission() });
  finalizeApp(app);
  fixture.mount(app);
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
});
beforeEach(async () => {
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
  const originalHttp = http;
  stopWrites = async () => {
    let failed = false;
    let cause: unknown;
    for (const result of await Promise.allSettled([
      Promise.resolve().then(() => originalHttp.stopCheckboxWrites()),
      Promise.resolve().then(() => originalHttp.stopFileWrites()),
    ])) {
      if (result.status === 'rejected' && !failed) {
        failed = true;
        cause = result.reason;
      }
    }
    if (failed) throw cause;
  };
  app.locals.docChannelHttp = http;
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
  await captureGeneration();
});
afterEach(async () => {
  configManager.set('auth', { enabled: false });
  resetAgentIdentityService();
  vi.restoreAllMocks();
  let failed = false;
  let cause: unknown;
  const remember = (error: unknown): void => {
    if (!failed) {
      failed = true;
      cause = error;
    }
  };
  try {
    await stopWrites?.();
  } catch (error) {
    remember(error);
  }
  // A rejected original writer drain cannot authorize releasing its native Db.
  if (!failed) {
    try {
      if (db.$client.open) db.$client.close();
      if (db.$client.open) throw new Error('Original HTTP fixture database remains open.');
    } catch (error) {
      remember(error);
    }
  }
  if (!failed) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      remember(error);
    }
  }
  if (failed) throw cause;
});

describe('mounted document HTTP endpoints', () => {
  it('records, duplicates and inspects the same retained receipt without launching a runtime', async () => {
    const input = event();
    const first = await post(input);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      receipt: { id: input.id, status: 'recorded', docSeq: 1 },
      deliveries: [],
    });
    const duplicate = await post(input);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.receipt).toMatchObject({ id: input.id, status: 'duplicate', docSeq: 1 });
    const receipt = await request(server)
      .get(`${endpoint()}/events/${input.id}`)
      .set('X-DorkOS-Doc-Generation', generation);
    expect(receipt.status).toBe(200);
    expect(receipt.body).toMatchObject({
      receipt: { status: 'recorded', docSeq: 1 },
      payloadAvailable: true,
    });
    expect(JSON.stringify(receipt.body)).not.toMatch(
      /provenance|approvalEvidence|acknowledgedBy|projectPath/
    );
  });
  it('returns ordered bounded pages and state without a cold-cursor reset', async () => {
    await post(event());
    await post(event());
    const page = await request(server).get(`${endpoint()}/channel?since=0&limit=1`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({
      highWatermark: 2,
      retentionFloor: 1,
      receiptRetentionFloor: 1,
      resetRequired: false,
      state: {},
      stateRev: 0,
    });
    expect(page.body.events).toHaveLength(1);
    const next = await request(server).get(`${endpoint()}/channel?since=1&limit=1`);
    expect(next.body.events[0].docSeq).toBe(2);
  });
  it.each([
    'limit=0',
    'limit=201',
    'limit=1x',
    'limit=1&limit=2',
    'since=-1',
    'since=9007199254740992',
    'unknown=1',
  ])('rejects malformed paging %s', async (query) => {
    expect((await request(server).get(`${endpoint()}/channel?${query}`)).status).toBe(400);
  });
  it('rejects empty/malformed JSON, reserved types and forged authority fields', async () => {
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
      ).status
    ).toBe(400);
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
          .set('Content-Type', 'application/json')
          .send('{')
      ).status
    ).toBe(400);
    expect((await post({ ...event(), type: 'doc.edited' })).status).toBe(400);
    for (const key of [
      'routes',
      'sender',
      'cwd',
      'forAgent',
      'permissions',
      'replyContext',
      'scope',
      'documentId',
    ])
      expect((await post({ ...event(), [key]: 'forged' })).status).toBe(400);
  });
  it('returns 409 for conflicting accepted identity and 413 for oversized data', async () => {
    const input = event();
    expect((await post(input)).status).toBe(201);
    expect((await post({ ...input, payload: { different: true } })).status).toBe(409);
    expect((await post(event({ text: 'x'.repeat(17000) }))).status).toBe(413);
  });
  it('keeps accepted retries before rate accounting and returns Retry-After for new input', async () => {
    await localDocument();
    configure();
    grant({ eventsPerMinute: 1 });
    const input = event();
    expect((await post(input)).status).toBe(201);
    const limited = await post(event());
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    expect((await post(input)).status).toBe(200);
  });
  it('accepts and retains new input while a destination batch is already running', async () => {
    await localDocument();
    configure();
    grant();
    const initial = await post(event());
    expect(initial.status).toBe(201);
    const batchId = initial.body.deliveries[0].batchId as string;
    db.update(canvasDocBatches)
      .set({ status: 'turn_started' })
      .where(eq(canvasDocBatches.batchId, batchId))
      .run();
    const input = event();
    const accepted = await post(input);
    expect(accepted.status).toBe(201);
    expect(accepted.body.receipt.status).toBe('recorded');
    expect(
      (
        await request(server)
          .get(`${endpoint()}/events/${input.id}`)
          .set('X-DorkOS-Doc-Generation', generation)
      ).status
    ).toBe(200);
    expect(accepted.body.deliveries[0].status).toBe('pending');
    expect(accepted.body.deliveries[0].batchId).not.toBe(batchId);
  });
  it('rechecks a verified room agent token after asynchronous access and before recording', async () => {
    const owner = rooms.authors.bindOwner(readOwnerAccount()!.id).id;
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Shared', members: [], agentPaths: [project] },
      owner
    );
    documentId = rooms.canvas.open(`room:${room.id}`, owner, {
      type: 'url',
      url: 'https://example.test/shared',
    }).id;
    await captureGeneration();
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: project, displayName: 'test' });
    expect(
      (await request(server).get(`${endpoint()}/channel`).set('X-DorkOS-Agent', token)).status
    ).toBe(200);
    const originalActor = http.actor.bind(http);
    let revoked = false;
    let revocationFailure: { cause: unknown } | undefined;
    vi.spyOn(http, 'actor').mockImplementation((...args) => {
      const actor = originalActor(...args);
      // Keep the genuine verified proof, then revoke during the original admission await.
      queueMicrotask(() => {
        try {
          db.update(agentIdentityTokens)
            .set({ revokedAt: new Date().toISOString() })
            .where(eq(agentIdentityTokens.agentPath, project))
            .run();
          revoked = true;
        } catch (cause) {
          revocationFailure = { cause };
        }
      });
      return actor;
    });
    const input = event();
    const response = await request(server)
      .post(`${endpoint()}/events`)
      .set('X-DorkOS-Doc-Generation', generation)
      .set('X-DorkOS-Agent', token)
      .send(input);
    if (revocationFailure) throw revocationFailure.cause;
    expect(response.status).toBe(404);
    expect(revoked).toBe(true);
    expect(http.channels.getEvent(documentId, input.id)).toBeUndefined();
  });
  it('honors the exact granted envelope ceiling', async () => {
    await localDocument();
    configure();
    grant({ envelopeBytes: 256 });
    expect((await post(event({ text: 'x'.repeat(500) }))).status).toBe(413);
    expect(http.channels.getChannel(documentId)?.nextDocSeq).toBe(1);
  });
  it('rolls back a SQLite failure and returns 507 without a partial event', async () => {
    db.$client.exec(
      "CREATE TRIGGER fail_doc_input BEFORE INSERT ON canvas_doc_events BEGIN SELECT RAISE(ABORT,'forced'); END;"
    );
    const input = event();
    try {
      expect((await post(input)).status).toBe(507);
      expect(http.channels.getEvent(documentId, input.id)).toBeUndefined();
      expect(http.channels.getChannel(documentId)?.nextDocSeq).toBe(1);
    } finally {
      db.$client.exec('DROP TRIGGER fail_doc_input');
    }
  });
  it('validates current manifests for new input while preserving accepted retry receipts after edits', async () => {
    await localDocument();
    manifest({
      'task.changed': {
        type: 'object',
        required: ['done'],
        properties: { done: { type: 'boolean' } },
        additionalProperties: false,
      },
    });
    configure();
    const granted = grant();
    const input = event();
    expect((await post(input)).status).toBe(201);
    expect((await post(event({ wrong: true }))).status).toBe(422);
    fs.writeFileSync(path.join(project, '.dork/app.json'), '{');
    expect((await post(input)).status).toBe(200);
    expect(http.channels.getGrant(granted.grantId)?.revokedAt).not.toBeNull();
    expect((await post(event())).status).toBe(422);
  });
  it('applies the canonical app root manifest to a nested document', async () => {
    fs.mkdirSync(path.join(project, 'nested'));
    const sourcePath = path.join(project, 'nested/tasks.md');
    fs.writeFileSync(sourcePath, 'Tasks');
    documentId = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'file',
      sourcePath,
    }).id;
    await captureGeneration();
    manifest({ 'task.changed': { type: 'object', required: ['done'] } });
    expect((await post(event({ wrong: true }))).status).toBe(422);
    expect(http.channels.getChannel(documentId)?.nextDocSeq).toBe(1);
  });
  it('refuses local-source authority when its server mapping is missing or escapes', async () => {
    const missing = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'file',
      sourcePath: path.join(project, 'tasks.md'),
    });
    documentId = missing.id;
    await captureGeneration();
    // Retain the genuine birth while invalidating its actual session mapping.
    db.delete(sessionMetadata).where(eq(sessionMetadata.sessionId, sessionId)).run();
    expect((await post(event())).status).toBe(403);
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: project,
        createdAt: new Date().toISOString(),
      })
      .run();
    await localDocument();
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    fs.unlinkSync(path.join(project, 'tasks.md'));
    fs.symlinkSync(outside, path.join(project, 'tasks.md'));
    expect((await post(event())).status).toBe(403);
  });
  it('reports unavailable during startup without silently accepting input', async () => {
    delete app.locals.docChannelHttp;
    expect((await post(event())).status).toBe(503);
  });
  it('keeps login-on reads and writes behind the actual session gate', async () => {
    configManager.set('auth', { enabled: true });
    expect((await post(event())).status).toBe(401);
    const input = event();
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
          .set('Cookie', cookies)
          .send(input)
      ).status
    ).toBe(201);
    expect(
      (
        await request(server)
          .get(`${endpoint()}/events/${input.id}`)
          .set('X-DorkOS-Doc-Generation', generation)
      ).status
    ).toBe(401);
    expect((await request(server).get(`${endpoint()}/channel`).set('Cookie', cookies)).status).toBe(
      200
    );
  });
  it('preserves host/origin guards on the mounted mutation', async () => {
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
          .set('Host', 'attacker.test')
          .send(event())
      ).status
    ).toBe(403);
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
          .set('Origin', 'https://attacker.test')
          .send(event())
      ).status
    ).toBeGreaterThanOrEqual(400);
  });
  it('refuses unknown agent headers and keeps session documents private from verified agents', async () => {
    expect(
      (await request(server).get(`${endpoint()}/channel`).set('X-DorkOS-Agent', 'unverified'))
        .status
    ).toBe(401);
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: project, displayName: 'test' });
    expect(
      (await request(server).get(`${endpoint()}/channel`).set('X-DorkOS-Agent', token)).status
    ).toBe(404);
  });
  it('checks current room membership before events, replay and receipts', async () => {
    const owner = rooms.authors.bindOwner(readOwnerAccount()!.id).id;
    const room = rooms.service.createRoom(
      { kind: 'channel', title: 'Private', members: [], agentPaths: [] },
      owner
    );
    documentId = rooms.canvas.open(`room:${room.id}`, owner, {
      type: 'url',
      url: 'https://example.test/room',
    }).id;
    await captureGeneration();
    const input = event();
    expect((await post(input)).status).toBe(201);
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: project, displayName: 'test' });
    for (const suffix of ['/channel', `/events/${input.id}`])
      expect(
        (
          await request(server)
            .get(`${endpoint()}${suffix}`)
            .set('X-DorkOS-Doc-Generation', generation)
            .set('X-DorkOS-Agent', token)
        ).status
      ).toBe(404);
    expect(
      (
        await request(server)
          .post(`${endpoint()}/events`)
          .set('X-DorkOS-Doc-Generation', generation)
          .set('X-DorkOS-Agent', token)
          .send(event())
      ).status
    ).toBe(404);
    documentId = 'missing';
    expect((await request(server).get(`${endpoint()}/channel`)).status).toBe(404);
  });
  it('exposes payload/reset and receipt floors without fabricating removed history', async () => {
    const input = event();
    await post(input);
    db.update(canvasDocEvents)
      .set({ payload: sql`'null'`, payloadPrunedAt: new Date().toISOString() })
      .where(eq(canvasDocEvents.eventId, input.id))
      .run();
    db.update(canvasDocChannels)
      .set({ retentionFloor: 2 })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
    const page = await request(server).get(`${endpoint()}/channel?since=0`);
    expect(page.body).toMatchObject({
      resetRequired: true,
      retentionFloor: 2,
      receiptRetentionFloor: 1,
      events: [],
    });
    expect(page.body.receipts[0].payloadAvailable).toBe(false);
  });
});
