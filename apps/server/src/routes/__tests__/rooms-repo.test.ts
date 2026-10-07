/** Genuine authenticated Room repo route controls; native turns acquire each working copy. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import type { Db } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { configManager } from '../../services/core/config-manager.js';
import { initAgentIdentityService } from '../../services/core/agent-identity/agent-identity-service.js';
import {
  createOriginalNativeLaunchFixture,
  type OriginalNativeLaunchFixture,
} from '../../services/rooms/repo/__tests__/room-original-native-launch-fixture.js';
import {
  RoomWorktreeManager,
  type RoomWorktreeHandle,
} from '../../services/rooms/repo/room-worktree-manager.js';
import type { RoomRepoStore } from '../../services/rooms/repo/room-repo-store.js';
import { fixtureGit as runGit } from '../../services/rooms/repo/__tests__/fixture-git.js';

let original: OriginalNativeLaunchFixture;
let testServer: Server;
let ANA_PATH: string;
let target: Awaited<ReturnType<OriginalNativeLaunchFixture['bootNativePair']>>[number];
const admittedRooms = new Set<string>();
function gitInRepo(args: string[], store: RoomRepoStore, roomId: string): Promise<string> {
  return runGit(args, store.repoPath(roomId), store.homeDir(roomId));
}
async function openOriginal() {
  original = await createOriginalNativeLaunchFixture({ seed: false });
  try {
    const pair = await original.bootNativePair();
    target = pair[0]!;
    ANA_PATH = target.agentPath;
    testServer = original.server;
    initAgentIdentityService(original.db);
    admittedRooms.clear();
  } catch (cause) {
    try {
      await original.close();
    } catch {
      /* Preserve setup raw first, including undefined. */
    }
    throw cause;
  }
}
async function closeOriginal() {
  let failed = false;
  let first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  try {
    vi.unstubAllEnvs();
  } catch (cause) {
    remember(cause);
  }
  // Stop each genuinely admitted Room before the fixture joins native/file owners.
  const stops: Promise<unknown>[] = [];
  for (const roomId of admittedRooms) {
    try {
      const stopped = Promise.resolve(
        original.subsystem.service.haltRoom(roomId, original.operator.id)
      );
      void stopped.catch(remember);
      stops.push(stopped);
    } catch (cause) {
      remember(cause);
    }
  }
  // The original close starts its own native/file/checkbox/due cancellations
  // before any request joins. No live request is awaited ahead of its owner.
  try {
    const closing = original.close();
    void closing.catch(remember);
    stops.push(closing);
  } catch (cause) {
    remember(cause);
  }
  for (const result of await Promise.allSettled(stops)) {
    if (result.status === 'rejected') remember(result.reason);
  }
  if (failed) throw first;
}
function setEnabled(enabled: boolean) {
  configManager.set('rooms', {
    ...configManager.get('rooms'),
    repo: { ...configManager.get('rooms').repo, enabled },
  });
}
async function originalWorktree(
  roomId: string,
  agentPath: string,
  name: string
): Promise<RoomWorktreeHandle> {
  expect(agentPath).toBe(target.agentPath);
  // Move this actual native session binding from the boot room to the room
  // the original HTTP create route just opened. This is canonical native DATA;
  // the ensuing real Room post alone issues the private launch request.
  if (original.subsystem.store.getRoomSession(original.roomId, target.authorId)) {
    original.subsystem.service.removeMember(original.roomId, original.operator.id, target.authorId);
  }
  original.subsystem.store.bindRoomSession(
    roomId,
    target.authorId,
    target.sessionId,
    new Date().toISOString()
  );
  admittedRooms.add(roomId);
  const slug = RoomWorktreeManager.slugFor(name, agentPath);
  const directory = path.join(original.repos.worktreesPath(roomId), slug);
  const existed = existsSync(path.join(directory, '.git'));
  const entry = original.subsystem.service.post(roomId, {
    authorId: original.operator.id,
    mentions: [target.authorId],
    text: 'Inspect this Room working copy.',
  });
  await original.subsystem.service.triggersIdle();
  const prepared = original.readPreparedContext(target.sessionId);
  expect(prepared?.triggerEntryId).toBe(entry.id);
  expect(prepared?.files).toBeDefined();
  if (!prepared?.files) throw new Error('Original native placement unavailable');
  expect(prepared.files.worktreePath).toBe(path.join(original.repos.worktreesPath(roomId), slug));
  return {
    slug,
    path: prepared.files.worktreePath,
    branch: prepared.files.branch,
    repo: prepared.files.repoPath,
    created: !existed,
  };
}

describe('POST /api/rooms/:id/repo', () => {
  let db: Db;
  let store: RoomRepoStore;

  beforeEach(async () => {
    await openOriginal();
    db = original.db;
    store = original.repos;
    setEnabled(true);
  });

  afterEach(closeOriginal);

  /** A channel with Ana on the roster. */
  async function channel(): Promise<string> {
    const created = await request(testServer)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ kind: 'channel', title: 'Release train', agentPaths: [ANA_PATH] });
    if (created.status === 201 && typeof created.body.id === 'string')
      admittedRooms.add(created.body.id);
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  it('gives the room a repo when the operator asks', async () => {
    const roomId = await channel();

    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);

    expect(res.status).toBe(201);
    expect(res.body.repo).toMatchObject({ roomId, mode: 'owned', defaultBranch: 'main' });
    // And it is really there, on main, with a first commit.
    expect(await gitInRepo(['rev-parse', '--abbrev-ref', 'HEAD'], store, roomId)).toBe('main');
    expect(await gitInRepo(['ls-files'], store, roomId)).toBe('ROOM.md');
    expect(existsSync(store.sidecarPath(roomId))).toBe(true);
  });

  it('answers 409 with the binding it already had, and makes no second commit', async () => {
    const roomId = await channel();
    const first = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    const head = await gitInRepo(['rev-parse', 'HEAD'], store, roomId);

    const second = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ROOM_REPO_EXISTS');
    expect(second.body.repo).toEqual(first.body.repo);
    expect(await gitInRepo(['rev-parse', 'HEAD'], store, roomId)).toBe(head);
  });

  it('refuses a member agent — enabling is never an agent capability', async () => {
    const roomId = await channel();
    const identity = initAgentIdentityService(db);
    const token = await identity.mint({ agentPath: ANA_PATH, displayName: 'Ana' });

    if (!token) throw new Error('Original identity token unavailable');

    // Ana really is in this room: the same token reads it.
    const reads = await request(testServer)
      .get(`/api/rooms/${roomId}`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .set('X-DorkOS-Agent', token);
    expect(reads.status).toBe(200);

    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .set('X-DorkOS-Agent', token);

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

    if (!token) throw new Error('Original outsider identity token unavailable');

    const known = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .set('X-DorkOS-Agent', token);
    const unknown = await request(testServer)
      .post('/api/rooms/01NOSUCHROOM/repo')
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .set('X-DorkOS-Agent', token);

    expect(known.status).toBe(404);
    expect(known.body.code).toBe('ROOM_NOT_FOUND');
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('ROOM_NOT_FOUND');
  });

  it('refuses a token this machine cannot verify, before any room is looked up', async () => {
    const roomId = await channel();

    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .set('X-DorkOS-Agent', 'not-a-real-token');

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AGENT_IDENTITY_UNVERIFIED');
  });

  it('answers 404 for a room that does not exist', async () => {
    const res = await request(testServer)
      .post('/api/rooms/01NOSUCHROOM/repo')
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROOM_NOT_FOUND');
  });

  it('is not available while config.rooms.repo.enabled is off, and writes nothing', async () => {
    const roomId = await channel();
    setEnabled(false);

    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);

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
      res = await request(testServer)
        .post(`/api/rooms/${roomId}/repo`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`);
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
      setEnabled(flag);
      const posted = await request(testServer)
        .post(`/api/rooms/${roomId}/entries`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ text: `hello ${flag}` });
      expect(posted.status).toBe(202);
      const read = await request(testServer)
        .get(`/api/rooms/${roomId}`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`);
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
  let store: RoomRepoStore;
  /** The SAME manager the merge service holds, so a test works where a turn would. */
  let roomWorktrees: { ensureWorktree: typeof originalWorktree };

  beforeEach(async () => {
    await openOriginal();
    db = original.db;
    store = original.repos;
    roomWorktrees = { ensureWorktree: originalWorktree };
  });

  afterEach(closeOriginal);

  /** A channel with Ana on the roster, with files of its own. */
  async function projectRoom(): Promise<string> {
    const created = await request(testServer)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ kind: 'channel', title: 'Release train', agentPaths: [ANA_PATH] });
    if (created.status === 201 && typeof created.body.id === 'string')
      admittedRooms.add(created.body.id);
    expect(created.status).toBe(201);
    const roomId = created.body.id as string;
    expect(
      (
        await request(testServer)
          .post(`/api/rooms/${roomId}/repo`)
          .set('Authorization', `Bearer ${original.ownerKey.key}`)
      ).status
    ).toBe(201);
    return roomId;
  }

  it('answers the status of a room with files', async () => {
    const roomId = await projectRoom();
    const res = await request(testServer)
      .get(`/api/rooms/${roomId}/repo/status`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);

    expect(res.status).toBe(200);
    expect(res.body.mainCommit).toMatch(/^[0-9a-f]{40}$/);
    // Ana has never worked here, so she has no branch to report yet — an empty
    // list rather than a row full of zeroes.
    expect(res.body.branches).toEqual([]);
    expect(res.body.strandedWorktrees).toEqual([]);
    expect(res.body.size.maxRepoBytes).toBe(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes);
  });

  it('tells a room without files that it has none, on both routes', async () => {
    const created = await request(testServer)
      .post('/api/rooms')
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ kind: 'channel', title: 'Plain', agentPaths: [ANA_PATH] });
    if (created.status === 201 && typeof created.body.id === 'string')
      admittedRooms.add(created.body.id);
    const roomId = created.body.id as string;

    const status = await request(testServer)
      .get(`/api/rooms/${roomId}/repo/status`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    expect(status.status).toBe(409);
    expect(status.body.code).toBe('NOT_A_PROJECT_ROOM');

    const merged = await request(testServer)
      .post(`/api/rooms/${roomId}/repo/merge`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ summary: 'anything' });
    expect(merged.status).toBe(409);
    expect(merged.body.code).toBe('NOT_A_PROJECT_ROOM');
  });

  it('answers an unknown room the way reading one does', async () => {
    const res = await request(testServer)
      .post('/api/rooms/01NOSUCHROOMAAAAAAAAAAAAAA/repo/merge')
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ summary: 'anything' });
    expect(res.status).toBe(404);
  });

  it('refuses a merge with nothing to say', async () => {
    const roomId = await projectRoom();
    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo/merge`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ summary: '' });
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

    const res = await request(testServer)
      .post(`/api/rooms/${roomId}/repo/merge`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`)
      .send({ summary: 'Add the deploy checklist', worktree: tree.slug });

    expect(res.status).toBe(200);
    expect(res.body.files).toBe(1);
    expect(res.body.commit).toBe(await gitInRepo(['rev-parse', 'HEAD'], store, roomId));
    expect(existsSync(path.join(store.repoPath(roomId), 'checklist.md'))).toBe(true);

    // One line in the room, in the room's own voice, about Ana.
    const log = await request(testServer)
      .get(`/api/rooms/${roomId}/entries`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    const merges = (log.body.entries as { body: { merge?: unknown; text: string } }[]).filter(
      (entry) => entry.body.merge !== undefined
    );
    expect(merges).toHaveLength(1);
    expect(merges[0]?.body.text).toContain('Ana merged: Add the deploy checklist');
  });
  describe('dirty main — the pause, and the way out (spec §3.10)', () => {
    /** Edit the room's own copy the way a person with a terminal would. */
    async function editByHand(roomId: string, name: string, body: string): Promise<void> {
      await writeFile(path.join(store.repoPath(roomId), name), body, 'utf-8');
    }

    it('reports what is different, stops every write, and starts again once it is dealt with', async () => {
      const roomId = await projectRoom();
      // Ana has work ready to merge, so the pause is stopping something real.
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

      await editByHand(roomId, 'stray.md', 'typed straight into the folder\n');

      // The warning: what is different, named, so a person can act on it.
      const paused = await request(testServer)
        .get(`/api/rooms/${roomId}/repo/status`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`);
      expect(paused.status).toBe(200);
      expect(paused.body.main).toMatchObject({ branch: 'main', dirty: true, strayCount: 1 });
      expect(paused.body.main.strays).toEqual([{ path: 'stray.md', kind: 'untracked' }]);

      // And the pause itself, on the merge.
      const refused = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/merge`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ summary: 'Add the deploy checklist', worktree: tree.slug });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('MAIN_CHECKOUT_DIRTY');

      // The way out: throw away the change nobody wanted, by name.
      const repaired = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/main/repair`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ action: 'discard', paths: ['stray.md'] });
      expect(repaired.status).toBe(200);
      expect(repaired.body).toMatchObject({ action: 'discard', paths: 1, clean: true });

      // And the room is working again — the merge that was refused now lands.
      const merged = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/merge`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ summary: 'Add the deploy checklist', worktree: tree.slug });
      expect(merged.status).toBe(200);
      const clear = await request(testServer)
        .get(`/api/rooms/${roomId}/repo/status`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`);
      expect(clear.body.main).toMatchObject({ dirty: false, strayCount: 0, strays: [] });
    });

    it('keeping the changes moves main, so the ordinary sync rule takes over', async () => {
      // Worth pinning, because it is the one thing about `commit` that
      // surprises: it ends the pause by making a commit, and a commit on main
      // is a commit every agent's branch is now behind. That is not a failure
      // of the repair — it is the room's normal rule, and the refusal changes
      // from "somebody wrote in here" to "sync first", which is a refusal the
      // agent knows what to do with.
      const roomId = await projectRoom();
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
      await editByHand(roomId, 'stray.md', 'typed straight into the folder\n');

      const repaired = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/main/repair`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ action: 'commit' });
      expect(repaired.body).toMatchObject({ action: 'commit', paths: 1, clean: true });
      // Their work was kept, which is the whole point of the other answer.
      expect(existsSync(path.join(store.repoPath(roomId), 'stray.md'))).toBe(true);

      const merged = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/merge`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ summary: 'Add the deploy checklist', worktree: tree.slug });
      expect(merged.status).toBe(409);
      expect(merged.body.code).toBe('BEHIND_MAIN');
    });

    it('discards only what the operator named', async () => {
      const roomId = await projectRoom();
      await editByHand(roomId, 'throw-away.md', 'not wanted\n');
      await editByHand(roomId, 'keep.md', 'wanted\n');

      const res = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/main/repair`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ action: 'discard', paths: ['throw-away.md'] });

      expect(res.status).toBe(200);
      // Half-dealt-with is a legitimate outcome, and the answer says so rather
      // than implying merges have resumed.
      expect(res.body).toMatchObject({ action: 'discard', paths: 1, clean: false });
      expect(existsSync(path.join(store.repoPath(roomId), 'throw-away.md'))).toBe(false);
      expect(existsSync(path.join(store.repoPath(roomId), 'keep.md'))).toBe(true);
    });

    it('refuses an agent, and refuses a discard of nothing', async () => {
      const roomId = await projectRoom();
      await editByHand(roomId, 'stray.md', 'x\n');
      const token = await initAgentIdentityService(db).mint({
        agentPath: ANA_PATH,
        displayName: 'Ana',
      });

      if (!token) throw new Error('Original identity token unavailable');

      const asAgent = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/main/repair`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .set('X-DorkOS-Agent', token)
        .send({ action: 'commit' });
      expect(asAgent.status).toBe(403);
      expect(asAgent.body.code).toBe('OPERATOR_ONLY');

      // "Discard nothing" is not an action, and the schema says so before any
      // git runs.
      const empty = await request(testServer)
        .post(`/api/rooms/${roomId}/repo/main/repair`)
        .set('Authorization', `Bearer ${original.ownerKey.key}`)
        .send({ action: 'discard', paths: [] });
      expect(empty.status).toBe(400);

      // Neither attempt touched it.
      expect(existsSync(path.join(store.repoPath(roomId), 'stray.md'))).toBe(true);
    });
  });
});
