/** @vitest-environment node */
/**
 * A person's review of expired and in-doubt document work over the mounted app
 * (spec `doc-channel` task 2.5): who may replay or clear, and what they see.
 * The delivery side (real expiry, boot recovery, one admission) is proven in
 * `services/canvas/doc-channel/__tests__/work-review-delivery.test.ts`.
 */
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
  canvasDocBatches,
  sessionMetadata,
  eq,
  type Db,
} from '@dorkos/db';
import { DOC_WORK_REVIEWED_EVENT } from '@dorkos/shared/canvas-doc-routes';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import type { HonoApiDeps } from '../../http/hono-api.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../services/rooms/index.js';
import { RoomRepoStore } from '../../services/rooms/repo/room-repo-store.js';
import { createDocChannelHttpComposition } from '../../services/canvas/doc-channel/http-composition.js';
import { DocWorkReview } from '../../services/canvas/doc-channel/route-controls/work-review.js';
import { decideAsPerson } from '../../services/canvas/doc-channel/route-controls/person-decision.js';
import { DocChannelNotFoundError } from '../../services/canvas/doc-channel/authorization.js';
import { ApprovalService } from '../../services/core/approvals/approval-service.js';
import { initAuth, readOwnerAccount } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createServerPrincipal } from '../../services/connectors/principal/server-principal.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { env } from '../../env.js';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
const origin = `http://localhost:${env.DORKOS_PORT}`;
const ACCOUNT = { email: 'owner@dork.test', password: 'correct-horse-battery-staple' };
const deps: HonoApiDeps = {};
const fixture = swappableServer();
const server = fixture.server;
let dir: string;
let db: Db;
let cookies: string[];
/** The owner's session, sent for every request that names no caller. */
let personCookie = '';
let rooms: RoomSubsystem;
let http: ReturnType<typeof createDocChannelHttpComposition>;
let review: DocWorkReview;
let approvals: ApprovalService;
let onChanged: ReturnType<typeof vi.fn<() => void>>;
let project: string;
let agentId: string;
let sessionId: string;
let documentId: string;

const endpoint = () => `/api/canvas/docs/${documentId}`;
const list = () => request(server).get(`${endpoint()}/work`);
const act = (batchId: string, action: 'replay' | 'clear', body: object = {}) =>
  request(server).post(`${endpoint()}/work/${batchId}/${action}`).send(body);
function operator(owner = { kind: 'user' as const, userId: readOwnerAccount()!.id }) {
  return {
    surface: 'http' as const,
    principal: createServerPrincipal({ kind: 'operator', owner }),
  };
}
const batchRow = (batchId: string) =>
  db.select().from(canvasDocBatches).where(eq(canvasDocBatches.batchId, batchId)).get();
const batchCount = () =>
  db.select().from(canvasDocBatches).where(eq(canvasDocBatches.documentId, documentId)).all()
    .length;

/** A route the owner agent answers, allowed by a person. */
function allowTasks() {
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
  const input = {
    documentId,
    routeId: 'tasks',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const pending = http.grants.grant(input, operator());
  if (pending.kind !== 'approval_required') throw new Error('Expected approval');
  approvals.grant(pending.ticket.approvalId);
  const granted = http.grants.grant(input, operator(), pending.ticket.token);
  if (granted.kind !== 'granted') throw new Error('Expected grant');
}

/** One accepted event, its batch moved to the review state the pump or boot recovery would. */
async function work(status: 'expired' | 'in_doubt'): Promise<string> {
  const posted = await request(server)
    .post(`${endpoint()}/events`)
    .send({ v: 1, id: randomUUID(), type: 'task.changed', payload: { secret: 'PAYLOAD_SECRET' } });
  expect(posted.status).toBe(201);
  const batchId = posted.body.deliveries[0].batchId as string;
  db.update(canvasDocBatches)
    .set(status === 'expired' ? { status, errorCode: 'manual_replay_required' } : { status })
    .where(eq(canvasDocBatches.batchId, batchId))
    .run();
  return batchId;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-work-'));
  initConfigManager(dir);
  db = createDb(path.join(dir, 'work.db'));
  runMigrations(db);
  initAuth(db, dir);
  configManager.set('auth', { enabled: false });
  const listener = composedListener(new MainRequestAdmission(), deps);
  // A test-only header stands in for the Wi-Fi listener's own ingress mark.
  fixture.mount((req, res) => {
    if (req.headers['x-test-ingress'] === 'wifi') markIngress(req, 'wifi');
    // With no password asked here, a request naming no caller is the owner in
    // their own browser, which holds their session once an owner exists
    // (DOR-3330). With the password on, it stays nobody.
    const named = ['cookie', 'authorization', 'x-dorkos-agent', 'x-dorkos-approval'].some(
      (name) => req.headers[name] !== undefined
    );
    const asks = configManager.get('auth')?.enabled === true;
    if (!named && !asks && personCookie) req.headers.cookie = personCookie;
    return listener(req, res);
  });
  expect(
    (
      await request(server)
        .post('/api/auth/sign-up/email')
        .set('Origin', origin)
        .send({ ...ACCOUNT, name: 'Owner' })
    ).status
  ).toBe(200);
  const login = await request(server)
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .send(ACCOUNT);
  expect(login.status).toBe(200);
  cookies = login.headers['set-cookie'] as unknown as string[];
  personCookie = cookies.map((value) => value.split(';')[0]).join('; ');
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
  onChanged = vi.fn<() => void>();
  review = new DocWorkReview({
    db,
    channels: http.channels,
    grants: http.grants,
    authorization: http.authorization,
    readChannel: (id, actor) => http.service.readChannel(id, actor),
    onChanged,
  });
  deps.docChannel = { ...http, workReview: review };
  project = fs.mkdtempSync(path.join(dir, 'source-'));
  fs.writeFileSync(path.join(project, 'tasks.md'), 'Tasks');
  sessionId = randomUUID();
  agentId = randomUUID();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: agentId,
      name: 'Scout',
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
    type: 'file',
    sourcePath: path.join(project, 'tasks.md'),
  }).id;
});
afterEach(() => {
  configManager.set('auth', { enabled: false });
  resetAgentIdentityService();
  delete deps.activity;
  vi.restoreAllMocks();
});
afterAll(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('document work review over the mounted app', () => {
  it('lists nothing for a document with nothing to review', async () => {
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toEqual({ documentId, items: [] });
  });

  it('lists expired and in-doubt work, oldest first, without any event payload', async () => {
    allowTasks();
    const expired = await work('expired');
    const uncertain = await work('in_doubt');
    // A live batch is not review work.
    await request(server)
      .post(`${endpoint()}/events`)
      .send({ v: 1, id: randomUUID(), type: 'task.changed', payload: {} });
    const listed = await list();
    expect(listed.status).toBe(200);
    expect(listed.body.items).toEqual([
      expect.objectContaining({ batchId: expired, status: 'expired', eventCount: 1 }),
      expect.objectContaining({ batchId: uncertain, status: 'in_doubt', eventCount: 1 }),
    ]);
    // Newer pending work holds the route, and the list says so rather than offering a replay.
    expect(listed.body.items.map((item: { replay: string }) => item.replay)).toEqual([
      'route_busy',
      'route_busy',
    ]);
    expect(JSON.stringify(listed.body)).not.toMatch(/PAYLOAD_SECRET|projectPath|grantId/);
  });

  it('replays expired work once, records it, and wakes delivery', async () => {
    allowTasks();
    const batchId = await work('expired');
    expect((await list()).body.items[0].replay).toBe('ready');
    const emit = vi.fn().mockResolvedValue(undefined);
    deps.activity = { emit } as unknown as HonoApiDeps['activity'];
    const replayed = await act(batchId, 'replay');
    expect(replayed.status).toBe(200);
    expect(replayed.headers['cache-control']).toBe('no-store');
    expect(replayed.body).toMatchObject({
      batchId,
      routeId: 'tasks',
      action: 'replayed',
      previousStatus: 'expired',
    });
    const next = batchRow(replayed.body.nextBatchId)!;
    expect(next.status).toBe('pending');
    expect(next.generation).not.toBe(batchRow(batchId)!.generation);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        eventType: DOC_WORK_REVIEWED_EVENT,
        category: 'permissions',
        actorType: 'user',
        resourceId: documentId,
        summary: expect.stringContaining('ran expired document work again on route tasks'),
        metadata: expect.objectContaining({ action: 'replayed', previousStatus: 'expired' }),
      })
    );
    expect(JSON.stringify(emit.mock.calls)).not.toMatch(/PAYLOAD_SECRET/);
    // Double submit: the second is refused and creates nothing.
    const again = await act(batchId, 'replay');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('WORK_ALREADY_REVIEWED');
    expect(batchCount()).toBe(2);
    expect((await list()).body.items).toEqual([]);
  });

  it('runs in-doubt work again only when the person confirms it may repeat', async () => {
    allowTasks();
    const batchId = await work('in_doubt');
    const unconfirmed = await act(batchId, 'replay');
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe('CONFIRM_REPEAT_REQUIRED');
    expect(batchRow(batchId)!.status).toBe('in_doubt');
    expect((await act(batchId, 'replay', { confirmRepeat: false })).status).toBe(400);
    const confirmed = await act(batchId, 'replay', { confirmRepeat: true });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.previousStatus).toBe('in_doubt');
    expect(batchRow(batchId)!.status).toBe('cancelled');
  });

  it('clears work without a grant, and refuses replay without one', async () => {
    allowTasks();
    const expired = await work('expired');
    http.grants.revokeRoute(documentId, 'tasks', operator());
    expect((await list()).body.items[0].replay).toBe('no_grant');
    const refused = await act(expired, 'replay');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GRANT_REQUIRED');
    expect(batchCount()).toBe(1);
    const cleared = await act(expired, 'clear');
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ action: 'cleared', nextBatchId: null });
    expect(batchRow(expired)!.errorCode).toBe('manual_review_cleared');
    expect((await list()).body.items).toEqual([]);
  });

  it('refuses an unrelated or stale batch id and a malformed request', async () => {
    allowTasks();
    const batchId = await work('expired');
    const unknown = await act(randomUUID(), 'replay');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('WORK_NOT_FOUND');
    // Another document's work is as absent as none.
    const other = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'url',
      url: `https://example.test/${randomUUID()}`,
    }).id;
    const elsewhere = await request(server)
      .post(`/api/canvas/docs/${other}/work/${batchId}/replay`)
      .send({});
    expect(elsewhere.status).toBe(404);
    expect((await act(batchId, 'replay', { grantId: 'mine' })).status).toBe(400);
    expect(
      (await request(server).post(`${endpoint()}/work/${batchId}/replay?force=1`).send({})).status
    ).toBe(400);
    expect(batchRow(batchId)!.errorCode).toBe('manual_replay_required');
  });

  it('refuses an agent caller at every write and the read, verified or not', async () => {
    allowTasks();
    const batchId = await work('expired');
    const token = await initAgentIdentityService(db).mint({
      agentPath: project,
      displayName: 'Scout',
    });
    for (const action of ['replay', 'clear'] as const) {
      const refused = await request(server)
        .post(`${endpoint()}/work/${batchId}/${action}`)
        .set('X-DorkOS-Agent', token)
        .send({});
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('AGENT_CANNOT_DECIDE');
      const unverified = await request(server)
        .post(`${endpoint()}/work/${batchId}/${action}`)
        .set('X-DorkOS-Agent', 'not-a-token')
        .send({});
      expect(unverified.status).toBe(403);
    }
    const requester = await request(server)
      .post(`${endpoint()}/work/${batchId}/replay`)
      .set('X-DorkOS-Approval', 'held-token')
      .send({});
    expect(requester.body.code).toBe('REQUESTER_CANNOT_DECIDE');
    const read = await list().set('X-DorkOS-Agent', token);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('PERSON_REQUIRED');
    expect(batchRow(batchId)!.errorCode).toBe('manual_replay_required');
    expect(batchCount()).toBe(1);
  });

  it('refuses a caller who does not own the document, even with a person’s decision', async () => {
    allowTasks();
    const batchId = await work('expired');
    // A signed-in person's cookie: the decision is real, only the owner is wrong.
    const minted = decideAsPerson({
      headers: { host: `localhost:${env.DORKOS_PORT}` },
      peerAddress: '127.0.0.1',
      user: { userId: readOwnerAccount()!.id, credential: 'cookie' },
    } as Parameters<typeof decideAsPerson>[0]);
    if (!('decision' in minted)) throw new Error(JSON.stringify(minted));
    const stranger = operator({ kind: 'user', userId: 'someone-else' });
    await expect(
      review.replay(documentId, batchId, {}, stranger, minted.decision)
    ).rejects.toBeInstanceOf(DocChannelNotFoundError);
    await expect(
      review.clear(documentId, batchId, {}, stranger, minted.decision)
    ).rejects.toBeInstanceOf(DocChannelNotFoundError);
    await expect(review.list(documentId, stranger)).rejects.toBeInstanceOf(DocChannelNotFoundError);
    // A decision the person bars did not mint is refused too.
    await expect(
      review.replay(documentId, batchId, {}, operator(), { posture: 'local-trust' })
    ).rejects.toMatchObject({ code: 'PERSON_REQUIRED' });
    expect(batchRow(batchId)!.errorCode).toBe('manual_replay_required');
  });

  it('keeps login on behind the session gate and refuses an API key', async () => {
    allowTasks();
    const batchId = await work('expired');
    configManager.set('auth', { enabled: true });
    expect((await list()).status).toBe(401);
    expect((await act(batchId, 'replay')).status).toBe(401);
    const created = await request(server)
      .post('/api/auth/api-key/create')
      .set('Cookie', cookies)
      .set('Origin', origin)
      .send({ name: 'work' });
    expect(created.status).toBe(200);
    const keyed = await act(batchId, 'replay').set('Authorization', `Bearer ${created.body.key}`);
    expect(keyed.status).toBe(403);
    expect(keyed.body.code).toBe('operator_cookie_required');
    const signedIn = await act(batchId, 'replay').set('Cookie', cookies);
    expect(signedIn.status).toBe(200);
  });

  it('lets a person replay and clear from Wi-Fi: one run under an allowed route', async () => {
    allowTasks();
    const expired = await work('expired');
    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-test-ingress', 'wifi')
      .send(ACCOUNT);
    expect(signIn.status).toBe(200);
    const wifi = signIn.headers['set-cookie'] as unknown as string[];
    const replayed = await act(expired, 'replay').set('x-test-ingress', 'wifi').set('Cookie', wifi);
    expect(replayed.status).toBe(200);
    const pending = replayed.body.nextBatchId as string;
    // The replayed work becomes in-doubt work in its turn, and Wi-Fi can clear it.
    db.update(canvasDocBatches)
      .set({ status: 'in_doubt' })
      .where(eq(canvasDocBatches.batchId, pending))
      .run();
    const cleared = await act(pending, 'clear').set('x-test-ingress', 'wifi').set('Cookie', wifi);
    expect(cleared.status).toBe(200);
  });

  it('runs in-doubt work again from Wi-Fi once the person confirms it may repeat', async () => {
    allowTasks();
    const uncertain = await work('in_doubt');
    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-test-ingress', 'wifi')
      .send(ACCOUNT);
    expect(signIn.status).toBe(200);
    const wifi = signIn.headers['set-cookie'] as unknown as string[];
    const unconfirmed = await act(uncertain, 'replay')
      .set('x-test-ingress', 'wifi')
      .set('Cookie', wifi);
    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body.code).toBe('CONFIRM_REPEAT_REQUIRED');
    const confirmed = await act(uncertain, 'replay', { confirmRepeat: true })
      .set('x-test-ingress', 'wifi')
      .set('Cookie', wifi);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ action: 'replayed', previousStatus: 'in_doubt' });
    expect(batchRow(uncertain)).toMatchObject({
      status: 'cancelled',
      errorCode: 'in_doubt_replayed',
    });
  });

  it('refuses a replay while newer work holds the route, and says so truthfully', async () => {
    allowTasks();
    const uncertain = await work('in_doubt');
    // Newer input on the same route waits behind the uncertain work.
    await request(server)
      .post(`${endpoint()}/events`)
      .send({ v: 1, id: randomUUID(), type: 'task.changed', payload: {} });
    const refused = await act(uncertain, 'replay', { confirmRepeat: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      code: 'ROUTE_BUSY',
      error: 'Newer work is waiting on this route, so this can’t run again now.',
    });
    expect(batchRow(uncertain)!.status).toBe('in_doubt');
    expect(batchCount()).toBe(2);
  });

  it('shows work as route_changed once its route was redeclared under the same id', async () => {
    allowTasks();
    const expired = await work('expired');
    http.grants.revokeRoute(documentId, 'tasks', operator());
    http.grants.configure(
      documentId,
      {
        routes: [
          {
            id: 'tasks',
            on: 'task.*',
            to: 'agent:owner',
            turn: { mode: 'immediate', maxBatch: 10 },
          },
        ],
      },
      operator(),
      agentId
    );
    const input = {
      documentId,
      routeId: 'tasks',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const pending = http.grants.grant(input, operator());
    if (pending.kind !== 'approval_required') throw new Error('Expected approval');
    approvals.grant(pending.ticket.approvalId);
    expect(http.grants.grant(input, operator(), pending.ticket.token).kind).toBe('granted');
    expect((await list()).body.items[0].replay).toBe('route_changed');
    const refused = await act(expired, 'replay');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ROUTE_CHANGED');
    expect(batchCount()).toBe(1);
  });
});
