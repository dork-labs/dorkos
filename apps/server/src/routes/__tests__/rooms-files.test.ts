/**
 * `GET /api/rooms/:id/files` and `/files/content` — who may read a room's own
 * files, and what they get (spec `project-rooms` §3.9).
 *
 * Driven through the REAL app mount against a real git repo on a temporary
 * DorkOS home, so the middleware in front of the routes is covered and the
 * answers are git's rather than a stub's.
 *
 * The gate is the point of this file. It is the history gate, not a new one:
 * "not a member" answers exactly as "no such room", a member AGENT reads, and
 * whether the room has files at all is asked strictly afterwards — so nobody
 * holding a room id can learn which rooms are project rooms.
 *
 * Seeded defects, each run and each red before the code stood:
 *
 * - Dropping `assertCanReadFiles` turns "an outsider agent gets the same 404 an
 *   unknown room gets" green-to-red: the outsider reads the room's files.
 * - Asking `hasRepo` BEFORE membership reddens the same test — the outsider
 *   learns 409 for a real room and 409 for an imaginary one is not what they
 *   get, so the two answers stop matching.
 * - Refusing agents outright reddens "a member agent may read".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import request from 'supertest';
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
  setRoomFilesService,
  setRoomRepoService,
  setRoomService,
} from '../../services/rooms/index.js';
import {
  RoomFilesService,
  RoomRepoService,
  RoomRepoStore,
} from '../../services/rooms/repo/index.js';
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

describe('room files routes', () => {
  let db: Db;
  let dorkHome: string;
  let store: RoomRepoStore;
  let maxFileBytes: number;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-files-route-'));
    maxFileBytes = ROOM_REPO_CAP_DEFAULTS.maxFileBytes;
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    store = new RoomRepoStore(db, dorkHome);
    const repos = new RoomRepoService({
      store,
      enabled: () => true,
      getRoom: (roomId, viewerAuthorId) => rooms.service.getRoom(roomId, viewerAuthorId),
      isOwnerAuthor: (authorId) => rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
      operatorGitName: () => 'Dorian',
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    setRoomRepoService(repos);
    setRoomFilesService(
      new RoomFilesService({
        store,
        hasRepo: (roomId) => repos.hasRepo(roomId),
        maxFileBytes: () => maxFileBytes,
      })
    );
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** A channel with Ana on the roster. */
  async function channel(title = 'Release train'): Promise<string> {
    const created = await request(app)
      .post('/api/rooms')
      .send({ kind: 'channel', title, agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  /** A channel with Ana on it, given files and one extra commit. */
  async function roomWithFiles(): Promise<string> {
    const roomId = await channel();
    expect((await request(app).post(`/api/rooms/${roomId}/repo`)).status).toBe(201);
    const repoDir = store.repoPath(roomId);
    const ceiling = store.homeDir(roomId);
    await mkdir(path.join(repoDir, 'docs'), { recursive: true });
    await writeFile(path.join(repoDir, 'docs', 'plan.md'), '# Plan\n', 'utf-8');
    await writeFile(path.join(repoDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await symlink('/etc/passwd', path.join(repoDir, 'secrets'));
    await runGit(['add', '--all'], repoDir, ceiling);
    await runGit(
      [
        '-c',
        'user.name=Ana',
        '-c',
        'user.email=ana@dorkos.local',
        'commit',
        '-q',
        '-m',
        'Add a plan',
      ],
      repoDir,
      ceiling
    );
    return roomId;
  }

  /** A verified token for Ana, who is on every room this file opens. */
  async function anaToken(): Promise<string> {
    return initAgentIdentityService(db).mint({ agentPath: ANA_PATH, displayName: 'Ana' });
  }

  describe('the gate', () => {
    it('lets the owner list and read', async () => {
      const roomId = await roomWithFiles();

      const listed = await request(app).get(`/api/rooms/${roomId}/files`);

      expect(listed.status).toBe(200);
      expect(listed.body.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(
        listed.body.entries.map((e: { name: string; kind: string }) => [e.name, e.kind])
      ).toEqual([
        // Directories first, then code-unit order — `ROOM.md` ahead of
        // `logo.png` because every capital sorts before every lowercase. Byte
        // order rather than the machine's locale, so one room lists the same
        // way on every computer.
        ['docs', 'dir'],
        ['ROOM.md', 'file'],
        ['logo.png', 'file'],
        ['secrets', 'symlink'],
      ]);
      expect(listed.body.entries[0].lastCommit).toMatchObject({
        author: 'Ana',
        subject: 'Add a plan',
      });

      const read = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/plan.md' });
      expect(read.status).toBe(200);
      expect(read.body.body).toEqual({ kind: 'text', encoding: 'utf-8', text: '# Plan\n' });
    });

    it('lets a member agent read, exactly as it may read history', async () => {
      const roomId = await roomWithFiles();
      const token = await anaToken();

      const listed = await request(app)
        .get(`/api/rooms/${roomId}/files`)
        .set('X-DorkOS-Agent', token);
      const read = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'ROOM.md' })
        .set('X-DorkOS-Agent', token);

      expect(listed.status).toBe(200);
      expect(read.status).toBe(200);
      expect(read.body.body.kind).toBe('text');
    });

    it('answers an outsider agent the same 404 an unknown room gets', async () => {
      const roomId = await roomWithFiles();
      const bare = await channel('Quiet corner'); // a real room with NO files
      const token = await initAgentIdentityService(db).mint({
        agentPath: '/agents/outsider',
        displayName: 'Outsider',
      });

      const answers = await Promise.all(
        [
          `/api/rooms/${roomId}/files`,
          `/api/rooms/${bare}/files`,
          '/api/rooms/01NOSUCHROOM/files',
        ].map((url) => request(app).get(url).set('X-DorkOS-Agent', token))
      );

      // All three identical: a room with files, a room without, and no room at
      // all. An outsider cannot tell them apart.
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ROOM_NOT_FOUND');
      }
      const contents = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'ROOM.md' })
        .set('X-DorkOS-Agent', token);
      expect(contents.status).toBe(404);
      expect(contents.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('refuses a token this machine cannot verify, before any room is looked up', async () => {
      const roomId = await roomWithFiles();

      const res = await request(app)
        .get(`/api/rooms/${roomId}/files`)
        .set('X-DorkOS-Agent', 'not-a-real-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
    });

    it('still serves an archived room, because archiving keeps every byte', async () => {
      // Pins the claim `assertCanReadFiles` makes in prose. Archiving stops a
      // room; `RoomRepoService` keeps its home directory on purpose, so
      // refusing to show the files would hide work nobody agreed to delete —
      // and un-archiving is supposed to return everything exactly as it was.
      const roomId = await roomWithFiles();
      expect(
        (await request(app).patch(`/api/rooms/${roomId}`).send({ archived: true })).status
      ).toBe(200);

      const listed = await request(app).get(`/api/rooms/${roomId}/files`);
      const read = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'ROOM.md' });

      expect(listed.status).toBe(200);
      expect(listed.body.entries.length).toBeGreaterThan(0);
      expect(read.status).toBe(200);
      expect(read.body.body.kind).toBe('text');
    });

    it('answers 401 before 400, so a malformed query never outranks an unverifiable token', async () => {
      const roomId = await roomWithFiles();

      // No `path` at all on the content route is the 400 case; the token is the
      // 401 case. The caller is resolved first, so the answer is about WHO is
      // asking rather than about what they typed.
      const res = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .set('X-DorkOS-Agent', 'not-a-real-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
    });

    it('tells a MEMBER that a room has no files of its own', async () => {
      const roomId = await channel();

      const res = await request(app).get(`/api/rooms/${roomId}/files`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_HAS_NO_REPO');
    });
  });

  describe('what it will and will not serve', () => {
    it('refuses a path that could mean somewhere else', async () => {
      const roomId = await roomWithFiles();

      for (const bad of ['../../etc/passwd', '/etc/passwd', 'docs\\..\\..\\x', '.git/config']) {
        const res = await request(app)
          .get(`/api/rooms/${roomId}/files/content`)
          .query({ path: bad });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(['ROOM_FILE_PATH_INVALID', 'ROOM_FILE_NOT_FOUND']).toContain(res.body.code);
      }
    });

    it('lists a symlink but never follows it', async () => {
      const roomId = await roomWithFiles();

      const res = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'secrets' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ROOM_FILE_NOT_READABLE');
      expect(res.body.error).toContain('link');
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });

    it('answers a binary file as binary and an over-cap file as too large', async () => {
      const roomId = await roomWithFiles();

      const binary = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'logo.png' });
      expect(binary.status).toBe(200);
      expect(binary.body.body).toEqual({ kind: 'binary' });

      maxFileBytes = 3;
      const capped = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/plan.md' });
      expect(capped.status).toBe(200);
      expect(capped.body.body).toEqual({ kind: 'too-large', maxBytes: 3 });
      expect(JSON.stringify(capped.body)).not.toContain('Plan');
    });

    it('answers 404 for a path that is not in the commit', async () => {
      const roomId = await roomWithFiles();

      const res = await request(app)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/nope.md' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_FILE_NOT_FOUND');
    });

    it('leaves every other room path behaving exactly as it does today', async () => {
      const roomId = await roomWithFiles();
      const posted = await request(app).post(`/api/rooms/${roomId}/entries`).send({ text: 'hi' });
      expect(posted.status).toBe(202);
      const read = await request(app).get(`/api/rooms/${roomId}`);
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('files');
    });
  });
});
