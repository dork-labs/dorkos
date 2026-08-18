/**
 * `GET /api/rooms/:id/sessions` — where a room's work runs, and who may ask.
 *
 * The authorization design `specs/room-presence` §15 deferred, driven through
 * the REAL app mount so the middleware in front of the route is covered too. Two
 * things are under test and neither is reachable from the service:
 *
 * - a room the caller cannot see answers **404**, exactly as reading it does,
 * - a caller resolved as an AGENT is refused **403**, however visible the room
 *   is to it.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Dropping the `caller.kind !== 'human'` guard turns BOTH agent cases red —
 *   they answer 200 with the bindings.
 * - Dropping the room filter from `listRoomSessions` turns "answers only THIS
 *   room’s bindings" red.
 * - Dropping `requireVisibleRoom` turns "404s a room this caller cannot see" red.
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
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';

const app = createApp();
finalizeApp(app);

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

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

describe('GET /api/rooms/:id/sessions', () => {
  let db: Db;

  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    registerAgent(db, 'ana', ANA_PATH);
    registerAgent(db, 'bo', BO_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
  });

  afterEach(() => {
    resetAgentIdentityService();
  });

  /** A channel with Ana and Bo in it, and the ids the bindings are keyed by. */
  async function roomWithAgents(title = 'Release train'): Promise<{
    id: string;
    anaAuthorId: string;
    boAuthorId: string;
  }> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title, agentPaths: [ANA_PATH, BO_PATH] });
    expect(created.status).toBe(201);
    const byName = (name: string): string =>
      created.body.members.find(
        (m: { author: { displayName: string; id: string } }) => m.author.displayName === name
      ).author.id;
    return { id: created.body.id, anaAuthorId: byName('Ana'), boAuthorId: byName('Bo') };
  }

  /** Bind one agent's work in one room, the way the dispatcher's first turn does. */
  function bind(roomId: string, authorId: string, sessionId: string): void {
    getRoomService().bindAdoptedSession(roomId, authorId, sessionId);
  }

  it('answers the bindings for a member, ids and nothing else', async () => {
    const room = await roomWithAgents();
    bind(room.id, room.anaAuthorId, 'session-ana');
    bind(room.id, room.boAuthorId, 'session-bo');

    const res = await request(app).get(`/api/rooms/${room.id}/sessions`);

    expect(res.status).toBe(200);
    expect(res.body.bindings).toHaveLength(2);
    expect([...res.body.bindings].sort((a, b) => a.sessionId.localeCompare(b.sessionId))).toEqual([
      { authorId: room.anaAuthorId, sessionId: 'session-ana' },
      { authorId: room.boAuthorId, sessionId: 'session-bo' },
    ]);
    // The narrowness IS the security claim: no cwd, no status, no transcript.
    for (const binding of res.body.bindings) {
      expect(Object.keys(binding).sort()).toEqual(['authorId', 'sessionId']);
    }
  });

  it('answers an empty list for a room whose agents have never answered', async () => {
    const room = await roomWithAgents();

    const res = await request(app).get(`/api/rooms/${room.id}/sessions`);

    expect(res.status).toBe(200);
    expect(res.body.bindings).toEqual([]);
  });

  it('answers only THIS room’s bindings', async () => {
    const first = await roomWithAgents();
    const second = await roomWithAgents('Docs');
    bind(first.id, first.anaAuthorId, 'session-first');
    bind(second.id, second.anaAuthorId, 'session-second');

    const res = await request(app).get(`/api/rooms/${first.id}/sessions`);

    expect(res.body.bindings).toEqual([
      { authorId: first.anaAuthorId, sessionId: 'session-first' },
    ]);
  });

  it('answers an outsider 404, the same way it answers a room that is not there', async () => {
    // Visibility is checked BEFORE the person gate, and this is the case that
    // decides the order: an outsider must not be able to tell "this room exists
    // and I am not in it" (403) from "no such room" (404) — which is exactly
    // what the other order leaked.
    const room = await roomWithAgents();
    bind(room.id, room.anaAuthorId, 'session-ana');
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({
      agentPath: '/agents/outsider',
      displayName: 'Outsider',
    });

    const res = await request(app)
      .get(`/api/rooms/${room.id}/sessions`)
      .set('X-DorkOS-Agent', token);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
    expect(res.body).not.toHaveProperty('bindings');
  });

  it('404s a room this caller cannot see, in the same words reading one does', async () => {
    // The visibility half, reached through the service because the route's
    // person gate stands in front of it for every caller HTTP can produce. A
    // room nobody has ever created is exactly a room this caller cannot see,
    // and it must answer `ROOM_NOT_FOUND` rather than an empty list — an empty
    // list would confirm the id is unused.
    const res = await request(app).get('/api/rooms/01NOSUCHROOM/sessions');

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');

    // And through the service directly, with a real room and an author who is
    // not in it.
    const room = await roomWithAgents('Private');
    const stranger = getRoomService().authorRegistry.resolveAgent('/agents/stranger', 'Stranger');
    expect(() => getRoomService().listRoomSessions(room.id, stranger.id)).toThrow('No such room');
  });

  it('refuses an agent caller that IS in the room', async () => {
    // The rule this route exists to state. Ana is a member and can read every
    // entry in here; enumerating where her room-mates' work runs is a different
    // capability, and this domain has not granted it.
    const room = await roomWithAgents();
    bind(room.id, room.anaAuthorId, 'session-ana');
    bind(room.id, room.boAuthorId, 'session-bo');
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    // Ana really is in this room: the same token reads it.
    const readsTheRoom = await request(app)
      .get(`/api/rooms/${room.id}`)
      .set('X-DorkOS-Agent', token);
    expect(readsTheRoom.status).toBe(200);

    const res = await request(app)
      .get(`/api/rooms/${room.id}/sessions`)
      .set('X-DorkOS-Agent', token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEOPLE_ONLY');
    expect(res.body).not.toHaveProperty('bindings');
  });
});
