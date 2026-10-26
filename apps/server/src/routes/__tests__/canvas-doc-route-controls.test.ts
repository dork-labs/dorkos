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
  approvals as approvalRows,
  canvasDocGrants,
  sessionMetadata,
  eq,
  type Db,
} from '@dorkos/db';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import type { HonoApiDeps } from '../../http/hono-api.js';
import {
  createRoomSubsystem,
  setRoomService,
  type RoomSubsystem,
} from '../../services/rooms/index.js';
import { RoomRepoStore } from '../../services/rooms/repo/room-repo-store.js';
import { createDocChannelHttpComposition } from '../../services/canvas/doc-channel/http-composition.js';
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
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { DocRouteGrantError } from '../../services/canvas/doc-channel/grant-policy.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));
const origin = `http://localhost:${env.DORKOS_PORT}`;
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
let approvals: ApprovalService;
let project: string;
let ownerAgentId: string;
let helperId: string;
let documentId: string;
let sessionId: string;

const endpoint = () => `/api/canvas/docs/${documentId}`;
const hour = () => new Date(Date.now() + 3_600_000).toISOString();
const ROUTES = (): CanvasChannelRoute[] => [
  { id: 'notes', on: 'note.*', to: 'log', turn: { mode: 'none' } },
  {
    id: 'tasks',
    on: 'task.*',
    to: 'agent:owner',
    turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
  },
  {
    id: 'helper',
    on: 'task.*',
    to: `agent:${helperId}`,
    turn: { mode: 'immediate', maxBatch: 10 },
  },
];
function operator() {
  return {
    surface: 'http' as const,
    principal: createServerPrincipal({
      kind: 'operator',
      owner: { kind: 'user', userId: readOwnerAccount()!.id },
    }),
  };
}
function declare(routes: CanvasChannelRoute[] = ROUTES()) {
  http.grants.configure(documentId, { routes }, operator(), ownerAgentId);
}
function agent(id: string, name: string, agentPath: string) {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id,
      name,
      runtime: 'claude-code',
      projectPath: agentPath,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(sessionMetadata)
    .values({ sessionId: randomUUID(), runtime: 'claude-code', agentPath, createdAt: now })
    .run();
}
const review = (routeId: string, expiresAt = hour()) =>
  request(server).post(`${endpoint()}/routes/${routeId}/review`).send({ expiresAt });
const approve = (routeId: string, body: object) =>
  request(server).post(`${endpoint()}/routes/${routeId}/approve`).send(body);
async function allow(routeId: string) {
  const reviewed = await review(routeId);
  expect(reviewed.status).toBe(200);
  const approved = await approve(routeId, {
    expiresAt: reviewed.body.expiresAt,
    reviewHash: reviewed.body.reviewHash,
  });
  expect(approved.status).toBe(200);
  return { reviewed: reviewed.body, route: approved.body.route };
}
const grantRows = () =>
  db.select().from(canvasDocGrants).where(eq(canvasDocGrants.documentId, documentId)).all();
const stateOf = async (routeId: string) =>
  (
    (await request(server).get(`${endpoint()}/routes`)).body.routes as {
      id: string;
      state: string;
    }[]
  ).find((route) => route.id === routeId)?.state;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-routes-'));
  initConfigManager(dir);
  db = createDb(path.join(dir, 'routes.db'));
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
  const account = { email: 'owner@dork.test', password: 'correct-horse-battery-staple' };
  expect(
    (
      await request(server)
        .post('/api/auth/sign-up/email')
        .set('Origin', origin)
        .send({ ...account, name: 'Owner' })
    ).status
  ).toBe(200);
  const login = await request(server)
    .post('/api/auth/sign-in/email')
    .set('Origin', origin)
    .send(account);
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
  deps.docChannel = http;
  project = fs.mkdtempSync(path.join(dir, 'owner-'));
  ownerAgentId = randomUUID();
  helperId = `helper-${randomUUID()}`;
  const now = new Date().toISOString();
  sessionId = randomUUID();
  db.insert(agents)
    .values({
      id: ownerAgentId,
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
  agent(helperId, 'Atlas', fs.mkdtempSync(path.join(dir, 'helper-')));
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

describe('document route controls over the mounted app', () => {
  it('lists every declared route as off until someone allows it', async () => {
    declare();
    const listed = await request(server).get(`${endpoint()}/routes`);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body.routes).toEqual([
      expect.objectContaining({
        id: 'notes',
        state: 'no_grant',
        grant: null,
        needsPerson: false,
        destination: { kind: 'log' },
      }),
      expect.objectContaining({
        id: 'tasks',
        state: 'no_grant',
        needsPerson: false,
        destination: { kind: 'owner', agentId: ownerAgentId, agentName: 'Scout' },
      }),
      expect.objectContaining({
        id: 'helper',
        state: 'no_grant',
        needsPerson: true,
        destination: { kind: 'agent', agentId: helperId, agentName: 'Atlas' },
      }),
    ]);
    expect(JSON.stringify(listed.body)).not.toMatch(
      /approvalEvidence|projectPath|sessionId|inputHash/
    );
  });

  it('answers an empty list for a document with no declaration', async () => {
    const listed = await request(server).get(`${endpoint()}/routes`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ documentId, routes: [] });
  });

  it('grants exactly the reviewed binding through a recorded person approval', async () => {
    declare();
    const { reviewed, route } = await allow('helper');
    expect(reviewed).toMatchObject({
      routeId: 'helper',
      on: 'task.*',
      destination: { kind: 'agent', agentId: helperId, agentName: 'Atlas' },
      allowedTypes: ['task.*'],
      limits: { envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 },
    });
    expect(route).toMatchObject({
      id: 'helper',
      state: 'granted',
      grant: { approvedBy: 'person' },
    });
    const [grant] = grantRows();
    expect(grant).toMatchObject({
      routeId: 'helper',
      targetAgentId: helperId,
      expiresAt: reviewed.expiresAt,
    });
    expect(grant!.approvalEvidence).toMatchObject({
      kind: 'operator_approval',
      inputHash: reviewed.reviewHash,
      binding: {
        target: { agentId: helperId },
        expiresAt: reviewed.expiresAt,
        allowedTypes: ['task.*'],
      },
    });
    const approval = db
      .select()
      .from(approvalRows)
      .where(eq(approvalRows.id, grant!.approvalId!))
      .get();
    expect(approval).toMatchObject({
      capabilityId: 'ui.approve_doc_route',
      state: 'granted',
      inputHash: reviewed.reviewHash,
      consumedAt: expect.any(String),
    });
    const current = http.grants.getCurrentRoutes(documentId, 'task.changed', operator());
    expect(current.find((item) => item.route.id === 'helper')?.grantId).toBe(grant!.grantId);
    expect(
      (await approve('helper', { expiresAt: hour(), reviewHash: reviewed.reviewHash })).status
    ).toBe(409);
  });

  it('refuses a review hash that does not match the details sent', async () => {
    declare();
    const reviewed = await review('helper');
    const approvalsBefore = db.select().from(approvalRows).all().length;
    const later = new Date(Date.now() + 7_200_000).toISOString();
    const refused = await approve('helper', {
      expiresAt: later,
      reviewHash: reviewed.body.reviewHash,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ROUTE_CHANGED');
    expect(grantRows()).toHaveLength(0);
    expect(db.select().from(approvalRows).all()).toHaveLength(approvalsBefore);
  });

  it('refuses an approval once the declaration changed after review', async () => {
    declare();
    const reviewed = await review('helper');
    declare(
      ROUTES().map((route) => (route.id === 'helper' ? { ...route, on: 'task.done' } : route))
    );
    const refused = await approve('helper', {
      expiresAt: reviewed.body.expiresAt,
      reviewHash: reviewed.body.reviewHash,
    });
    expect(refused.status).toBe(409);
    expect(grantRows()).toHaveLength(0);
  });

  it('refuses an expiry already in the past and an undeclared route', async () => {
    declare();
    const past = await review('helper', new Date(Date.now() - 1000).toISOString());
    expect(past.status).toBe(403);
    expect(past.body).toEqual({
      code: 'GRANT_EXPIRED',
      error: 'That end time has already passed. Pick a later one.',
    });
    const undeclared = await review('nowhere');
    expect(undeclared.body).toEqual({
      code: 'ROUTE_UNDECLARED',
      error: 'This document does not declare that route.',
    });
    expect(
      (await request(server).post(`${endpoint()}/routes/helper/review`).send({ expiresAt: 'soon' }))
        .status
    ).toBe(400);
  });

  it('refuses allowing a route from Wi-Fi, but still reviews and turns off there', async () => {
    declare();
    // A real Wi-Fi sign-in: the session it mints is held to the Wi-Fi level.
    const signIn = await request(server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('x-test-ingress', 'wifi')
      .send({ email: 'owner@dork.test', password: 'correct-horse-battery-staple' });
    expect(signIn.status).toBe(200);
    const wifi = signIn.headers['set-cookie'] as unknown as string[];
    const reviewed = await request(server)
      .post(`${endpoint()}/routes/helper/review`)
      .set('x-test-ingress', 'wifi')
      .set('Cookie', wifi)
      .send({ expiresAt: hour() });
    expect(reviewed.status).toBe(200);
    const approvalsBefore = db.select().from(approvalRows).all().length;
    const refused = await request(server)
      .post(`${endpoint()}/routes/helper/approve`)
      .set('x-test-ingress', 'wifi')
      .set('Cookie', wifi)
      .send({ expiresAt: reviewed.body.expiresAt, reviewHash: reviewed.body.reviewHash });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('NOT_FROM_WIFI');
    expect(grantRows()).toHaveLength(0);
    expect(db.select().from(approvalRows).all()).toHaveLength(approvalsBefore);
    await allow('helper');
    const off = await request(server)
      .post(`${endpoint()}/routes/helper/revoke`)
      .set('x-test-ingress', 'wifi')
      .set('Cookie', wifi)
      .send({});
    expect(off.status).toBe(200);
    expect(grantRows().every((row) => row.revokedAt !== null)).toBe(true);
    expect(await stateOf('helper')).not.toBe('granted');
  });

  it('refuses an agent caller at every write and every read, verified or not', async () => {
    declare();
    const token = await initAgentIdentityService(db).mint({
      agentPath: project,
      displayName: 'Scout',
    });
    const reviewed = await review('helper');
    const body = { expiresAt: reviewed.body.expiresAt, reviewHash: reviewed.body.reviewHash };
    for (const suffix of ['review', 'approve', 'revoke']) {
      const refused = await request(server)
        .post(`${endpoint()}/routes/helper/${suffix}`)
        .set('X-DorkOS-Agent', token)
        .send(body);
      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe('AGENT_CANNOT_DECIDE');
    }
    const requester = await request(server)
      .post(`${endpoint()}/routes/helper/approve`)
      .set('X-DorkOS-Approval', 'held-token')
      .send(body);
    expect(requester.body.code).toBe('REQUESTER_CANNOT_DECIDE');
    const read = await request(server).get(`${endpoint()}/routes`).set('X-DorkOS-Agent', token);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('PERSON_REQUIRED');
    expect(grantRows()).toHaveLength(0);
  });

  it('keeps login on behind the session gate and refuses an API key', async () => {
    declare();
    configManager.set('auth', { enabled: true });
    expect((await request(server).get(`${endpoint()}/routes`)).status).toBe(401);
    expect((await request(server).get(`${endpoint()}/routes`).set('Cookie', cookies)).status).toBe(
      200
    );
    const created = await request(server)
      .post('/api/auth/api-key/create')
      .set('Cookie', cookies)
      .set('Origin', origin)
      .send({ name: 'routes' });
    expect(created.status).toBe(200);
    const reviewed = await review('helper').set('Cookie', cookies);
    expect(reviewed.status).toBe(200);
    const body = { expiresAt: reviewed.body.expiresAt, reviewHash: reviewed.body.reviewHash };
    const keyed = await approve('helper', body).set('Authorization', `Bearer ${created.body.key}`);
    expect(keyed.status).toBe(403);
    expect(keyed.body.code).toBe('operator_cookie_required');
    expect(grantRows()).toHaveLength(0);
    const approved = await approve('helper', body).set('Cookie', cookies);
    expect(approved.status).toBe(200);
    const approval = db
      .select()
      .from(approvalRows)
      .where(eq(approvalRows.id, grantRows()[0]!.approvalId!))
      .get();
    expect(approval?.decidedByUserId).toBe(readOwnerAccount()!.id);
  });

  it('turns a route off, every grant it holds, so no older grant keeps it on', async () => {
    declare();
    const { route } = await allow('notes');
    // A second live grant, as an install that predates the one-grant rule can hold.
    const original = http.channels.getGrant(route.grant.grantId)!;
    http.channels.insertGrant({
      ...original,
      grantId: `${original.grantId}-older`,
      createdAt: new Date(Date.parse(original.createdAt) - 60_000).toISOString(),
    });
    const revoked = await request(server).post(`${endpoint()}/routes/notes/revoke`).send({});
    expect(revoked.status).toBe(200);
    expect(revoked.body.route.state).toBe('revoked');
    expect(grantRows().every((row) => row.revokedAt !== null)).toBe(true);
    const current = http.grants.getCurrentRoutes(documentId, 'note.added', operator());
    expect(current[0]?.grantId).toBeUndefined();
    expect(
      (await request(server).post(`${endpoint()}/routes/notes/revoke`).send({ grantId: 'x' }))
        .status
    ).toBe(400);
  });

  it('refuses to turn off an undeclared route and changes nothing', async () => {
    declare();
    await allow('notes');
    const refused = await request(server).post(`${endpoint()}/routes/nowhere/revoke`).send({});
    expect(refused.status).toBe(404);
    expect(refused.body.code).toBe('ROUTE_UNDECLARED');
    expect(await stateOf('notes')).toBe('granted');
  });

  it('keeps at most one live grant per route on the agent path too', async () => {
    declare();
    await allow('notes');
    const later = new Date(Date.now() + 7_200_000).toISOString();
    expect(() =>
      http.grants.grant({ documentId, routeId: 'notes', expiresAt: later }, operator())
    ).toThrow('ROUTE_ALREADY_GRANTED');
    expect(grantRows().filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('refuses a second agent yes before spending it while the route is on', async () => {
    declare();
    const ask = (hours: number) => {
      const asked = http.grants.grant(
        {
          documentId,
          routeId: 'helper',
          expiresAt: new Date(Date.now() + hours * 3_600_000).toISOString(),
        },
        operator()
      );
      if (asked.kind !== 'approval_required') throw new Error('Expected a request');
      approvals.grant(asked.ticket.approvalId);
      return asked.ticket;
    };
    const first = ask(1);
    const second = ask(1.5);
    // Expiries are minted fresh, so present each yes with exactly the binding it was given for.
    const rowOf = (id: string) =>
      db.select().from(approvalRows).where(eq(approvalRows.id, id)).get()!;
    const bindingOf = (id: string) => JSON.parse(rowOf(id).detail!) as { expiresAt: string };
    const exact = (ticket: { approvalId: string; token: string }) =>
      http.grants.grant(
        { documentId, routeId: 'helper', expiresAt: bindingOf(ticket.approvalId).expiresAt },
        operator(),
        ticket.token
      );
    expect(exact(first).kind).toBe('granted');
    expect(() => exact(second)).toThrow('ROUTE_ALREADY_GRANTED');
    expect(rowOf(second.approvalId).consumedAt).toBeNull();
    expect(grantRows().filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('tells an agent answered by a panel allow that the route is already on', async () => {
    declare();
    const asked = http.grants.grant(
      { documentId, routeId: 'helper', expiresAt: new Date(Date.now() + 5_400_000).toISOString() },
      operator()
    );
    if (asked.kind !== 'approval_required') throw new Error('Expected a request');
    const expiresAt = (
      JSON.parse(
        db.select().from(approvalRows).where(eq(approvalRows.id, asked.ticket.approvalId)).get()!
          .detail!
      ) as { expiresAt: string }
    ).expiresAt;
    await allow('helper');
    expect(() =>
      http.grants.grant(
        { documentId, routeId: 'helper', expiresAt },
        operator(),
        asked.ticket.token
      )
    ).toThrow('ROUTE_ALREADY_GRANTED');
    expect(
      db.select().from(approvalRows).where(eq(approvalRows.id, asked.ticket.approvalId)).get()
    ).toMatchObject({ state: 'denied', consumedAt: null });
  });

  it('never lets an unused agent yes turn the route back on after a person turns it off', async () => {
    declare();
    const later = new Date(Date.now() + 5_400_000).toISOString();
    const asked = http.grants.grant(
      { documentId, routeId: 'helper', expiresAt: later },
      operator()
    );
    if (asked.kind !== 'approval_required') throw new Error('Expected a request');
    approvals.grant(asked.ticket.approvalId); // allowed on the card, not yet used
    const retry = () =>
      http.grants.grant(
        { documentId, routeId: 'helper', expiresAt: later },
        operator(),
        asked.ticket.token
      );
    await allow('helper'); // then allowed in the panel
    expect(retry).toThrow('ROUTE_ALREADY_GRANTED');
    const turnedOff = await request(server).post(`${endpoint()}/routes/helper/revoke`).send({});
    expect(turnedOff.status).toBe(200);
    expect(retry).toThrow('APPROVAL_CONSUMED');
    expect(await stateOf('helper')).not.toBe('granted');
    // The same holds for a yes given while the route was already off.
    const again = http.grants.grant(
      { documentId, routeId: 'helper', expiresAt: new Date(Date.now() + 6_000_000).toISOString() },
      operator()
    );
    if (again.kind !== 'approval_required') throw new Error('Expected a request');
    approvals.grant(again.ticket.approvalId);
    await request(server).post(`${endpoint()}/routes/helper/revoke`).send({});
    const expiresAt = (
      JSON.parse(
        db.select().from(approvalRows).where(eq(approvalRows.id, again.ticket.approvalId)).get()!
          .detail!
      ) as { expiresAt: string }
    ).expiresAt;
    expect(() =>
      http.grants.grant(
        { documentId, routeId: 'helper', expiresAt },
        operator(),
        again.ticket.token
      )
    ).toThrow('APPROVAL_CONSUMED');
    expect(await stateOf('helper')).not.toBe('granted');
  });

  it('marks a route suspended when its declaration changes and expired when time runs out', async () => {
    declare();
    const { route } = await allow('notes');
    declare(ROUTES().map((item) => (item.id === 'notes' ? { ...item, on: 'note.added' } : item)));
    expect(await stateOf('notes')).toBe('suspended');
    expect(route.grant.grantId).toBeDefined();
    await allow('tasks');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 2 * 3_600_000);
      expect(await stateOf('tasks')).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a real waiting request on its own document and never on a sibling', async () => {
    const other = rooms.canvas.open(`session:${sessionId}`, 'owner', {
      type: 'url',
      url: `https://example.test/${sessionId}/other`,
    }).id;
    declare();
    http.grants.configure(other, { routes: ROUTES() }, operator(), ownerAgentId);
    const asked = http.grants.grant(
      { documentId, routeId: 'helper', expiresAt: hour() },
      operator()
    );
    if (asked.kind !== 'approval_required') throw new Error('Expected a waiting request');
    const mine = (await request(server).get(`${endpoint()}/routes`)).body.routes;
    expect(mine.find((item: { id: string }) => item.id === 'helper')).toMatchObject({
      state: 'waiting',
      waiting: { approvalId: asked.ticket.approvalId },
    });
    const theirs = (await request(server).get(`/api/canvas/docs/${other}/routes`)).body.routes;
    expect(theirs.find((item: { id: string }) => item.id === 'helper')).toMatchObject({
      state: 'no_grant',
      waiting: null,
    });
  });

  it('answers the agent’s waiting request once a person allows the route here', async () => {
    declare();
    const asked = http.grants.grant(
      { documentId, routeId: 'helper', expiresAt: new Date(Date.now() + 5_400_000).toISOString() },
      operator()
    );
    if (asked.kind !== 'approval_required') throw new Error('Expected a waiting request');
    await allow('helper');
    const row = db
      .select()
      .from(approvalRows)
      .where(eq(approvalRows.id, asked.ticket.approvalId))
      .get();
    expect(row).toMatchObject({ state: 'denied', denyReason: 'Allowed from the document.' });
    expect(await stateOf('helper')).toBe('granted');
  });

  it('raises no card, banner or escalation about the person’s own allow', async () => {
    declare();
    const broadcast = vi.spyOn(eventFanOut, 'broadcast');
    await allow('helper');
    const kinds = broadcast.mock.calls.map(([kind]) => kind);
    expect(kinds).not.toContain('approval_pending');
    expect(kinds).not.toContain('standing_pending');
  });

  it('records each allow and turn off on the Activity feed', async () => {
    declare();
    const emit = vi.fn(async (_line: Record<string, unknown>) => undefined);
    deps.activity = { emit } as unknown as HonoApiDeps['activity'];
    try {
      await allow('notes');
      await request(server).post(`${endpoint()}/routes/notes/revoke`).send({});
    } finally {
      delete deps.activity;
    }
    const lines = emit.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      eventType: 'permission.answered',
      category: 'permissions',
      resourceId: documentId,
      metadata: { action: 'ui.approve_doc_route', answer: 'once', posture: 'signed-in-operator' },
    });
    expect(lines[1]).toMatchObject({
      eventType: 'doc_route.turned_off',
      category: 'permissions',
      resourceId: documentId,
      metadata: {
        documentId,
        routeId: 'notes',
        revokedGrants: 1,
        cancelledApprovals: 0,
        posture: 'signed-in-operator',
      },
    });
    expect(lines[1]!.metadata).not.toHaveProperty('approvalId');
  });

  it('records the person’s yes already granted, and spends it when nothing is granted', async () => {
    declare();
    const reviewed = (await review('helper')).body;
    const body = { expiresAt: reviewed.expiresAt, reviewHash: reviewed.reviewHash };
    const newest = () =>
      db
        .select()
        .from(approvalRows)
        .all()
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    vi.spyOn(http.grants, 'grant').mockImplementationOnce(() => {
      throw new DocRouteGrantError('TARGET_UNAVAILABLE');
    });
    const refused = await approve('helper', body);
    expect(refused.body.code).toBe('TARGET_UNAVAILABLE');
    expect(newest()).toMatchObject({
      state: 'granted',
      inputHash: reviewed.reviewHash,
      decidedAt: expect.any(String),
      consumedAt: expect.any(String),
    });
    expect(grantRows()).toHaveLength(0);
  });

  it('names the agent a room route reaches, from the server-resolved target', async () => {
    declare([...ROUTES(), { id: 'room', on: 'task.*', to: 'room:self', turn: { mode: 'none' } }]);
    const room = (await request(server).get(`${endpoint()}/routes`)).body.routes.find(
      (item: { id: string }) => item.id === 'room'
    );
    expect(room.destination).toEqual({ kind: 'room', agentId: ownerAgentId, agentName: 'Scout' });
    // Review names whoever the server resolved, not the declaration's wording.
    const real = http.grants.prepare.bind(http.grants);
    vi.spyOn(http.grants, 'prepare').mockImplementation((input, actor, tx) => {
      const prepared = real({ ...input, routeId: 'helper' }, actor, tx);
      return { ...prepared, route: { ...prepared.route, id: 'room', to: 'room:self' } };
    });
    const reviewed = await review('room');
    expect(reviewed.body.destination).toEqual({
      kind: 'room',
      agentId: helperId,
      agentName: 'Atlas',
    });
  });

  it('refuses a person decision the bars did not mint', async () => {
    declare();
    await expect(
      http.routeControls.review(documentId, 'helper', { expiresAt: hour() }, operator(), {
        posture: 'local-trust',
      })
    ).rejects.toMatchObject({ code: 'PERSON_REQUIRED' });
  });

  it('answers an unknown document 404 and an uncomposed server 503', async () => {
    documentId = 'missing';
    expect((await request(server).get(`${endpoint()}/routes`)).status).toBe(404);
    delete deps.docChannel;
    expect((await request(server).get(`${endpoint()}/routes`)).status).toBe(503);
  });
});
