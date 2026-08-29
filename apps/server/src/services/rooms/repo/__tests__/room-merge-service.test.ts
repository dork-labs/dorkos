/**
 * Merging an agent's work into a room, and every reason a merge is refused
 * (spec `project-rooms` §3.6).
 *
 * Real git, real worktrees, on a real temporary DorkOS home that sits INSIDE
 * another git repository — the dev layout, which is also the trap layout: a
 * question asked without a discovery ceiling is answered by the enclosing
 * checkout instead.
 *
 * Only the room's own service is a stand-in, and only for the two things it
 * answers: who is a member, and what the room log accepted. The git half is
 * never faked, because "the merge commit has two parents" and "main is
 * unchanged after a conflict" are claims about git and not about a mock.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the `behind > 0` check reddens "refuses a branch the room has
 *   moved past" AND turns the concurrent-merge test's second merge into a real
 *   conflict — which is the whole reason that check exists.
 * - Dropping the dirty-worktree check reddens "refuses uncommitted work", and
 *   the merge then silently leaves the edit behind.
 * - Dropping the symlink escape check reddens "refuses a shortcut pointing out
 *   of the room"; dropping either size check reddens its own test.
 * - Running the checks OUTSIDE the queue (checking before `mutex.run` rather
 *   than inside it) reddens "two merges land one after the other".
 * - Removing `merge --abort` from `mergeNoFf` reddens "a merge that will not go
 *   in leaves main exactly as it was": the checkout is left mid-merge with
 *   conflict markers staged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room, RoomEntry } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS, type RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { MAX_QUEUE_DEPTH, RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { RoomMergeService, symlinkLeavesRepo } from '../room-merge-service.js';
import { mergeNoFf, runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = 'author-operator';
const ANA = 'author-ana';
const BEN = 'author-ben';

const ROOM: Room = {
  id: ROOM_ID,
  kind: 'channel',
  slug: 'release-train',
  title: 'Release train',
  topic: 'Shipping 0.70',
  archived: false,
  ambientMaxEntries: 20,
  createdAt: '2026-08-27T12:00:00.000Z',
  lastActivityAt: '2026-08-27T12:00:00.000Z',
};

/** What the fake room log recorded. */
interface Announcement {
  text: string;
  merge: { branch: string; commit: string; files: number; insertions: number; deletions: number };
  subjectAuthorId: string;
}

describe('RoomMergeService', () => {
  let db: Db;
  let scratch: string;
  let store: RoomRepoStore;
  let repos: RoomRepoService;
  let worktrees: RoomWorktreeManager;
  let merges: RoomMergeService;
  let mutex: RoomRepoMutex;
  /** Everything the room was told, oldest first. */
  let announced: Announcement[];
  /** Who may see the room; anybody else is answered as "no such room". */
  let members: string[];
  /** `config.rooms.repo.enabled`, per test. */
  let enabled: boolean;
  /** The room, so a test can archive it. */
  let room: Room;
  /** The caps a NEW binding is created under, per test. */
  let caps: RoomRepoCaps;
  /** The next `seq` the fake room log hands out. */
  let nextSeq: number;

  /** Run git in `dir` with the room's home as the discovery ceiling. */
  function git(args: string[], dir: string): Promise<string> {
    return runGit(args, dir, store.homeDir(ROOM_ID));
  }

  /** Where agent `name` keeps its work — the workspace path is its identity. */
  function agentPath(name: string): string {
    return path.join(scratch, 'agents', name);
  }

  /** The agents on the room's roster, by author id. */
  const roster: Record<string, { name: string; displayName: string }> = {
    [ANA]: { name: 'ana', displayName: 'Ana' },
    [BEN]: { name: 'ben', displayName: 'Ben' },
  };

  /** The worktree slug one agent takes. */
  function slugOf(authorId: string): string {
    const agent = roster[authorId];
    if (!agent) throw new Error(`no such agent ${authorId}`);
    return RoomWorktreeManager.slugFor(agent.displayName, agentPath(agent.name));
  }

  /** Give an agent its working copy and answer where it is. */
  async function worktreeFor(authorId: string): Promise<string> {
    const agent = roster[authorId];
    if (!agent) throw new Error(`no such agent ${authorId}`);
    const handle = await worktrees.ensureWorktree(
      ROOM_ID,
      agentPath(agent.name),
      agent.displayName
    );
    return handle.path;
  }

  /** Write a file in an agent's working copy and commit it there. */
  async function commitIn(
    authorId: string,
    file: string,
    contents: string,
    message = 'work'
  ): Promise<string> {
    const dir = await worktreeFor(authorId);
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), contents, 'utf-8');
    await git(['add', '--all'], dir);
    await git(
      ['-c', 'user.name=Agent', '-c', 'user.email=a@dorkos.local', 'commit', '-q', '-m', message],
      dir
    );
    return dir;
  }

  /** The refusal a call made, or a failure saying it made none. */
  async function refusalOf(call: Promise<unknown>): Promise<RoomError> {
    try {
      await call;
    } catch (err) {
      if (err instanceof RoomError) return err;
      throw err;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  beforeEach(async () => {
    db = createTestDb();
    // Before anything makes a repo: keep git's detached maintenance child from
    // racing this suite's teardown into the directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    // The DorkOS home sits inside a git repository on purpose — see the header.
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-merge-'));
    await runGit(['init', '-b', 'main', '--quiet', '.'], scratch, scratch);
    await writeFile(path.join(scratch, '.gitignore'), '*\n', 'utf-8');
    await runGit(['add', '-f', '.gitignore'], scratch, scratch);
    await runGit(
      [
        '-c',
        'user.name=Enclosing',
        '-c',
        'user.email=e@dorkos.local',
        'commit',
        '-q',
        '-m',
        'base',
      ],
      scratch,
      scratch
    );
    const dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });

    store = new RoomRepoStore(db, dorkHome);
    mutex = new RoomRepoMutex();
    announced = [];
    members = [OPERATOR, ANA, BEN];
    enabled = true;
    room = { ...ROOM };
    caps = { ...ROOM_REPO_CAP_DEFAULTS };
    nextSeq = 1;

    db.insert(rooms)
      .values({
        id: ROOM_ID,
        kind: 'channel',
        title: ROOM.title,
        topic: ROOM.topic,
        createdAt: ROOM.createdAt,
        lastActivityAt: ROOM.lastActivityAt,
      })
      .run();

    repos = new RoomRepoService({
      store,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => enabled,
      getRoom: () => room,
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => 'Dorian',
      caps: () => caps,
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
    worktrees = new RoomWorktreeManager({
      store,
      hasRepo: (roomId) => repos.hasRepo(roomId),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      reapAfterDays: () => 14,
      busyAgentPaths: () => [],
    });
    merges = new RoomMergeService({
      store,
      mutex,
      enabled: () => enabled,
      mergeQueueWaitMs: () => 5000,
      requireMembership: (_roomId, authorId) => {
        // The real service answers "not a member" exactly as "no such room".
        if (!members.includes(authorId)) throw new RoomError('ROOM_NOT_FOUND', 'No such room');
        return room;
      },
      listAgentMembers: (_roomId) =>
        members
          .filter((authorId) => roster[authorId])
          .map((authorId) => ({
            authorId,
            agentPath: agentPath(roster[authorId]!.name),
            displayName: roster[authorId]!.displayName,
          })),
      listStrandedWorktrees: (roomId) => repos.listStrandedWorktrees(roomId),
      announce: (_roomId, input) => {
        announced.push(input);
        return { seq: nextSeq++ } as RoomEntry;
      },
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeFixtureTree(scratch);
  });

  /** Give the room files, as the operator would. */
  async function enableRepo(): Promise<void> {
    await repos.enable(ROOM_ID, OPERATOR);
  }

  describe('the gates every repo verb shares', () => {
    it('refuses a room with no files', async () => {
      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));
      expect(refusal.code).toBe('NOT_A_PROJECT_ROOM');
    });

    it('refuses when room files are switched off for the whole install', async () => {
      await enableRepo();
      enabled = false;
      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));
      expect(refusal.code).toBe('ROOM_REPOS_DISABLED');
    });

    it('answers a non-member exactly as it answers a room that does not exist', async () => {
      await enableRepo();
      members = [OPERATOR, ANA];
      const refusal = await refusalOf(merges.merge(ROOM_ID, BEN, { summary: 'work' }));
      // Never a 403-shaped code: a room id must not be a capability.
      expect(refusal.code).toBe('ROOM_NOT_FOUND');
    });

    it('refuses to merge into an archived room', async () => {
      await enableRepo();
      await commitIn(ANA, 'notes.md', 'hello');
      room = { ...room, archived: true };
      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));
      // Asked BEFORE the merge, so nothing lands in git that the room could
      // never be told about.
      expect(refusal.code).toBe('ROOM_ARCHIVED');
      expect(announced).toHaveLength(0);
    });
  });

  describe('merging', () => {
    it('brings the work in, as one merge commit, and says so once', async () => {
      await enableRepo();
      const before = await git(['rev-parse', 'main'], store.repoPath(ROOM_ID));
      await commitIn(ANA, 'checklist.md', 'one\ntwo\n');

      const result = await merges.merge(ROOM_ID, ANA, { summary: 'Add the deploy checklist' });

      const repoDir = store.repoPath(ROOM_ID);
      // The file is really on main, in the room's own checkout.
      expect(await readFile(path.join(repoDir, 'checklist.md'), 'utf-8')).toBe('one\ntwo\n');
      // `--no-ff`: a real merge commit with two parents, even though this could
      // have fast-forwarded. A room's log says "Ana merged …" about a commit,
      // and the commit has to exist.
      const parents = (await git(['rev-list', '--parents', '-n', '1', 'HEAD'], repoDir)).split(' ');
      expect(parents).toHaveLength(3);
      expect(parents[1]).toBe(before);
      expect(result.commit).toBe(await git(['rev-parse', 'HEAD'], repoDir));

      // Exactly one line in the room, about the right agent, carrying the
      // machine-readable half the explorer reads.
      expect(announced).toHaveLength(1);
      expect(announced[0]?.subjectAuthorId).toBe(ANA);
      expect(announced[0]?.text).toBe('Ana merged: Add the deploy checklist — 1 file, +2/−0');
      expect(announced[0]?.merge.branch).toBe(`room/${slugOf(ANA)}`);
      expect(announced[0]?.merge.commit).toBe(result.commit);
    });

    it('records the merge on the sidecar, so the explorer knows where to refresh from', async () => {
      await enableRepo();
      expect((await store.readSidecar(ROOM_ID))?.lastMergeSeq).toBeNull();
      await commitIn(ANA, 'checklist.md', 'one\n');

      const result = await merges.merge(ROOM_ID, ANA, { summary: 'Start the checklist' });

      expect((await store.readSidecar(ROOM_ID))?.lastMergeSeq).toBe(result.seq);
      // The derived row follows the file, as it does for every other write.
      expect(store.getRow(ROOM_ID)?.lastMergeSeq).toBe(result.seq);
    });

    it('takes the summary as the merge commit’s own subject, control characters and all', async () => {
      await enableRepo();
      await commitIn(ANA, 'checklist.md', 'one\n');

      await merges.merge(ROOM_ID, ANA, {
        // A newline and a unit separator: the 1.4 lesson is that anything
        // reaching git identity or a git message is a place a control character
        // can forge a line.
        summary: 'Add the checklist\n\u001fAuthor: somebody else',
      });

      const subject = await git(['log', '-1', '--format=%s'], store.repoPath(ROOM_ID));
      expect(subject).toBe('Add the checklist Author: somebody else');
      expect(subject).not.toContain('\n');
      const author = await git(['log', '-1', '--format=%an <%ae>'], store.repoPath(ROOM_ID));
      expect(author).toBe(`Ana <${slugOf(ANA)}@dorkos.local>`);
    });
  });

  describe('the refusals', () => {
    it('refuses when the agent has never worked here', async () => {
      await enableRepo();
      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));
      expect(refusal.code).toBe('NOTHING_TO_MERGE');
      expect(announced).toHaveLength(0);
    });

    it('refuses a branch that holds nothing the room has not got', async () => {
      await enableRepo();
      await worktreeFor(ANA);
      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'nothing' }));
      // Never an empty merge commit, and never a room entry announcing that
      // somebody merged nothing.
      expect(refusal.code).toBe('NOTHING_TO_MERGE');
      expect(announced).toHaveLength(0);
    });

    it('refuses uncommitted work, and leaves the edit alone', async () => {
      await enableRepo();
      const dir = await commitIn(ANA, 'checklist.md', 'one\n');
      await writeFile(path.join(dir, 'checklist.md'), 'one\ntwo-uncommitted\n', 'utf-8');

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('UNCOMMITTED_WORK');
      // The server never writes in an agent's tree, refusal included.
      expect(await readFile(path.join(dir, 'checklist.md'), 'utf-8')).toBe(
        'one\ntwo-uncommitted\n'
      );
    });

    it('refuses a branch the room has moved past, and says how far', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      await commitIn(BEN, 'ben.md', 'ben\n');
      // Ana lands first, so Ben's branch no longer contains main.
      await merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' });

      const refusal = await refusalOf(merges.merge(ROOM_ID, BEN, { summary: 'Ben’s work' }));

      expect(refusal.code).toBe('BEHIND_MAIN');
      // The numbers are the point: they decide what the agent does next.
      expect(refusal.message).toContain('main is 2 commits ahead');
      expect(refusal.message).toContain('you are 1 commit ahead');
      expect(refusal.message).toContain('git merge main');
      expect(announced).toHaveLength(1);
    });

    it('lets the agent through once it has synced in its own tree', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      const benDir = await commitIn(BEN, 'ben.md', 'ben\n');
      await merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' });

      // Sync is plain git in the agent's own tree — deliberately not a tool.
      await git(
        ['-c', 'user.name=Ben', '-c', 'user.email=b@dorkos.local', 'merge', 'main'],
        benDir
      );
      const result = await merges.merge(ROOM_ID, BEN, { summary: 'Ben’s work' });

      const repoDir = store.repoPath(ROOM_ID);
      expect(await readFile(path.join(repoDir, 'ana.md'), 'utf-8')).toBe('ana\n');
      expect(await readFile(path.join(repoDir, 'ben.md'), 'utf-8')).toBe('ben\n');
      expect(result.seq).toBeGreaterThan(0);
      expect(announced).toHaveLength(2);
    });

    it('refuses to merge into an integration tree somebody else has written in', async () => {
      await enableRepo();
      await commitIn(ANA, 'checklist.md', 'one\n');
      // An operator with a terminal. Nothing in DorkOS can do this.
      await writeFile(path.join(store.repoPath(ROOM_ID), 'stray.txt'), 'by hand', 'utf-8');

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('MAIN_CHECKOUT_DIRTY');
      // Loud degradation, never quiet corruption: the stray file is still there.
      expect(await readFile(path.join(store.repoPath(ROOM_ID), 'stray.txt'), 'utf-8')).toBe(
        'by hand'
      );
    });

    it('refuses a shortcut pointing out of the room’s files', async () => {
      await enableRepo();
      const dir = await worktreeFor(ANA);
      await symlink('/etc/passwd', path.join(dir, 'secrets'));
      await git(['add', '--all'], dir);
      await git(
        ['-c', 'user.name=A', '-c', 'user.email=a@dorkos.local', 'commit', '-q', '-m', 'link'],
        dir
      );

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('SYMLINK_ESCAPES_REPO');
      expect(refusal.message).toContain('secrets');
      // Nothing landed: validation runs before the merge, not after it.
      expect(await git(['rev-list', '--count', 'HEAD'], store.repoPath(ROOM_ID))).toBe('1');
    });

    it('allows a shortcut that stays inside the room’s files', async () => {
      await enableRepo();
      const dir = await worktreeFor(ANA);
      await writeFile(path.join(dir, 'real.md'), 'content\n', 'utf-8');
      await symlink('real.md', path.join(dir, 'alias.md'));
      await git(['add', '--all'], dir);
      await git(
        ['-c', 'user.name=A', '-c', 'user.email=a@dorkos.local', 'commit', '-q', '-m', 'link'],
        dir
      );

      await expect(merges.merge(ROOM_ID, ANA, { summary: 'Add an alias' })).resolves.toMatchObject({
        files: 2,
      });
    });

    it('refuses a submodule, which no other check can see inside', async () => {
      await enableRepo();
      const dir = await worktreeFor(ANA);
      // A gitlink, built the way git itself records one: a tree entry of mode
      // 160000 naming a commit that lives in another repository. It used to
      // reach `main` untouched, because the tree listing dropped everything
      // that was not a blob — so it appeared in neither tree and was never in
      // the delta any validation walks.
      const foreign = path.join(scratch, 'foreign');
      await mkdir(foreign, { recursive: true });
      await runGit(['init', '-b', 'main', '--quiet', '.'], foreign, scratch);
      await writeFile(path.join(foreign, 'a.txt'), 'x', 'utf-8');
      await runGit(['add', '--all'], foreign, scratch);
      await runGit(
        ['-c', 'user.name=F', '-c', 'user.email=f@dorkos.local', 'commit', '-q', '-m', 'foreign'],
        foreign,
        scratch
      );
      // Cloned in rather than hand-written into the index, so the working copy
      // is genuinely CLEAN afterwards — otherwise the dirty check refuses first
      // and the test would pass for the wrong reason.
      await git(['clone', '--quiet', foreign, 'vendor'], dir);
      await git(['add', 'vendor'], dir);
      await git(
        ['-c', 'user.name=A', '-c', 'user.email=a@dorkos.local', 'commit', '-q', '-m', 'submodule'],
        dir
      );

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'vendor it' }));

      expect(refusal.code).toBe('SUBMODULE_NOT_ALLOWED');
      expect(refusal.message).toContain('vendor');
      // Nothing landed: main still holds only its seed commit.
      expect(await git(['rev-list', '--count', 'HEAD'], store.repoPath(ROOM_ID))).toBe('1');
    });

    it('refuses a file bigger than the room’s own limit', async () => {
      caps = { ...ROOM_REPO_CAP_DEFAULTS, maxFileBytes: 64 };
      await enableRepo();
      await commitIn(ANA, 'big.bin', 'x'.repeat(200));

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('FILE_TOO_LARGE');
      expect(refusal.message).toContain('big.bin');
    });

    it('reads the caps off the sidecar, so lowering a setting cannot make old files illegal', async () => {
      caps = { ...ROOM_REPO_CAP_DEFAULTS, maxFileBytes: 1024 };
      await enableRepo();
      await commitIn(ANA, 'medium.txt', 'x'.repeat(200));
      // The install's setting is lowered AFTER the repo was created. The
      // sidecar remembers what this room was created under.
      caps = { ...ROOM_REPO_CAP_DEFAULTS, maxFileBytes: 8 };

      await expect(merges.merge(ROOM_ID, ANA, { summary: 'work' })).resolves.toBeDefined();
    });

    it('refuses work that would take the whole room past its limit', async () => {
      caps = { ...ROOM_REPO_CAP_DEFAULTS, maxRepoBytes: 256 };
      await enableRepo();
      await commitIn(ANA, 'a.txt', 'x'.repeat(400));

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('REPO_CAP_EXCEEDED');
    });
  });

  describe('whose branch this is', () => {
    it('refuses an agent naming somebody else’s working copy', async () => {
      await enableRepo();
      await commitIn(BEN, 'ben.md', 'ben\n');

      const refusal = await refusalOf(
        merges.merge(ROOM_ID, ANA, { summary: 'not mine', worktree: slugOf(BEN) })
      );

      expect(refusal.code).toBe('OPERATOR_ONLY');
      expect(announced).toHaveLength(0);
    });

    it('lets the operator merge an agent’s working copy, credited to that agent', async () => {
      await enableRepo();
      await commitIn(BEN, 'ben.md', 'ben\n');

      await merges.merge(ROOM_ID, OPERATOR, {
        summary: 'Land Ben’s work',
        worktree: slugOf(BEN),
      });

      // Credited to Ben, whose work it is — the operator merged it, they did
      // not write it.
      expect(announced[0]?.subjectAuthorId).toBe(BEN);
      expect(announced[0]?.text).toContain('Ben merged');
    });

    it('tells the operator there is nothing to merge when they name nothing', async () => {
      await enableRepo();
      await commitIn(BEN, 'ben.md', 'ben\n');
      const refusal = await refusalOf(merges.merge(ROOM_ID, OPERATOR, { summary: 'mine' }));
      expect(refusal.code).toBe('NOTHING_TO_MERGE');
    });
  });

  describe('the queue’s two refusals', () => {
    it('tells a caller turned away at the door that it never waited', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      // Fill the lane and its queue, then arrive. The wait cap here is minutes,
      // so nothing below can be a timeout — the refusal can only be the depth
      // cap, and it must not claim a wait that never happened.
      const held: Promise<unknown>[] = [];
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      held.push(mutex.run(ROOM_ID, { waitMs: 60_000, busy: () => new Error('x') }, () => gate));
      for (let i = 0; i < MAX_QUEUE_DEPTH; i += 1) {
        held.push(
          mutex.run(ROOM_ID, { waitMs: 60_000, busy: () => new Error('x') }, async () => undefined)
        );
      }

      const refusal = await refusalOf(merges.merge(ROOM_ID, ANA, { summary: 'work' }));

      expect(refusal.code).toBe('MERGE_IN_FLIGHT');
      // The words are the point: this caller was refused instantly.
      expect(refusal.message).toContain('not added to the queue');
      expect(refusal.message).not.toContain('wait ran out');

      release();
      await Promise.all(held);
    });
  });

  describe('two merges at once', () => {
    it('runs them one after the other, and the second sees the first', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      await commitIn(BEN, 'ben.md', 'ben\n');

      // Started in one tick. Without the queue these would run `git merge` in
      // one checkout at the same time.
      const [first, second] = await Promise.allSettled([
        merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' }),
        merges.merge(ROOM_ID, BEN, { summary: 'Ben’s work' }),
      ]);

      const outcomes = [first, second];
      const landed = outcomes.filter((o) => o.status === 'fulfilled');
      const refused = outcomes.filter((o) => o.status === 'rejected');
      // One lands. The other is refused BEHIND_MAIN, because the first moved
      // main under it — which is correct rather than unfortunate: it will sync
      // in its own tree and come back.
      expect(landed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      const reason = (refused[0] as PromiseRejectedResult).reason as RoomError;
      expect(reason).toBeInstanceOf(RoomError);
      expect(reason.code).toBe('BEHIND_MAIN');
      // And whatever happened, the room heard about it exactly once.
      expect(announced).toHaveLength(1);
      // Main is a working checkout afterwards, not a tree stuck mid-merge.
      expect(await runGit(['status', '--porcelain=v1'], store.repoPath(ROOM_ID), scratch)).toBe('');
    });

    it('serializes a merge against an enable of the same room', async () => {
      // The absorbed DOR-1598 obligation, from the other side: a merge must
      // never run against a repo that is halfway through being created.
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      const [enableResult, mergeResult] = await Promise.all([
        repos.enable(ROOM_ID, OPERATOR),
        merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' }),
      ]);
      expect(enableResult.created).toBe(false);
      expect(mergeResult.files).toBe(1);
    });
  });

  describe('room_repo_status', () => {
    it('reports the main tip, every branch, and what is unmerged', async () => {
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      const benDir = await commitIn(BEN, 'ben.md', 'ben\n');
      await writeFile(path.join(benDir, 'scratch.md'), 'wip', 'utf-8');
      await merges.merge(ROOM_ID, ANA, { summary: 'Ana’s work' });

      const status = await merges.status(ROOM_ID, ANA);

      expect(status.mainCommit).toBe(await git(['rev-parse', 'main'], store.repoPath(ROOM_ID)));
      expect(status.mainCommittedAt).toMatch(/^\d{4}-/);

      const ana = status.branches.find((b) => b.slug === slugOf(ANA));
      // Ana has merged, so she is holding nothing — but she IS one behind, and
      // that is `--no-ff` being honest: the merge commit exists on main and on
      // no branch. Nothing is stranded, because stranded is about work nobody
      // has, not about a branch being level.
      expect(ana).toMatchObject({ agent: 'Ana', mine: true, ahead: 0, behind: 1, dirty: false });
      expect(ana?.stranded).toBe(false);

      const ben = status.branches.find((b) => b.slug === slugOf(BEN));
      expect(ben).toMatchObject({ agent: 'Ben', mine: false, ahead: 1, dirty: true });
      expect(ben?.behind).toBeGreaterThan(0);
      expect(ben?.stranded).toBe(true);
      expect(status.strandedWorktrees).toEqual([slugOf(BEN)]);

      expect(status.size.usedBytes).toBeGreaterThan(0);
      expect(status.size.maxRepoBytes).toBe(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes);
    });

    it('never puts an agent’s workspace path in front of the room', async () => {
      await enableRepo();
      await commitIn(BEN, 'ben.md', 'ben\n');
      const status = await merges.status(ROOM_ID, ANA);
      // An agent reads its own rooms' status, and `/Users/…` is not something
      // to hand every member. The slug is a digest, which is the point.
      expect(JSON.stringify(status)).not.toContain(agentPath('ben'));
    });

    it('answers a non-member as no such room', async () => {
      await enableRepo();
      members = [OPERATOR, ANA];
      const refusal = await refusalOf(merges.status(ROOM_ID, BEN));
      expect(refusal.code).toBe('ROOM_NOT_FOUND');
    });

    it('gives each caller their OWN branch as `mine`, even off the same cached answer', async () => {
      // The answer is memoized per `(room, main sha)` for a few seconds, and
      // `mine` is the one field in it that is about who ASKED rather than about
      // the room. So the cache must hold the room's answer and re-aim `mine`
      // per caller — the tempting mistake is to cache the whole per-caller
      // object, which hands the second caller the first one's idea of whose
      // branch is theirs. Both agents commit so both have a branch to own.
      await enableRepo();
      await commitIn(ANA, 'ana.md', 'ana\n');
      await commitIn(BEN, 'ben.md', 'ben\n');

      // Ana asks first: a cache miss, so this computes and stores.
      const forAna = await merges.status(ROOM_ID, ANA);
      // Ben asks inside the memo window: a cache HIT on the same `main` sha, so
      // this exercises `withCaller` on a cached answer rather than a fresh one.
      const forBen = await merges.status(ROOM_ID, BEN);

      const anaSlug = slugOf(ANA);
      const benSlug = slugOf(BEN);

      // Each sees exactly their own row as theirs.
      expect(forAna.branches.find((b) => b.slug === anaSlug)?.mine).toBe(true);
      expect(forAna.branches.find((b) => b.slug === benSlug)?.mine).toBe(false);
      expect(forBen.branches.find((b) => b.slug === benSlug)?.mine).toBe(true);
      expect(forBen.branches.find((b) => b.slug === anaSlug)?.mine).toBe(false);

      // And it really was one cached computation, not two: the two answers agree
      // on every field that is about the ROOM, differing only in `mine`.
      expect(forBen.mainCommit).toBe(forAna.mainCommit);
      expect(forBen.branches.map((b) => b.slug)).toEqual(forAna.branches.map((b) => b.slug));
    });
  });

  describe('mergeNoFf', () => {
    it('leaves main exactly as it was when a merge will not go in', async () => {
      // Deliberately reached by hand rather than through the service: the
      // service refuses `BEHIND_MAIN` before a conflict is possible, and this
      // is the guarantee that stands behind that refusal. Two branches editing
      // one file, neither containing the other.
      await enableRepo();
      const repoDir = store.repoPath(ROOM_ID);
      const commit = async (message: string): Promise<void> => {
        await git(['add', '--all'], repoDir);
        await git(
          ['-c', 'user.name=X', '-c', 'user.email=x@dorkos.local', 'commit', '-q', '-m', message],
          repoDir
        );
      };
      await writeFile(path.join(repoDir, 'shared.md'), 'base\n', 'utf-8');
      await commit('base');
      await git(['checkout', '-q', '-b', 'theirs'], repoDir);
      await writeFile(path.join(repoDir, 'shared.md'), 'theirs\n', 'utf-8');
      await commit('theirs');
      await git(['checkout', '-q', 'main'], repoDir);
      await writeFile(path.join(repoDir, 'shared.md'), 'ours\n', 'utf-8');
      await commit('ours');
      const before = await git(['rev-parse', 'HEAD'], repoDir);

      await expect(
        mergeNoFf(
          repoDir,
          'theirs',
          'this will not go in',
          { name: 'X', email: 'x@dorkos.local' },
          store.homeDir(ROOM_ID)
        )
      ).rejects.toThrow(/Could not merge theirs/);

      // The three things that make "main is never left conflicted" true.
      expect(await git(['rev-parse', 'HEAD'], repoDir)).toBe(before);
      expect(await git(['status', '--porcelain=v1'], repoDir)).toBe('');
      expect(await readFile(path.join(repoDir, 'shared.md'), 'utf-8')).toBe('ours\n');
    });
  });

  describe('symlinkLeavesRepo', () => {
    // Every row that reads `true` below and is NOT a plain POSIX escape was a
    // hole first, and each was proven end to end before it was closed: the
    // case-variant `.git` spellings landed on `main` and reached the
    // server-owned `repo/`, where `.git` is a real directory and `.git/config`
    // is the common directory shared by every worktree of the room; the
    // Windows-absolute and UNC targets were allowed because the absolute test
    // ran on the RAW string, before backslashes became slashes.
    it.each([
      // Plain POSIX escapes — the cases that always worked.
      ['/etc/passwd', 'notes/link', true],
      ['C:\\Windows\\system32', 'link', true],
      ['../../../etc/passwd', 'notes/link', true],
      ['../secrets', 'link', true],
      ['.git/config', 'link', true],
      ['../.git/hooks/pre-commit', 'notes/link', true],
      // Separator-ordering holes: normalize first, then test.
      ['\\etc\\passwd', 'link', true],
      ['\\\\server\\share\\x', 'link', true],
      ['..\\..\\etc\\passwd', 'notes/link', true],
      ['c:/Windows/system32', 'link', true],
      // Case-insensitive filesystems open all of these as `.git`.
      ['.GIT/config', 'link', true],
      ['.Git/hooks/pre-commit', 'link', true],
      ['.gIt', 'link', true],
      ['../.GIT/config', 'notes/link', true],
      ['.GIT', 'link', true],
      // NTFS's other two doors to the same directory.
      ['.git./config', 'link', true],
      ['git~1/config', 'link', true],
      ['GIT~1/hooks/pre-commit', 'link', true],
      // And the things that are genuinely fine, including names that merely
      // START with the forbidden ones — `.gitignore` is a file, not a door.
      ['real.md', 'link', false],
      ['../shared/real.md', 'notes/link', false],
      ['./real.md', 'notes/link', false],
      ['.gitignore', 'link', false],
      ['.github/workflows/ci.yml', 'link', false],
      ['gitlab/config', 'link', false],
    ])('%s at %s escapes: %s', (target, at, escapes) => {
      expect(symlinkLeavesRepo(at, target)).toBe(escapes);
    });
  });
});
