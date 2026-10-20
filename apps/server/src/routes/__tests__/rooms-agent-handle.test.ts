/**
 * A person renaming an agent's handle through the real app mount (DOR-3156):
 * the room line, mentions staying on the agent's id, the look-alike refusal,
 * and proof that a rename touches nothing but the handle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, sql, type Db } from '@dorkos/db';

vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    getSessionSettings: vi.fn(async () => null),
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

import { composedListener } from '../../http/__tests__/composed-listener.js';
import { createRoomSubsystem, getRoomService, setRoomService } from '../../services/rooms/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { ActivityService } from '../../services/activity/activity-service.js';
import { setHandleRenameActivity } from '../../services/rooms/handles/rename-author-handle.js';

const admission = new MainRequestAdmission();
const testServer = listeningServer(composedListener(admission));

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/** Register an agent so a room can resolve it by directory. */
function registerAgent(db: Db, name: string, projectPath: string): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: `ULID_${name.toUpperCase()}`,
      name,
      displayName: name[0]!.toUpperCase() + name.slice(1),
      runtime: 'claude-code',
      projectPath,
      // Mentioned only, so a post here starts no turn the test has to wait on.
      behaviorJson: '{"responseMode":"mention"}',
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

interface Member {
  authorId: string;
  author: { displayName: string; handle: string | null };
}

/** A channel with Ana and Bo in it, and the ids the tests need. */
async function channelWithAgents(title: string) {
  const created = await request(testServer).post('/api/rooms').send({ kind: 'channel', title });
  expect(created.status).toBe(201);
  const roomId = created.body.id as string;
  for (const agentPath of [ANA_PATH, BO_PATH]) {
    const added = await request(testServer)
      .post(`/api/rooms/${roomId}/members`)
      .send({ agentPath });
    expect(added.status).toBe(201);
  }
  const members = (await request(testServer).get(`/api/rooms/${roomId}`)).body.members as Member[];
  const idOf = (name: string) => members.find((m) => m.author.displayName === name)!.authorId;
  return {
    roomId,
    me: created.body.members[0].authorId as string,
    ana: idOf('Ana'),
    bo: idOf('Bo'),
  };
}

/** Post a message as the person, and the mentions it was stored with. */
async function post(roomId: string, text: string): Promise<{ id: string; mentions: string[] }> {
  const res = await request(testServer).post(`/api/rooms/${roomId}/entries`).send({ text });
  expect(res.status).toBe(202);
  const stored = (await entries(roomId)).find((e) => e.id === res.body.entryId)!;
  return { id: stored.id, mentions: stored.mentions };
}

/** Every entry in a room, oldest first. */
async function entries(roomId: string) {
  return (await request(testServer).get(`/api/rooms/${roomId}/entries`)).body.entries as {
    id: string;
    kind: string;
    mentions: string[];
    body: { text: string; notice?: string; subjectAuthorId?: string };
  }[];
}

/** Every row of every table, by table, so a test can see what a call changed. */
function snapshot(db: Db): Map<string, string> {
  const tables = db.all<{ name: string }>(
    sql`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '%_fts%'`
  );
  return new Map(
    tables.map(({ name }) => [name, JSON.stringify(db.all(sql.raw(`select * from "${name}"`)))])
  );
}

describe('a person renaming an agent (DOR-3156)', () => {
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
    setHandleRenameActivity(undefined);
  });

  it('records one Activity row per rename: who, which agent, old and new handle', async () => {
    const activity = new ActivityService(db);
    setHandleRenameActivity(activity);
    const { me, ana } = await channelWithAgents('History');

    await request(testServer).patch(`/api/rooms/authors/${ana}/handle`).send({ handle: 'ana-pm' });
    // A person renaming themselves is not an agent rename, so it adds no row.
    await request(testServer).patch(`/api/rooms/authors/${me}/handle`).send({ handle: 'dorian' });

    await vi.waitFor(async () => {
      const { items } = await activity.list({ limit: 10 });
      const rows = items.filter((row) => row.eventType === 'agent.handle_changed');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: 'user',
        actorId: me,
        category: 'agent',
        resourceType: 'agent',
        resourceId: 'ULID_ANA',
        resourceLabel: 'Ana',
        summary: 'The operator renamed Ana from @ana to @ana-pm.',
        metadata: { authorId: ana, from: 'ana', to: 'ana-pm' },
      });
    });
  });

  it('renames the agent and writes one quiet line in each room it is in', async () => {
    const first = await channelWithAgents('Backend');
    const second = await channelWithAgents('Frontend');
    const res = await request(testServer)
      .patch(`/api/rooms/authors/${first.ana}/handle`)
      .send({ handle: 'ana-pm' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: first.ana, handle: 'ana-pm' });
    for (const roomId of [first.roomId, second.roomId]) {
      const lines = (await entries(roomId)).filter((e) => e.body.notice === 'handle_changed');
      expect(lines.map((e) => e.body)).toEqual([
        {
          // No profile name here, so the room names the person as agents read them.
          text: 'The operator renamed Ana from @ana to @ana-pm.',
          notice: 'handle_changed',
          subjectAuthorId: first.ana,
        },
      ]);
      // The room's own voice, so it mentions nobody and wakes nobody.
      expect(lines[0]!.kind).toBe('notice');
      expect(lines[0]!.mentions).toEqual([]);
    }
  });

  it('writes no line when a person renames themselves, or sets the same handle', async () => {
    const { roomId, me, ana } = await channelWithAgents('Quiet');

    await request(testServer).patch(`/api/rooms/authors/${me}/handle`).send({ handle: 'dorian' });
    await request(testServer).patch(`/api/rooms/authors/${ana}/handle`).send({ handle: 'ana' });

    expect((await entries(roomId)).filter((e) => e.body.notice === 'handle_changed')).toEqual([]);
  });

  it('keeps old mentions on the agent, moves new ones to the new handle, and lets nobody take the old', async () => {
    const { roomId, ana, bo } = await channelWithAgents('Mentions');
    const before = await post(roomId, '@ana can you look?');
    expect(before.mentions).toEqual([ana]);

    await request(testServer).patch(`/api/rooms/authors/${ana}/handle`).send({ handle: 'ana-pm' });

    // The message sent before still names Ana, by id.
    const old = (await entries(roomId)).find((e) => e.id === before.id)!;
    expect(old.mentions).toEqual([ana]);
    // A new message reaches her by the new handle, and nobody by the old one.
    expect((await post(roomId, '@ana-pm thanks')).mentions).toEqual([ana]);
    expect((await post(roomId, '@ana hello?')).mentions).toEqual([]);
    // And the freed handle stays hers: Bo cannot take it to catch `@ana`.
    const taken = await request(testServer)
      .patch(`/api/rooms/authors/${bo}/handle`)
      .send({ handle: 'ana' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('HANDLE_RESERVED');
  });

  it('changes nothing about the agent but its handle: no level, mark, grant, membership or setting', async () => {
    const { roomId, ana } = await channelWithAgents('Identity');
    const { configManager } = await import('../../services/core/config-manager.js');
    const before = snapshot(db);

    await request(testServer).patch(`/api/rooms/authors/${ana}/handle`).send({ handle: 'ana-pm' });

    const after = snapshot(db);
    const changed = [...after.keys()].filter((table) => after.get(table) !== before.get(table));
    // The handle and its tombstone, plus the room line, the room's activity
    // time and the line's row in the search index. Agents, members, permissions
    // and every other table are untouched.
    expect(changed.sort()).toEqual([
      'authors',
      'handle_tombstones',
      'room_entries',
      'rooms',
      'search_sources',
    ]);
    expect(vi.mocked(configManager.set)).not.toHaveBeenCalled();
    const roster = (await request(testServer).get(`/api/rooms/${roomId}`)).body.members as Member[];
    expect(roster.find((m) => m.authorId === ana)!.author).toMatchObject({
      displayName: 'Ana',
      handle: 'ana-pm',
    });
  });

  it('refuses a look-alike handle with a plain sentence', async () => {
    const { me, ana } = await channelWithAgents('Lookalike');
    getRoomService().authorRegistry.setHandle(me, 'dorian');

    const res = await request(testServer)
      .patch(`/api/rooms/authors/${ana}/handle`)
      .send({ handle: 'D0rian' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: '@d0rian looks too much like @dorian. Pick a different one.',
      code: 'HANDLE_LOOKALIKE',
    });
  });

  it('never renames the room’s own voice', async () => {
    await channelWithAgents('Voice');
    const system = getRoomService().authorRegistry.system();

    const res = await request(testServer)
      .patch(`/api/rooms/authors/${system.id}/handle`)
      .send({ handle: 'voice' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('HANDLE_RESERVED');
    expect(getRoomService().authorRegistry.getById(system.id)?.handle).toBe(system.handle);
  });

  it('still refuses an agent renaming another agent, even with the person’s rename open', async () => {
    const { ana, bo } = await channelWithAgents('Agents');
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    const res = await request(testServer)
      .patch(`/api/rooms/authors/${bo}/handle`)
      .set('X-DorkOS-Agent', token)
      .send({ handle: 'bo-2' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OPERATOR_ONLY');
    expect(getRoomService().authorRegistry.getById(ana)?.handle).toBe('ana');
    expect(getRoomService().authorRegistry.getById(bo)?.handle).toBe('bo');
  });
});
