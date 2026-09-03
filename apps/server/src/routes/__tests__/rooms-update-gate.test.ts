/**
 * `PATCH /api/rooms/:id` — who may rename, describe or put away a room
 * (DOR-608), measured THROUGH THE ROUTE.
 *
 * The route is the seam that mattered: `RoomService.updateRoom` had every field
 * check a room needs and no caller check at all, so a verified agent holding a
 * room id could rename the owner's channel or archive it out from under her with
 * one request. The capability tools never offered `archived` and never will —
 * the hole was reachable only here, which is why every case below drives real
 * HTTP with a real minted agent token rather than calling the service.
 *
 * **The un-archive path is the whole difficulty**, and it has its own case at
 * the bottom. An agent re-opening its OWN archived direct message is a
 * legitimate `{ archived: false }` from a non-owner, reached through
 * `POST /api/rooms`'s idempotent DM branch — so the naive gate on `updateRoom`
 * passes every existing test and silently breaks that flow. It is measured here
 * over the same routes, so the gate and its exemption are pinned by one file.
 *
 * Seeded defects, each run and each red before the code stood:
 *
 * - Dropping `requireOperator` from `updateRoom` reddens all three refusals.
 * - Routing the internal re-open back through the gated `updateRoom` reddens
 *   "an agent still re-opens its own archived DM".
 * - Putting the operator gate ABOVE `requireVisibleRoom` reddens "an outsider
 *   agent gets the same 404 an unknown room gets" — the refusal would tell an
 *   outsider that a room it cannot see exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    has: vi.fn(() => true),
    listRuntimes: vi.fn(() => [fakeRuntime]),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {},
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { createApp, finalizeApp } from '../../app.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0].toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      behaviorJson: '{"responseMode":"always"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('PATCH /api/rooms/:id — the owner writes a room, a member agent does not', () => {
  let db: Db;

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /**
   * A channel the owner opened with Ana on the roster. Headerless, so
   * `resolveCaller` stamps it with the install's owner exactly as the app does.
   */
  async function ownersChannel(title = 'Backend'): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title, agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  /** A verified token for Ana. */
  async function anaToken(): Promise<string> {
    return initAgentIdentityService(db).mint({ agentPath: ANA_PATH, displayName: 'Ana' });
  }

  /** The stored room, read back as the owner. */
  async function readBack(roomId: string): Promise<Record<string, unknown>> {
    const res = await request(app).get(`/api/rooms/${roomId}`);
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  }

  it('lets the owner rename, describe and archive her own channel', async () => {
    const roomId = await ownersChannel();

    const renamed = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .send({ title: 'Backend two', topic: 'the release train' });
    const archived = await request(app).patch(`/api/rooms/${roomId}`).send({ archived: true });

    expect(renamed.status).toBe(200);
    expect(renamed.body.slug).toBe('backend-two');
    expect(archived.status).toBe(200);
    expect(archived.body.archived).toBe(true);
  });

  it('refuses a member agent renaming it, and leaves the name alone', async () => {
    const roomId = await ownersChannel();
    const token = await anaToken();

    const res = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('X-DorkOS-Agent', token)
      .send({ title: 'Ana speaks for this room now' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OPERATOR_ONLY');
    const room = await readBack(roomId);
    expect(room.title).toBe('Backend');
    expect(room.slug).toBe('backend');
  });

  it('refuses a member agent ARCHIVING it — the flag the whole room feels', async () => {
    const roomId = await ownersChannel();
    const token = await anaToken();

    const res = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('X-DorkOS-Agent', token)
      .send({ archived: true });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OPERATOR_ONLY');
    expect((await readBack(roomId)).archived).toBe(false);
  });

  it('refuses a member agent setting the topic over HTTP', async () => {
    // Not a narrowing of what an agent may SAY about a room: `update_room` is
    // the surface for that, and it still writes a topic. This route is not.
    const roomId = await ownersChannel();
    const token = await anaToken();

    const res = await request(app)
      .patch(`/api/rooms/${roomId}`)
      .set('X-DorkOS-Agent', token)
      .send({ topic: 'whatever I decide it is about' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OPERATOR_ONLY');
    expect((await readBack(roomId)).topic).toBeNull();
  });

  it('answers an outsider agent the same 404 an unknown room gets', async () => {
    // Visibility is judged BEFORE the gate, so a 403 never doubles as "this
    // room exists" for a caller who could not otherwise learn it.
    const roomId = await ownersChannel();
    registerAgent(db, 'outsider', '/agents/outsider');
    const token = await initAgentIdentityService(db).mint({
      agentPath: '/agents/outsider',
      displayName: 'Outsider',
    });

    const answers = await Promise.all(
      [roomId, '01NOSUCHROOM'].map((id) =>
        request(app).patch(`/api/rooms/${id}`).set('X-DorkOS-Agent', token).send({ title: 'Mine' })
      )
    );

    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
    }
  });

  it('still lets an agent re-open its OWN archived direct message', async () => {
    // DOR-608's trap, over the routes that reach it. The owner opens the DM and
    // puts it away; the agent asks for the conversation again through
    // `POST /api/rooms`, whose idempotent DM branch un-archives what it matched.
    // That write is a non-owner's, and it must still go through.
    const token = await anaToken();
    const opened = await request(app)
      .post('/api/rooms')
      .send({ kind: 'dm', title: 'Ana', agentPaths: [ANA_PATH] });
    expect(opened.status).toBe(201);
    const roomId = opened.body.id as string;
    const owner = opened.body.viewerAuthorId as string;
    expect((await request(app).patch(`/api/rooms/${roomId}`).send({ archived: true })).status).toBe(
      200
    );

    const reopened = await request(app)
      .post('/api/rooms')
      .set('X-DorkOS-Agent', token)
      .send({ kind: 'dm', title: 'Ana', members: [owner], agentPaths: [ANA_PATH] });

    // 200, not 201: the DM already existed and was adopted rather than created.
    expect(reopened.status).toBe(200);
    expect(reopened.body.id).toBe(roomId);
    expect(reopened.body.archived).toBe(false);
  });
});
