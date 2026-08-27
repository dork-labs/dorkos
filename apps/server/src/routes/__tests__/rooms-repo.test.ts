/**
 * `POST /api/rooms/:id/repo` — giving a room files of its own, and who may.
 *
 * Driven through the REAL app mount, so the middleware in front of the route is
 * covered too, and against a real git binary on a temporary DorkOS home: the
 * claim "the room now has a repo" is only worth making if something checked the
 * disk.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Dropping the operator gate turns "refuses a member agent" green→red: the
 *   agent gets 201 and a repo it asked itself for.
 * - Checking the operator gate BEFORE visibility reddens "an outsider agent
 *   gets the same 404 an unknown room gets" — it answers 403 and leaks that the
 *   room exists.
 * - Returning 201 unconditionally reddens the idempotence test.
 * - Ignoring `config.rooms.repo.enabled` reddens the switched-off test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';

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
import {
  createRoomSubsystem,
  setRoomRepoService,
  setRoomService,
} from '../../services/rooms/index.js';
import { RoomRepoService, RoomRepoStore } from '../../services/rooms/repo/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import { readOwnerAccount } from '../../services/core/auth/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { runGit } from '../../services/rooms/repo/room-repo-git.js';

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

describe('POST /api/rooms/:id/repo', () => {
  let db: Db;
  let dorkHome: string;
  let store: RoomRepoStore;
  let enabled: boolean;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-rooms-repo-route-'));
    enabled = true;
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    store = new RoomRepoStore(db, dorkHome);
    setRoomRepoService(
      new RoomRepoService({
        store,
        enabled: () => enabled,
        getRoom: (roomId, viewerAuthorId) => rooms.service.getRoom(roomId, viewerAuthorId),
        isOwnerAuthor: (authorId) =>
          rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
        operatorGitName: () => 'Dorian',
        caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      })
    );
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** A channel with Ana on the roster. */
  async function channel(): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Release train', agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  it('gives the room a repo when the operator asks', async () => {
    const roomId = await channel();

    const res = await request(app).post(`/api/rooms/${roomId}/repo`);

    expect(res.status).toBe(201);
    expect(res.body.repo).toMatchObject({ roomId, mode: 'owned', defaultBranch: 'main' });
    // And it is really there, on main, with a first commit.
    expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], store.repoPath(roomId))).toBe(
      'main'
    );
    expect(await runGit(['ls-files'], store.repoPath(roomId))).toBe('ROOM.md');
    expect(existsSync(store.sidecarPath(roomId))).toBe(true);
  });

  it('answers 409 with the binding it already had, and makes no second commit', async () => {
    const roomId = await channel();
    const first = await request(app).post(`/api/rooms/${roomId}/repo`);
    const head = await runGit(['rev-parse', 'HEAD'], store.repoPath(roomId));

    const second = await request(app).post(`/api/rooms/${roomId}/repo`);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ROOM_REPO_EXISTS');
    expect(second.body.repo).toEqual(first.body.repo);
    expect(await runGit(['rev-parse', 'HEAD'], store.repoPath(roomId))).toBe(head);
  });

  it('refuses a member agent — enabling is never an agent capability', async () => {
    const roomId = await channel();
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    // Ana really is in this room: the same token reads it.
    const reads = await request(app).get(`/api/rooms/${roomId}`).set('X-DorkOS-Agent', token);
    expect(reads.status).toBe(200);

    const res = await request(app).post(`/api/rooms/${roomId}/repo`).set('X-DorkOS-Agent', token);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OPERATOR_ONLY');
    expect(existsSync(store.homeDir(roomId))).toBe(false);
    expect(store.getRow(roomId)).toBeNull();
  });

  it('answers an outsider agent the same 404 an unknown room gets', async () => {
    const roomId = await channel();
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({
      agentPath: '/agents/outsider',
      displayName: 'Outsider',
    });

    const known = await request(app).post(`/api/rooms/${roomId}/repo`).set('X-DorkOS-Agent', token);
    const unknown = await request(app)
      .post('/api/rooms/01NOSUCHROOM/repo')
      .set('X-DorkOS-Agent', token);

    expect(known.status).toBe(404);
    expect(known.body.code).toBe('ROOM_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('ROOM_NOT_FOUND');
  });

  it('refuses a token this machine cannot verify, before any room is looked up', async () => {
    const roomId = await channel();

    const res = await request(app)
      .post(`/api/rooms/${roomId}/repo`)
      .set('X-DorkOS-Agent', 'not-a-real-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
  });

  it('answers 404 for a room that does not exist', async () => {
    const res = await request(app).post('/api/rooms/01NOSUCHROOM/repo');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
  });

  it('is not available while config.rooms.repo.enabled is off, and writes nothing', async () => {
    const roomId = await channel();
    enabled = false;

    const res = await request(app).post(`/api/rooms/${roomId}/repo`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROOM_REPOS_DISABLED');
    expect(existsSync(store.homeDir(roomId))).toBe(false);
  });

  it('leaves every other room path behaving exactly as it does today', async () => {
    // The additive claim, stated as a test: a room with no repo posts, reads and
    // lists the same whether the feature is on or off.
    const roomId = await channel();
    for (const flag of [true, false]) {
      enabled = flag;
      const posted = await request(app)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: `hello ${flag}` });
      expect(posted.status).toBe(202);
      const read = await request(app).get(`/api/rooms/${roomId}`);
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('repo');
    }
  });
});
