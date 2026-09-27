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
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, type Db } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

import express from 'express';
import { createApp, finalizeApp } from '../../app.js';
import roomsRouter from '../rooms.js';
import {
  createRoomSubsystem,
  getRoomFileEditor,
  resolveOperatorAuthor,
  setRoomAttachmentStores,
  setRoomFileEditor,
  setRoomFilesService,
  setRoomRepoService,
  setRoomService,
} from '../../services/rooms/index.js';
import {
  RoomFileEditor,
  RoomFilesService,
  RoomRepoMutex,
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
import { ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE } from '../../services/rooms/room-errors.js';
import { LocalRoomAttachmentStore } from '../../services/rooms/attachments/local-room-attachment-store.js';
import { AttachmentRowStore } from '../../services/rooms/attachments/attachment-row-store.js';

const execFileAsync = promisify(execFile);

const app = createApp();
finalizeApp(app);
const testServer = listeningServer(app);

/**
 * The rooms router behind a stand-in for `sessionGate`: it sets
 * `res.locals.user` exactly as the gate does for a signed-in request, which is
 * the one thing the file routes read to decide whose name a commit carries.
 */
let signedInUserId = '';
const signedInApp = express();
signedInApp.use(express.json());
signedInApp.use((_req, res, next) => {
  res.locals.user = { userId: signedInUserId };
  next();
});
signedInApp.use('/api/rooms', roomsRouter);
const signedInServer = listeningServer(signedInApp);

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
  let attachmentRows: AttachmentRowStore;
  let roomSubsystem: ReturnType<typeof createRoomSubsystem>;
  let attachmentStore: LocalRoomAttachmentStore;

  beforeEach(async () => {
    fakeRuntime = new FakeAgentRuntime();
    vi.clearAllMocks();
    resetAgentIdentityService();
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-files-route-'));
    maxFileBytes = ROOM_REPO_CAP_DEFAULTS.maxFileBytes;
    registerAgent(db, 'ana', ANA_PATH);
    const rooms = createRoomSubsystem({ db });
    roomSubsystem = rooms;
    setRoomService(rooms.service);
    setReadCursorService(rooms.readCursors);
    store = new RoomRepoStore(db, dorkHome);
    // ONE queue, shared by the enable path and the save path exactly as
    // production shares it: a save and a repo being created are two writes into
    // the same checkout.
    const mutex = new RoomRepoMutex();
    const repos = new RoomRepoService({
      store,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => true,
      getRoom: (roomId, viewerAuthorId) => rooms.service.getRoom(roomId, viewerAuthorId),
      isOwnerAuthor: (authorId) => rooms.authors.isOwner(authorId, readOwnerAccount()?.id ?? null),
      operatorGitName: () => 'Dorian',
      pinRoomMd: () => {},
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    setRoomRepoService(repos);
    const files = new RoomFilesService({
      store,
      hasRepo: (roomId) => repos.hasRepo(roomId),
      maxFileBytes: () => maxFileBytes,
    });
    setRoomFilesService(files);
    setRoomFileEditor(
      new RoomFileEditor({
        store,
        mutex,
        enabled: () => true,
        queueWaitMs: () => 5000,
        assertCanWriteFiles: (roomId, authorId) =>
          rooms.service.assertCanWriteFiles(roomId, authorId),
        operatorGitName: () => 'Dorian',
        personName: () => null,
        announce: (roomId, input) => rooms.service.postFileChangeEvent(roomId, input),
        uploadStagingRoot: () => path.join(dorkHome, '.temp', 'room-uploads'),
        files,
      })
    );
    attachmentRows = new AttachmentRowStore(db);
    attachmentStore = new LocalRoomAttachmentStore(dorkHome);
    setRoomAttachmentStores({ attachments: attachmentStore, rows: attachmentRows });
  });

  afterEach(async () => {
    resetAgentIdentityService();
    await rm(dorkHome, { recursive: true, force: true });
  });

  /** A channel with Ana on the roster. */
  async function channel(title = 'Release train'): Promise<string> {
    const created = await request(testServer)
      .post('/api/rooms')
      .send({ kind: 'channel', title, agentPaths: [ANA_PATH] });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  /** A channel with Ana on it, given files and one extra commit. */
  async function roomWithFiles(): Promise<string> {
    const roomId = await channel();
    expect((await request(testServer).post(`/api/rooms/${roomId}/repo`)).status).toBe(201);
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

      const listed = await request(testServer).get(`/api/rooms/${roomId}/files`);

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

      const read = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/plan.md' });
      expect(read.status).toBe(200);
      expect(read.body.body).toEqual({ kind: 'text', encoding: 'utf-8', text: '# Plan\n' });
    });

    it('lets a member agent read, exactly as it may read history', async () => {
      const roomId = await roomWithFiles();
      const token = await anaToken();

      const listed = await request(testServer)
        .get(`/api/rooms/${roomId}/files`)
        .set('X-DorkOS-Agent', token);
      const read = await request(testServer)
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
        ].map((url) => request(testServer).get(url).set('X-DorkOS-Agent', token))
      );

      // All three identical: a room with files, a room without, and no room at
      // all. An outsider cannot tell them apart.
      for (const res of answers) {
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('ROOM_NOT_FOUND');
      }
      const contents = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'ROOM.md' })
        .set('X-DorkOS-Agent', token);
      expect(contents.status).toBe(404);
      expect(contents.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('refuses a token this machine cannot verify, before any room is looked up', async () => {
      const roomId = await roomWithFiles();

      const res = await request(testServer)
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
        (await request(testServer).patch(`/api/rooms/${roomId}`).send({ archived: true })).status
      ).toBe(200);

      const listed = await request(testServer).get(`/api/rooms/${roomId}/files`);
      const read = await request(testServer)
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
      const res = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .set('X-DorkOS-Agent', 'not-a-real-token');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
    });

    it('tells a MEMBER that a room has no files of its own', async () => {
      const roomId = await channel();

      const res = await request(testServer).get(`/api/rooms/${roomId}/files`);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_HAS_NO_REPO');
    });
  });

  describe('what it will and will not serve', () => {
    it('refuses a path that could mean somewhere else', async () => {
      const roomId = await roomWithFiles();

      for (const bad of ['../../etc/passwd', '/etc/passwd', 'docs\\..\\..\\x', '.git/config']) {
        const res = await request(testServer)
          .get(`/api/rooms/${roomId}/files/content`)
          .query({ path: bad });
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(['ROOM_FILE_PATH_INVALID', 'ROOM_FILE_NOT_FOUND']).toContain(res.body.code);
      }
    });

    it('lists a symlink but never follows it', async () => {
      const roomId = await roomWithFiles();

      const res = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'secrets' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ROOM_FILE_NOT_READABLE');
      expect(res.body.error).toContain('link');
      expect(JSON.stringify(res.body)).not.toContain('root:');
    });

    it('answers a binary file as binary and an over-cap file as too large', async () => {
      const roomId = await roomWithFiles();

      const binary = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'logo.png' });
      expect(binary.status).toBe(200);
      expect(binary.body.body).toEqual({ kind: 'binary' });

      maxFileBytes = 3;
      const capped = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/plan.md' });
      expect(capped.status).toBe(200);
      expect(capped.body.body).toEqual({ kind: 'too-large', maxBytes: 3 });
      expect(JSON.stringify(capped.body)).not.toContain('Plan');
    });

    it('answers 404 for a path that is not in the commit', async () => {
      const roomId = await roomWithFiles();

      const res = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: 'docs/nope.md' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_FILE_NOT_FOUND');
    });

    it('leaves every other room path behaving exactly as it does today', async () => {
      const roomId = await roomWithFiles();
      const posted = await request(testServer)
        .post(`/api/rooms/${roomId}/entries`)
        .send({ text: 'hi' });
      expect(posted.status).toBe(202);
      const read = await request(testServer).get(`/api/rooms/${roomId}`);
      expect(read.status).toBe(200);
      expect(read.body).not.toHaveProperty('files');
    });
  });
  describe('saving (spec §3.10)', () => {
    /** Read a file back through the API, as a person's editor would. */
    async function readFileAt(
      roomId: string,
      filePath: string
    ): Promise<{
      commit: string;
      text: string;
    }> {
      const res = await request(testServer)
        .get(`/api/rooms/${roomId}/files/content`)
        .query({ path: filePath });
      expect(res.status).toBe(200);
      return { commit: res.body.commit as string, text: res.body.body.text as string };
    }

    it('saves as one commit by the person, and the next read sees it', async () => {
      const roomId = await roomWithFiles();
      const opened = await readFileAt(roomId, 'docs/plan.md');

      const saved = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: '# Plan\n\nShip it.\n' });

      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ path: 'docs/plan.md', committed: true });
      expect(saved.body.commit).not.toBe(opened.commit);
      expect(saved.body.lastCommit).toMatchObject({ author: 'Dorian' });
      // The read path is the proof: it answers out of the commit, so seeing the
      // new text there means the save really was committed.
      expect((await readFileAt(roomId, 'docs/plan.md')).text).toBe('# Plan\n\nShip it.\n');
    });

    it('refuses a member AGENT, and says why rather than pretending the room is gone', async () => {
      const roomId = await roomWithFiles();
      const opened = await readFileAt(roomId, 'docs/plan.md');
      const token = await anaToken();

      const res = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .set('X-DorkOS-Agent', token)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: 'agent was here\n' });

      // An agent in a project room has a working copy of its own and a merge to
      // bring work back through; a second writer in the integration tree is the
      // one-writer rule undone. A 403 because it is a member of a room it can
      // see — there is nothing left to hide.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PEOPLE_ONLY');
      expect((await readFileAt(roomId, 'docs/plan.md')).text).toBe('# Plan\n');
    });

    it('answers an outsider the same 404 an unknown room gets', async () => {
      const roomId = await roomWithFiles();
      const token = await initAgentIdentityService(db).mint({
        agentPath: '/agents/outsider',
        displayName: 'Outsider',
      });

      const res = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .set('X-DorkOS-Agent', token)
        .send({ path: 'docs/plan.md', baseCommit: null, text: 'x\n' });

      // Membership is asked before anything else, so being refused says nothing
      // about whether the room has files — or exists.
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ROOM_NOT_FOUND');
    });

    it('refuses a save whose file moved, and hands back what to do about it', async () => {
      const roomId = await roomWithFiles();
      const opened = await readFileAt(roomId, 'docs/plan.md');
      // Somebody else edits the same file — through the same door, which is the
      // only door a person has.
      const theirs = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: '# Plan\n\nTheirs.\n' });
      expect(theirs.status).toBe(200);

      const mine = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: '# Plan\n\nMine.\n' });

      expect(mine.status).toBe(409);
      expect(mine.body.code).toBe('FILE_CHANGED');
      // The payload is what the reload / keep-mine choice is drawn from — a
      // code and a sentence have nowhere to put it.
      expect(mine.body.conflict).toMatchObject({
        path: 'docs/plan.md',
        commit: theirs.body.commit,
      });
      expect(mine.body.conflict.lastCommit).toMatchObject({ subject: 'Edit docs/plan.md' });
      // Nothing of the losing save landed.
      expect((await readFileAt(roomId, 'docs/plan.md')).text).toBe('# Plan\n\nTheirs.\n');

      // And the way through: send the commit the conflict named, deliberately.
      const overwritten = await request(testServer).put(`/api/rooms/${roomId}/files/content`).send({
        path: 'docs/plan.md',
        baseCommit: mine.body.conflict.commit,
        text: '# Plan\n\nMine, on purpose.\n',
      });
      expect(overwritten.status).toBe(200);
    });

    it('refuses to save into an archived room, though it still reads', async () => {
      const roomId = await roomWithFiles();
      const opened = await readFileAt(roomId, 'docs/plan.md');
      expect(
        (await request(testServer).patch(`/api/rooms/${roomId}`).send({ archived: true })).status
      ).toBe(200);

      const res = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: 'after the fact\n' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_ARCHIVED');
    });

    it('answers a save too large for one request with 413, not a server error', async () => {
      const roomId = await roomWithFiles();
      const opened = await readFileAt(roomId, 'docs/plan.md');

      // Over `express.json`'s 1 MB limit and well under the room's own 5 MB
      // file cap, so the request never reaches the room at all. It used to
      // answer 500 `INTERNAL_ERROR`, which told a person the server had broken
      // rather than the one thing they could act on (found in review).
      const res = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened.commit, text: 'x'.repeat(1_200_000) });

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('REQUEST_TOO_LARGE');
      // And nothing of it landed.
      expect((await readFileAt(roomId, 'docs/plan.md')).text).toBe('# Plan\n');
    });

    it('refuses a room with no files of its own, and a malformed request', async () => {
      const bare = await channel('Quiet corner');
      const noFiles = await request(testServer)
        .put(`/api/rooms/${bare}/files/content`)
        .send({ path: 'ROOM.md', baseCommit: null, text: 'x\n' });
      expect(noFiles.status).toBe(409);
      expect(noFiles.body.code).toBe('ROOM_HAS_NO_REPO');

      const roomId = await roomWithFiles();
      // A base commit that is not a commit id never becomes a git argument.
      const malformed = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'ROOM.md', baseCommit: '--upload-pack=touch /tmp/pwned', text: 'x\n' });
      expect(malformed.status).toBe(400);
    });
  });
  describe('people’s file operations (agent-home-desk §7.1)', () => {
    /** What `main` is at, as the explorer would read it. */
    async function headOf(roomId: string): Promise<string> {
      const res = await request(testServer).get(`/api/rooms/${roomId}/files`);
      expect(res.status).toBe(200);
      return res.body.commit as string;
    }

    /** Every staging folder still on disk. */
    async function stagingLeft(): Promise<string[]> {
      try {
        return await readdir(path.join(dorkHome, '.temp', 'room-uploads'));
      } catch {
        return [];
      }
    }

    /** Every file-change entry in the room, oldest first. */
    async function fileChanges(
      roomId: string
    ): Promise<{ text: string; mentions: unknown[]; fileChange: { kind: string } }[]> {
      const log = await request(testServer).get(`/api/rooms/${roomId}/entries`);
      return (
        log.body.entries as {
          mentions: unknown[];
          body: { text: string; fileChange?: { kind: string } };
        }[]
      )
        .filter((entry) => entry.body.fileChange !== undefined)
        .map((entry) => ({
          text: entry.body.text,
          mentions: entry.mentions,
          fileChange: entry.body.fileChange!,
        }));
    }

    function git(roomId: string, args: string[]): Promise<string> {
      return runGit(args, store.repoPath(roomId), store.homeDir(roomId));
    }

    it('uploads as one commit by the person, posts one quiet entry, and leaves no staging behind', async () => {
      const roomId = await roomWithFiles();
      const base = await headOf(roomId);
      // Disk storage, never memory: the editor is handed files staged under
      // the room-uploads folder, not buffers.
      const upload = vi.spyOn(getRoomFileEditor(), 'upload');

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/files/upload`)
        .field('dir', 'designs')
        .field('baseCommit', base)
        .attach('files', Buffer.from([0x89, 0x50, 0x00]), { filename: 'résumé.png' })
        .attach('files', Buffer.from('notes\n'), { filename: 'notes.md' });

      expect(res.status).toBe(200);
      const staged = upload.mock.calls[0]?.[2].files.map((file) => file.content);
      expect(staged).toHaveLength(2);
      for (const content of staged ?? []) {
        expect(Buffer.isBuffer(content)).toBe(false);
        expect((content as { file: string }).file).toContain(
          path.join(dorkHome, '.temp', 'room-uploads')
        );
      }
      expect(res.body.paths).toEqual(['designs/notes.md', 'designs/résumé.png']);
      expect(await git(roomId, ['log', '--format=%an <%ae>%n%s', '-n', '1'])).toBe(
        'Dorian <operator@dorkos.local>\nUpload 2 files to designs/'
      );
      expect(await stagingLeft()).toEqual([]);
      expect(await fileChanges(roomId)).toEqual([
        {
          text: 'Dorian uploaded 2 files to `designs/`',
          mentions: [],
          fileChange: expect.objectContaining({ kind: 'upload', pathCount: 2 }),
        },
      ]);
    });

    it('removes the staging folder after a refusal too', async () => {
      const roomId = await roomWithFiles();

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/files/upload`)
        .field('dir', 'docs')
        .field('baseCommit', await headOf(roomId))
        .attach('files', Buffer.from('mine\n'), { filename: 'plan.md' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ROOM_FILE_EXISTS');
      expect(res.body.error).toContain('docs/plan.md');
      expect(await stagingLeft()).toEqual([]);
    });

    it('refuses a file over the room’s own cap while reading it, and leaves no staging behind', async () => {
      const roomId = await roomWithFiles();
      const sidecar = (await store.readSidecar(roomId))!;
      await store.write({ ...sidecar, caps: { ...sidecar.caps, maxFileBytes: 16 } });

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/files/upload`)
        .attach('files', Buffer.alloc(64, 1), { filename: 'big.bin' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FILE_TOO_LARGE');
      expect(await stagingLeft()).toEqual([]);
    });

    it('refuses more than twenty files', async () => {
      const roomId = await roomWithFiles();
      let req = request(testServer).post(`/api/rooms/${roomId}/files/upload`);
      for (let i = 0; i < 21; i++) {
        req = req.attach('files', Buffer.from('x'), { filename: `f${i}.md` });
      }

      const res = await req;

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ROOM_UPLOAD_TOO_MANY_FILES');
      expect(await stagingLeft()).toEqual([]);
    });

    it('refuses a member agent every operation, before an upload’s bytes are read', async () => {
      const roomId = await roomWithFiles();
      const token = await anaToken();
      const base = await headOf(roomId);

      const answers = await Promise.all([
        request(testServer)
          .post(`/api/rooms/${roomId}/files/upload`)
          .set('X-DorkOS-Agent', token)
          .attach('files', Buffer.from('x'), { filename: 'a.md' }),
        request(testServer)
          .post(`/api/rooms/${roomId}/files/move`)
          .set('X-DorkOS-Agent', token)
          .send({ from: 'ROOM.md', to: 'R.md', baseCommit: base }),
        request(testServer)
          .post(`/api/rooms/${roomId}/files/delete`)
          .set('X-DorkOS-Agent', token)
          .send({ path: 'ROOM.md', baseCommit: base }),
        request(testServer)
          .post(`/api/rooms/${roomId}/files/from-attachment`)
          .set('X-DorkOS-Agent', token)
          .send({ attachmentId: '01NOPE', dir: '', baseCommit: base }),
      ]);

      for (const res of answers) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('PEOPLE_ONLY');
      }
      expect(await headOf(roomId)).toBe(base);
      expect(await stagingLeft()).toEqual([]);
    });

    it('renames and deletes, one commit each, with the pinned subjects', async () => {
      const roomId = await roomWithFiles();

      const moved = await request(testServer)
        .post(`/api/rooms/${roomId}/files/move`)
        .send({ from: 'docs', to: 'archive/docs', baseCommit: await headOf(roomId) });
      expect(moved.status).toBe(200);
      expect(moved.body.paths).toEqual(['archive/docs/plan.md']);
      expect(moved.body.lastCommit).toMatchObject({ subject: 'Rename docs/ to archive/docs/' });

      const deleted = await request(testServer)
        .post(`/api/rooms/${roomId}/files/delete`)
        .send({ path: 'archive', baseCommit: moved.body.commit });
      expect(deleted.status).toBe(200);
      expect(deleted.body.lastCommit).toMatchObject({ subject: 'Delete archive/' });

      expect((await fileChanges(roomId)).map((entry) => entry.text)).toEqual([
        'Dorian renamed `docs/` to `archive/docs/`',
        'Dorian deleted `archive/`',
      ]);
    });

    it('answers a stale move with the same FILE_CHANGED payload a save gets', async () => {
      const roomId = await roomWithFiles();
      const opened = await headOf(roomId);
      const theirs = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'docs/plan.md', baseCommit: opened, text: '# Plan\n\nTheirs.\n' });
      expect(theirs.status).toBe(200);

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/files/move`)
        .send({ from: 'docs', to: 'old-docs', baseCommit: opened });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FILE_CHANGED');
      expect(res.body.conflict).toMatchObject({ path: 'docs/plan.md', commit: theirs.body.commit });
    });

    it('the existing save now posts an entry too', async () => {
      const roomId = await roomWithFiles();

      const saved = await request(testServer)
        .put(`/api/rooms/${roomId}/files/content`)
        .send({ path: 'ROOM.md', baseCommit: await headOf(roomId), text: '# New\n' });

      expect(saved.status).toBe(200);
      expect(await fileChanges(roomId)).toEqual([
        {
          text: 'Dorian edited `ROOM.md`',
          mentions: [],
          fileChange: expect.objectContaining({ kind: 'edit', paths: ['ROOM.md'] }),
        },
      ]);
    });

    describe('one name, two Unicode spellings (found in review, on APFS)', () => {
      const NFC = 'caf\u00e9.md';
      const NFD = 'cafe\u0301.md';

      /** A room holding the person's own NFC `café.md`. */
      async function roomWithCafe(): Promise<string> {
        const roomId = await roomWithFiles();
        const saved = await request(testServer)
          .put(`/api/rooms/${roomId}/files/content`)
          .send({ path: NFC, baseCommit: null, text: 'mine\n' });
        expect(saved.status).toBe(200);
        return roomId;
      }

      async function cafe(roomId: string): Promise<string> {
        const res = await request(testServer)
          .get(`/api/rooms/${roomId}/files/content`)
          .query({ path: NFC });
        return res.body.body.text as string;
      }

      it('an NFD upload with no replace is refused ROOM_FILE_EXISTS', async () => {
        const roomId = await roomWithCafe();
        const res = await request(testServer)
          .post(`/api/rooms/${roomId}/files/upload`)
          .field('baseCommit', await headOf(roomId))
          .attach('files', Buffer.from('overwritten\n'), { filename: NFD });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROOM_FILE_EXISTS');
        expect(await cafe(roomId)).toBe('mine\n');
      });

      it('an NFD save with no base commit is the FILE_CHANGED choice, not an overwrite', async () => {
        const roomId = await roomWithCafe();
        const res = await request(testServer)
          .put(`/api/rooms/${roomId}/files/content`)
          .send({ path: NFD, baseCommit: null, text: 'overwritten\n' });

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('FILE_CHANGED');
        expect(res.body.conflict.path).toBe(NFC);
        expect(await cafe(roomId)).toBe('mine\n');
      });

      it('an upload of NFD café beside a .git stream name is refused whole, and café survives', async () => {
        const roomId = await roomWithCafe();
        const base = await headOf(roomId);
        const res = await request(testServer)
          .post(`/api/rooms/${roomId}/files/upload`)
          .field('baseCommit', base)
          .field('replace', JSON.stringify([NFD]))
          .attach('files', Buffer.from('overwritten\n'), { filename: NFD })
          .attach('files', Buffer.from('x'), { filename: '.git::$INDEX_ALLOCATION' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('ROOM_FILE_PATH_INVALID');
        expect(await headOf(roomId)).toBe(base);
        expect(await git(roomId, ['status', '--porcelain=v1'])).toBe('');
        expect(await cafe(roomId)).toBe('mine\n');
        // And the room is not stuck: the next save goes in.
        const next = await request(testServer)
          .put(`/api/rooms/${roomId}/files/content`)
          .send({ path: NFC, baseCommit: base, text: 'still mine\n' });
        expect(next.status).toBe(200);
      });
    });

    it('refuses a move or a delete that does not say what the person saw', async () => {
      const roomId = await roomWithFiles();
      const base = await headOf(roomId);

      const moved = await request(testServer)
        .post(`/api/rooms/${roomId}/files/move`)
        .send({ from: 'docs', to: 'old-docs', baseCommit: null });
      const deleted = await request(testServer)
        .post(`/api/rooms/${roomId}/files/delete`)
        .send({ path: 'docs', baseCommit: null });

      expect(moved.status).toBe(400);
      expect(deleted.status).toBe(400);
      expect(await headOf(roomId)).toBe(base);
    });

    describe('with login on', () => {
      it('authors each person’s commit as that person — two people, two authors', async () => {
        const roomId = await roomWithFiles();
        const owner = resolveOperatorAuthor(roomSubsystem.authors).id;
        const people = ['user-one', 'user-two'].map((userId) => {
          const author = roomSubsystem.authors.human(userId);
          roomSubsystem.service.addMember(roomId, owner, { authorId: author.id });
          return { userId, authorId: author.id };
        });

        for (const [index, person] of people.entries()) {
          signedInUserId = person.userId;
          const res = await request(signedInServer)
            .put(`/api/rooms/${roomId}/files/content`)
            .send({ path: `by-${index}.md`, baseCommit: null, text: `${index}\n` });
          expect(res.status).toBe(200);
        }

        expect(await git(roomId, ['log', '--format=%ae', '-n', '2'])).toBe(
          people
            .map((person) => `person-${person.authorId}@dorkos.local`)
            .reverse()
            .join('\n')
        );
      });
    });

    describe('a room whose git settings name a program (DOR-2457)', () => {
      /** The key an agent's plain `git config` could plant, with a quote in its subsection. */
      const KEY = "filter.it's`x`.smudge";

      /** Plant {@link KEY} in the room's shared settings, as an agent's shell could. */
      async function armed(): Promise<{ roomId: string; configFile: string }> {
        const roomId = await roomWithFiles();
        const configFile = path.join(store.repoPath(roomId), '.git', 'config');
        await execFileAsync('git', ['config', '--file', configFile, KEY, 'cat']);
        return { roomId, configFile };
      }

      it('tells the operator the file, the key, and a command that removes exactly it', async () => {
        const { roomId, configFile } = await armed();

        const res = await request(testServer).get(`/api/rooms/${roomId}/files`);

        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROOM_REPO_CONFIG_UNSAFE');
        expect(res.body.error).toContain(KEY);
        expect(res.body.error).toContain(configFile);
        // The command rides in its own field, so no renderer of the sentence
        // can mangle it. It is the real one, quoted for a shell: run it as the
        // operator would paste it, and the room reads again.
        const command = res.body.command as string;
        expect(command).toContain(configFile);
        expect(command).not.toContain('<name>');
        await execFileAsync('sh', ['-c', command]);
        expect((await request(testServer).get(`/api/rooms/${roomId}/files`)).status).toBe(200);
      });

      it('tells anybody else only that the files are paused, never a path on this machine', async () => {
        const { roomId } = await armed();
        const owner = resolveOperatorAuthor(roomSubsystem.authors).id;
        const person = roomSubsystem.authors.human('user-member');
        roomSubsystem.service.addMember(roomId, owner, { authorId: person.id });
        signedInUserId = 'user-member';
        const token = await anaToken();

        const answers = await Promise.all([
          request(signedInServer).get(`/api/rooms/${roomId}/files`),
          request(signedInServer)
            .put(`/api/rooms/${roomId}/files/content`)
            .send({ path: 'notes.md', baseCommit: null, text: 'x\n' }),
          request(testServer).get(`/api/rooms/${roomId}/files`).set('X-DorkOS-Agent', token),
        ]);

        for (const res of answers) {
          expect(res.status).toBe(409);
          expect(res.body).toEqual({
            code: 'ROOM_REPO_CONFIG_UNSAFE',
            error: ROOM_REPO_CONFIG_UNSAFE_MEMBER_MESSAGE,
          });
          expect(JSON.stringify(res.body)).not.toContain(dorkHome);
          expect(JSON.stringify(res.body)).not.toContain(KEY);
        }
      });
    });

    describe('from the chat', () => {
      /** An attachment in `roomId`, posted on a message there unless `bound` is false. */
      async function attachment(roomId: string, bound = true): Promise<string> {
        const id = `01ATT${Math.random().toString(36).slice(2, 12).toUpperCase().padEnd(21, 'A')}`;
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
        const { url } = await attachmentStore.put(roomId, id, 'png', bytes);
        attachmentRows.create(
          {
            roomId,
            id,
            authorId: resolveOperatorAuthor(roomSubsystem.authors).id,
            name: 'screenshot.png',
            extension: 'png',
            mimeType: 'image/png',
            size: bytes.length,
            preview: null,
            url,
          },
          new Date().toISOString()
        );
        if (bound) {
          const posted = await request(testServer)
            .post(`/api/rooms/${roomId}/entries`)
            .send({ text: 'look', attachmentIds: [id] });
          expect(posted.status).toBe(202);
        }
        return id;
      }

      it('keeps a posted attachment as one of the room’s files', async () => {
        const roomId = await roomWithFiles();
        const id = await attachment(roomId);

        const res = await request(testServer)
          .post(`/api/rooms/${roomId}/files/from-attachment`)
          .send({ attachmentId: id, dir: 'designs', baseCommit: await headOf(roomId) });

        expect(res.status).toBe(200);
        expect(res.body.paths).toEqual(['designs/screenshot.png']);
        expect(res.body.lastCommit).toMatchObject({
          subject: 'Add designs/screenshot.png from the chat',
        });
        expect((await fileChanges(roomId)).map((entry) => entry.text)).toEqual([
          'Dorian saved `screenshot.png` from the chat to `designs/`',
        ]);
      });

      it('answers 404 for another room’s attachment and for one never posted', async () => {
        const roomId = await roomWithFiles();
        const elsewhere = await channel('Elsewhere');
        const foreign = await attachment(elsewhere);
        const unposted = await attachment(roomId, false);
        const base = await headOf(roomId);

        for (const attachmentId of [foreign, unposted, '01NOSUCHATTACHMENT']) {
          const res = await request(testServer)
            .post(`/api/rooms/${roomId}/files/from-attachment`)
            .send({ attachmentId, dir: '', baseCommit: base });
          expect(res.status).toBe(404);
          expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
        }
        expect(await headOf(roomId)).toBe(base);
      });
    });
  });
});
