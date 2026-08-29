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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  setRoomMergeService,
  setRoomRepoService,
  setRoomService,
} from '../../services/rooms/index.js';
import {
  RoomMergeService,
  RoomRepoMutex,
  RoomRepoService,
  RoomRepoStore,
  RoomWorktreeManager,
} from '../../services/rooms/repo/index.js';
import { setReadCursorService } from '../../services/core/read-cursor-service.js';
import { readOwnerAccount } from '../../services/core/auth/index.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { runGit } from '../../services/rooms/repo/room-repo-git.js';

/** Run git in a room's repo with that room's home as the discovery ceiling. */
function gitInRepo(args: string[], store: RoomRepoStore, roomId: string): Promise<string> {
  return runGit(args, store.repoPath(roomId), store.homeDir(roomId));
}

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
        mutex: new RoomRepoMutex(),
        queueWaitMs: () => 5000,
        enabled: () => enabled,
        getRoom: (roomId, viewerAuthorId) => rooms.service.getRoom(roomId, viewerAuthorId),
        isOwnerAuthor: (authorId) =>
          rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
        operatorGitName: () => 'Dorian',
        caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
        maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
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
    expect(await gitInRepo(['rev-parse', '--abbrev-ref', 'HEAD'], store, roomId)).toBe('main');
    expect(await gitInRepo(['ls-files'], store, roomId)).toBe('ROOM.md');
    expect(existsSync(store.sidecarPath(roomId))).toBe(true);
  });

  it('answers 409 with the binding it already had, and makes no second commit', async () => {
    const roomId = await channel();
    const first = await request(app).post(`/api/rooms/${roomId}/repo`);
    const head = await gitInRepo(['rev-parse', 'HEAD'], store, roomId);

    const second = await request(app).post(`/api/rooms/${roomId}/repo`);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ROOM_REPO_EXISTS');
    expect(second.body.repo).toEqual(first.body.repo);
    expect(await gitInRepo(['rev-parse', 'HEAD'], store, roomId)).toBe(head);
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

  it('says plainly that git is missing, rather than answering 500', async () => {
    // git is looked up on PATH, so an empty PATH is a machine without it. The
    // request was well formed and nothing is broken — a program is missing, and
    // the person can install it. A 500 would say the opposite.
    const roomId = await channel();
    // `vi.stubEnv` rather than assigning `process.env.PATH`: vitest unwinds it
    // even if the request throws, and an escaped empty PATH would break every
    // later test in this worker that spawns anything.
    vi.stubEnv('PATH', '');
    let res;
    try {
      res = await request(app).post(`/api/rooms/${roomId}/repo`);
    } finally {
      vi.unstubAllEnvs();
    }

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ROOM_REPO_GIT_UNAVAILABLE');
    expect(res.body.error).toContain('git');
    expect(store.getRow(roomId)).toBeNull();
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

/**
 * `GET /api/rooms/:id/repo/status` and `POST /api/rooms/:id/repo/merge` — the
 * HTTP half of spec §3.6.
 *
 * The tool is the agent's door and these two are the person's. They exist
 * because the tool cannot serve her: spec §5 Q2 puts the OWNER on the list of
 * who may merge, and the owner has no branch of her own, so she names one — and
 * the explorer's pending-work badges need the status over HTTP rather than over
 * MCP.
 *
 * Both go through the SAME service the tools do, which is what these tests are
 * really pinning: one queue, one set of refusals, one merge entry, whichever
 * door the request came through.
 */
describe('the room repo routes', () => {
  let db: Db;
  let dorkHome: string;
  let store: RoomRepoStore;
  let rooms: ReturnType<typeof createRoomSubsystem>;
  /** The SAME manager the merge service holds, so a test works where a turn would. */
  let roomWorktrees: RoomWorktreeManager;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-rooms-merge-route-'));
    registerAgent(db, 'ana', ANA_PATH);
    rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    store = new RoomRepoStore(db, dorkHome);
    const mutex = new RoomRepoMutex();
    const repoService = new RoomRepoService({
      store,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => true,
      getRoom: (roomId, viewerAuthorId) => rooms.service.getRoom(roomId, viewerAuthorId),
      isOwnerAuthor: (authorId) => rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
      operatorGitName: () => 'Dorian',
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    setRoomRepoService(repoService);
    roomWorktrees = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => repoService.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => repoService.listStrandedWorktrees(roomId),
      reapAfterDays: () => 14,
      busyAgentPaths: () => rooms.service.listBusyAgentPaths(),
    });
    setRoomMergeService(
      new RoomMergeService({
        store,
        mutex,
        enabled: () => true,
        mergeQueueWaitMs: () => 5000,
        requireMembership: (roomId, authorId) => rooms.service.requireMembership(roomId, authorId),
        listAgentMembers: (roomId) => rooms.service.listAgentMembers(roomId),
        listStrandedWorktrees: (roomId) => repoService.listStrandedWorktrees(roomId),
        announce: (roomId, input) => rooms.service.postMergeEvent(roomId, input),
        isOwnerAuthor: (authorId) =>
          rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetAgentIdentityService();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** A channel with Ana on the roster, with files of its own. */
  async function projectRoom(): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Release train', agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    const roomId = created.body.id as string;
    expect((await request(app).post(`/api/rooms/${roomId}/repo`)).status).toBe(201);
    return roomId;
  }

  it('answers the status of a room with files', async () => {
    const roomId = await projectRoom();
    const res = await request(app).get(`/api/rooms/${roomId}/repo/status`);

    expect(res.status).toBe(200);
    expect(res.body.mainCommit).toMatch(/^[0-9a-f]{40}$/);
    // Ana has never worked here, so she has no branch to report yet — an empty
    // list rather than a row full of zeroes.
    expect(res.body.branches).toEqual([]);
    expect(res.body.strandedWorktrees).toEqual([]);
    expect(res.body.size.maxRepoBytes).toBe(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes);
  });

  it('tells a room without files that it has none, on both routes', async () => {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title: 'Plain', agentPaths: [ANA_PATH] });
    const roomId = created.body.id as string;

    const status = await request(app).get(`/api/rooms/${roomId}/repo/status`);
    expect(status.status).toBe(409);
    expect(status.body.code).toBe('NOT_A_PROJECT_ROOM');

    const merged = await request(app)
      .post(`/api/rooms/${roomId}/repo/merge`)
      .send({ summary: 'anything' });
    expect(merged.status).toBe(409);
    expect(merged.body.code).toBe('NOT_A_PROJECT_ROOM');
  });

  it('answers an unknown room the way reading one does', async () => {
    const res = await request(app)
      .post('/api/rooms/01NOSUCHROOMAAAAAAAAAAAAAA/repo/merge')
      .send({ summary: 'anything' });
    expect(res.status).toBe(404);
  });

  it('refuses a merge with nothing to say', async () => {
    const roomId = await projectRoom();
    const res = await request(app).post(`/api/rooms/${roomId}/repo/merge`).send({ summary: '' });
    // The route's own validation, before any git runs: a merge nobody can read
    // a summary of is a line in the room that says nothing.
    expect(res.status).toBe(400);
  });

  it('lands an agent’s work when the operator names its working copy, and says so once', async () => {
    const roomId = await projectRoom();
    // Ana works, exactly as a room turn would: in her own standing worktree,
    // committing there. The server never writes in it.
    const tree = await roomWorktrees.ensureWorktree(roomId, ANA_PATH, 'Ana');
    const ceiling = store.homeDir(roomId);
    await writeFile(path.join(tree.path, 'checklist.md'), 'one\n', 'utf-8');
    await runGit(['add', '--all'], tree.path, ceiling);
    await runGit(
      [
        '-c',
        'user.name=Ana',
        '-c',
        'user.email=ana@dorkos.local',
        'commit',
        '-q',
        '-m',
        'checklist',
      ],
      tree.path,
      ceiling
    );

    const res = await request(app)
      .post(`/api/rooms/${roomId}/repo/merge`)
      .send({ summary: 'Add the deploy checklist', worktree: tree.slug });

    expect(res.status).toBe(200);
    expect(res.body.files).toBe(1);
    expect(res.body.commit).toBe(await gitInRepo(['rev-parse', 'HEAD'], store, roomId));
    expect(existsSync(path.join(store.repoPath(roomId), 'checklist.md'))).toBe(true);

    // One line in the room, in the room's own voice, about Ana.
    const log = await request(app).get(`/api/rooms/${roomId}/entries`);
    const merges = (log.body.entries as { body: { merge?: unknown; text: string } }[]).filter(
      (entry) => entry.body.merge !== undefined
    );
    expect(merges).toHaveLength(1);
    expect(merges[0]?.body.text).toContain('Ana merged: Add the deploy checklist');
  });
});
