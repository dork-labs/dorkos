/**
 * Giving a room files, and refusing to take them away (spec `project-rooms`
 * §3.2).
 *
 * Real git, on a real temporary DorkOS home. Nothing here is mocked below the
 * service's own seams, because every claim under test is about what is on disk
 * afterwards: a repo whose branch is `main`, a `ROOM.md` in its first commit,
 * and a worktree the delete guard will not throw away.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Dropping the operator gate turns "refuses an agent" green-to-red.
 * - Dropping the `-b main` from `initRepo` reddens "the branch is main".
 * - Returning `created: true` unconditionally reddens the idempotence test.
 * - Making `assertHomeRemovable` count only uncommitted changes reddens
 *   "refuses while a worktree is ahead of main"; counting only ahead-ness
 *   reddens "refuses while a worktree is dirty".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import type { Room } from '@dorkos/shared/room-schemas';
import { ROOM_REPO_CAP_DEFAULTS } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoService } from '../room-repo-service.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { ROOM_MD_FILENAME } from '../room-md.js';
import { commitAll, commitsAheadOfMain, hasUncommittedChanges, runGit } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = 'author-operator';
const AGENT = 'author-agent';

/** The room the service is told about. */
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

describe('RoomRepoService', () => {
  let db: Db;
  let scratch: string;
  let dorkHome: string;
  let store: RoomRepoStore;
  let service: RoomRepoService;
  let enabled: boolean;
  let visible: boolean;
  let operatorName: string | null;
  /** The queue enable shares with merges — one instance, so a race is a real race. */
  let mutex: RoomRepoMutex;

  /** Run git in `dir` with the room's home as the discovery ceiling. */
  function git(args: string[], dir: string): Promise<string> {
    return runGit(args, dir, store.homeDir(ROOM_ID));
  }

  beforeEach(async () => {
    db = createTestDb();
    // Before any repo exists — including the ones `enable` makes itself: a
    // `git commit` otherwise leaves a DETACHED maintenance process writing into
    // `.git` after it returns, and this suite's teardown deletes that
    // directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    // **The DorkOS home sits INSIDE a git repository, deliberately.** That is
    // the dev layout — `apps/server/.temp/.dork/` lives in the dorkos checkout —
    // and it is what makes the stranded-work tests discriminate: without a
    // discovery ceiling, git run in a room worktree walks up to THIS repo and
    // answers for it. The enclosing repo ignores everything and has a commit,
    // so it reads clean and zero-ahead: exactly the answers that would make the
    // delete guard call somebody's unmerged work disposable.
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-repo-svc-'));
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
    dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    store = new RoomRepoStore(db, dorkHome);
    mutex = new RoomRepoMutex();
    enabled = true;
    visible = true;
    operatorName = 'Dorian';
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
    service = new RoomRepoService({
      store,
      mutex,
      queueWaitMs: () => 5000,
      enabled: () => enabled,
      getRoom: () => (visible ? ROOM : null),
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => operatorName,
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await removeFixtureTree(scratch);
  });

  /** Assert a thrown value is a {@link RoomError} with this code. */
  async function expectRoomError(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toThrow(RoomError);
    await expect(promise).rejects.toMatchObject({ code });
  }

  describe('enable', () => {
    it('makes a repo on main with ROOM.md in its first commit, authored as the operator', async () => {
      const result = await service.enable(ROOM_ID, OPERATOR);

      expect(result.created).toBe(true);
      expect(result.repo).toMatchObject({
        roomId: ROOM_ID,
        mode: 'owned',
        defaultBranch: 'main',
        createdBy: OPERATOR,
        lastMergeSeq: null,
      });
      expect(result.repo.caps).toEqual(ROOM_REPO_CAP_DEFAULTS);

      const repoDir = store.repoPath(ROOM_ID);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).toBe('main');
      expect(await git(['log', '--format=%an <%ae>%n%s'], repoDir)).toContain(
        'Dorian <operator@dorkos.local>'
      );
      // ROOM.md is committed, not merely written: a file left untracked would
      // vanish the first time an agent's worktree was created from main.
      expect(await git(['ls-files'], repoDir)).toBe(ROOM_MD_FILENAME);

      const body = await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8');
      expect(body).toContain('# Release train');
      expect(body).toContain('Shipping 0.70');
      expect(body).toContain('never a replacement');
    });

    it('writes the sidecar outside the repo, where the repo cannot rewrite it', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);
      expect(await git(['ls-files'], store.repoPath(ROOM_ID))).not.toContain('room-repo.json');
      expect(store.getRow(ROOM_ID)).toMatchObject({ roomId: ROOM_ID, mode: 'owned' });
    });

    it('falls back to a plain name when this install has no name for the operator', async () => {
      operatorName = null;
      await service.enable(ROOM_ID, OPERATOR);
      expect(await git(['log', '--format=%an'], store.repoPath(ROOM_ID))).toBe('DorkOS operator');
    });

    it('is idempotent: the second call changes nothing and answers the binding it found', async () => {
      const first = await service.enable(ROOM_ID, OPERATOR);
      const head = await git(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID));

      const second = await service.enable(ROOM_ID, OPERATOR);

      expect(second.created).toBe(false);
      expect(second.repo).toEqual(first.repo);
      expect(await git(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID))).toBe(head);
    });

    it('survives two enables of one room arriving together, with the repo intact', async () => {
      // **The TOCTOU this method's queue exists for** (DOR-1598). Enable is a
      // check-then-act with an `await` in the middle: read the sidecar, decide
      // there is no repo, create one. Started in ONE tick, both calls used to
      // read "no repo" and both ran `git init -b main` in the same directory —
      // and `git init` on a repository that already exists RE-INITIALISES it,
      // exits 0, and takes its seed commit with it. Measured before the queue
      // existed: two `created: true` answers and a repo with no `ROOM.md`.
      const [first, second] = await Promise.all([
        service.enable(ROOM_ID, OPERATOR),
        service.enable(ROOM_ID, OPERATOR),
      ]);

      // Exactly one call made it; the other found the binding the first wrote.
      const created = [first, second].filter((result) => result.created);
      expect(created).toHaveLength(1);
      const found = [first, second].filter((result) => !result.created);
      expect(found).toHaveLength(1);
      // A 409 has to be able to hand back a binding, so the loser carries one.
      expect(found[0]?.repo.roomId).toBe(ROOM_ID);
      expect(found[0]?.repo).toEqual(created[0]?.repo);

      // And the repo is a real one, with its seed commit still in it.
      const repoDir = store.repoPath(ROOM_ID);
      expect(await git(['rev-list', '--count', 'HEAD'], repoDir)).toBe('1');
      expect(await git(['ls-files'], repoDir)).toBe(ROOM_MD_FILENAME);
    });

    it('rebuilds a cache row the second call finds missing', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      store.removeRow(ROOM_ID);

      const again = await service.enable(ROOM_ID, OPERATOR);

      expect(again.created).toBe(false);
      expect(store.getRow(ROOM_ID)).not.toBeNull();
    });

    it('refuses an agent, and leaves nothing behind', async () => {
      await expectRoomError(service.enable(ROOM_ID, AGENT), 'OPERATOR_ONLY');
      expect(existsSync(store.homeDir(ROOM_ID))).toBe(false);
      expect(store.getRow(ROOM_ID)).toBeNull();
    });

    it('answers a room the caller cannot see the same way reading it would', async () => {
      visible = false;
      await expectRoomError(service.enable(ROOM_ID, OPERATOR), 'ROOM_NOT_FOUND');
    });

    it('checks visibility before the operator gate, so probing tells nothing apart', async () => {
      visible = false;
      // Same 404 for an agent as for the operator: an agent walking room ids
      // must not be able to separate "exists, not yours" from "no such room".
      await expectRoomError(service.enable(ROOM_ID, AGENT), 'ROOM_NOT_FOUND');
    });

    it('refuses while the feature is switched off, and touches nothing', async () => {
      enabled = false;
      await expectRoomError(service.enable(ROOM_ID, OPERATOR), 'ROOM_REPOS_DISABLED');
      expect(existsSync(store.homeDir(ROOM_ID))).toBe(false);
    });

    it('unwinds the binding when the git half fails', async () => {
      // A file where the repo directory needs to be: `git init` cannot run, and
      // a sidecar advertising a repo that does not exist must not survive it.
      await mkdir(store.homeDir(ROOM_ID), { recursive: true });
      await writeFile(store.repoPath(ROOM_ID), 'in the way', 'utf-8');

      await expect(service.enable(ROOM_ID, OPERATOR)).rejects.toThrow();

      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(false);
      expect(store.getRow(ROOM_ID)).toBeNull();
    });

    it('retracts the binding even when the directory cannot be cleaned up', async () => {
      // The unwind order, stated as a test. Removing `repo/` first meant a
      // failing `fs.rm` — a locked file, a permission the server has lost —
      // threw out of the shared try and left the SIDECAR standing: a room
      // advertising files it does not have, with no path back. The binding is
      // what every other path believes, so it is retracted first and each step
      // gets its own try.
      await mkdir(store.homeDir(ROOM_ID), { recursive: true });
      await writeFile(store.repoPath(ROOM_ID), 'in the way', 'utf-8');
      const realRm = fsp.rm.bind(fsp);
      vi.spyOn(fsp, 'rm').mockImplementation(async (target, options) => {
        if (String(target) === store.repoPath(ROOM_ID)) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        await realRm(target, options);
      });

      await expect(service.enable(ROOM_ID, OPERATOR)).rejects.toThrow();

      // The cleanup failed, and the binding is still gone.
      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(false);
      expect(store.getRow(ROOM_ID)).toBeNull();
      expect(service.hasRepo(ROOM_ID)).toBe(false);
    });

    it('finishes an enable that was killed between the sidecar and the repo', async () => {
      // The write order is sidecar-then-git, so a process killed between them
      // leaves a room that reports having files and has none. Answering
      // `created: false` forever would make that permanent, with no way back
      // except deleting the sidecar by hand.
      await service.enable(ROOM_ID, OPERATOR);
      await rm(store.repoPath(ROOM_ID), { recursive: true, force: true });
      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);

      const healed = await service.enable(ROOM_ID, OPERATOR);

      expect(healed.created).toBe(true);
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], store.repoPath(ROOM_ID))).toBe(
        'main'
      );
      expect(await git(['ls-files'], store.repoPath(ROOM_ID))).toBe(ROOM_MD_FILENAME);
      // The original binding is kept — its `createdAt` and `caps` are what the
      // repo was granted under, and healing is not a re-grant.
      expect(healed.repo.createdAt).toBe((await store.readSidecar(ROOM_ID))?.createdAt);
    });

    it('says so plainly when this machine has no git', async () => {
      // A real ENOENT from the real spawn: git is looked up on PATH, so an
      // empty PATH is a machine without it. Not a 500 — nothing is broken, a
      // program is missing, and the message names it.
      //
      // `vi.stubEnv` rather than assigning `process.env.PATH`, so the override
      // is unwound by vitest even if an assertion throws — an escaped empty
      // PATH would break every later test in this worker that spawns anything.
      vi.stubEnv('PATH', '');
      try {
        await expectRoomError(service.enable(ROOM_ID, OPERATOR), 'ROOM_REPO_GIT_UNAVAILABLE');
        await expect(service.enable(ROOM_ID, OPERATOR)).rejects.toThrow(/git installed/);
      } finally {
        vi.unstubAllEnvs();
      }
      // And it unwound: no binding is left claiming files that were never made.
      expect(store.getRow(ROOM_ID)).toBeNull();
      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(false);
    });
  });

  describe('hasRepo', () => {
    it('is false for a room with no repo, true once it has one', async () => {
      expect(service.hasRepo(ROOM_ID)).toBe(false);
      await service.enable(ROOM_ID, OPERATOR);
      expect(service.hasRepo(ROOM_ID)).toBe(true);
    });

    it('is false for every room while the feature is off, without deleting anything', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      enabled = false;
      expect(service.hasRepo(ROOM_ID)).toBe(false);
      // Off is not gone: the files are exactly where they were.
      expect(existsSync(store.repoPath(ROOM_ID))).toBe(true);
    });
  });

  describe('the delete guard', () => {
    /** Add a standing worktree for `agent`, the way task 2.1 will. */
    async function addWorktree(agent: string): Promise<string> {
      const dir = path.join(store.worktreesPath(ROOM_ID), agent);
      await git(['worktree', 'add', '-b', `room/${agent}`, dir, 'main'], store.repoPath(ROOM_ID));
      return dir;
    }

    it('allows a delete when every worktree is clean and merged', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      await addWorktree('ana');

      await expect(service.listStrandedWorktrees(ROOM_ID)).resolves.toEqual([]);
      await expect(service.assertHomeRemovable(ROOM_ID)).resolves.toBeUndefined();
    });

    it('allows a delete for a room that never had a repo', async () => {
      await expect(service.assertHomeRemovable(ROOM_ID)).resolves.toBeUndefined();
    });

    it('refuses while a worktree holds uncommitted work, and names it', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await addWorktree('ana');
      await writeFile(path.join(dir, 'draft.md'), 'half an idea', 'utf-8');

      await expect(service.listStrandedWorktrees(ROOM_ID)).resolves.toEqual(['ana']);
      await expectRoomError(service.assertHomeRemovable(ROOM_ID), 'ROOM_REPO_UNMERGED_WORK');
      await expect(service.assertHomeRemovable(ROOM_ID)).rejects.toThrow(/ana/);
    });

    it('refuses while a worktree is ahead of main, even though it is clean', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await addWorktree('bo');
      await writeFile(path.join(dir, 'done.md'), 'finished, unmerged', 'utf-8');
      await commitAll(
        dir,
        'work',
        { name: 'Bo', email: 'bo@dorkos.local' },
        store.homeDir(ROOM_ID)
      );

      // Clean by `git status`, and still holding a commit main has never seen.
      await expect(service.listStrandedWorktrees(ROOM_ID)).resolves.toEqual(['bo']);
      await expectRoomError(service.assertHomeRemovable(ROOM_ID), 'ROOM_REPO_UNMERGED_WORK');
    });

    it('lets the operator force past stranded work', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await addWorktree('ana');
      await writeFile(path.join(dir, 'draft.md'), 'half an idea', 'utf-8');

      await expect(service.assertHomeRemovable(ROOM_ID, { force: true })).resolves.toBeUndefined();
      await service.removeHome(ROOM_ID, { force: true });
      expect(existsSync(store.homeDir(ROOM_ID))).toBe(false);
    });

    it('removeHome refuses without force, leaving every file where it was', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      const dir = await addWorktree('ana');
      await writeFile(path.join(dir, 'draft.md'), 'half an idea', 'utf-8');

      await expectRoomError(service.removeHome(ROOM_ID), 'ROOM_REPO_UNMERGED_WORK');
      expect(existsSync(path.join(dir, 'draft.md'))).toBe(true);
      expect(store.getRow(ROOM_ID)).not.toBeNull();
    });

    it('treats a worktree git cannot read as unfinished work rather than as rubbish', async () => {
      // **The discovery-ceiling test, and the fixture is what makes it one.**
      // The DorkOS home in this suite sits inside a git repository that is
      // clean and has a `main` — the dev layout. Git finds a repository by
      // walking UP, so without `GIT_CEILING_DIRECTORIES` this junk directory
      // answers for the ENCLOSING repo: `status` says clean, `main..HEAD` says
      // zero, the guard calls it disposable, and `removeHome` deletes it. With
      // the ceiling, git refuses to leave the room's own home, the read fails,
      // and the conservative handler calls it unfinished work.
      await service.enable(ROOM_ID, OPERATOR);
      await mkdir(path.join(store.worktreesPath(ROOM_ID), 'mystery'), { recursive: true });
      await writeFile(
        path.join(store.worktreesPath(ROOM_ID), 'mystery', 'notes.md'),
        'not a checkout',
        'utf-8'
      );

      // The fixture really is the trap: the enclosing repo reads clean, which
      // is the answer that would have been believed.
      expect(await runGit(['status', '--porcelain=v1'], scratch, scratch)).toBe('');

      await expect(service.listStrandedWorktrees(ROOM_ID)).resolves.toEqual(['mystery']);
      await expectRoomError(service.assertHomeRemovable(ROOM_ID), 'ROOM_REPO_UNMERGED_WORK');
    });

    it('never lets a room worktree read the repository that encloses the data directory', async () => {
      // The same escape, asked directly of the git layer rather than through
      // the guard: a directory that is not a checkout must fail, not inherit an
      // answer from somewhere up the tree.
      await service.enable(ROOM_ID, OPERATOR);
      const outside = path.join(store.worktreesPath(ROOM_ID), 'notarepo');
      await mkdir(outside, { recursive: true });

      await expect(hasUncommittedChanges(outside, store.homeDir(ROOM_ID))).rejects.toThrow(
        /not a git repository/
      );
      // And `commitsAheadOfMain` no longer answers 0 for a tree it cannot read:
      // "merged" and "unreadable" were the same answer, and only one of them is
      // safe to delete.
      await expect(commitsAheadOfMain(outside, store.homeDir(ROOM_ID))).rejects.toThrow(
        /not a git repository/
      );
    });

    it('answers zero ahead for a real repo that has no main yet', async () => {
      // The one case that legitimately answers 0, established by a probe rather
      // than inferred from a failure — which is what let every other failure
      // read as "merged".
      const bare = path.join(store.worktreesPath(ROOM_ID), 'fresh');
      await mkdir(bare, { recursive: true });
      await runGit(['-c', 'init.templateDir=', 'init', '-b', 'other', '--quiet', '.'], bare, bare);

      await expect(commitsAheadOfMain(bare, store.homeDir(ROOM_ID))).resolves.toBe(0);
    });
  });

  describe('archiving', () => {
    it('is nothing at all — an archived room keeps its files', async () => {
      // Archiving is a `rooms.archived` flip and nothing else; this pins that
      // the repo domain has no hook on it. The service exposes no archive
      // method BY DESIGN, so the assertion is that the files survive the flip.
      await service.enable(ROOM_ID, OPERATOR);
      const head = await git(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID));

      db.update(rooms).set({ archived: true }).run();

      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);
      expect(await git(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID))).toBe(head);
      expect(store.getRow(ROOM_ID)).not.toBeNull();
      expect(service.hasRepo(ROOM_ID)).toBe(true);
    });
  });
  describe('repairMainCheckout', () => {
    /** Enable the room's files and hand back its checkout. */
    async function withFiles(): Promise<string> {
      await service.enable(ROOM_ID, OPERATOR);
      return store.repoPath(ROOM_ID);
    }

    it('keeps changes somebody made outside DorkOS, as one commit by the operator', async () => {
      const repoDir = await withFiles();
      const before = await git(['rev-parse', 'HEAD'], repoDir);
      // A person with a terminal: one file edited, one file added.
      await writeFile(path.join(repoDir, ROOM_MD_FILENAME), '# edited by hand\n', 'utf-8');
      await writeFile(path.join(repoDir, 'notes.md'), 'jotted down\n', 'utf-8');

      const result = await service.repairMainCheckout(ROOM_ID, OPERATOR, { action: 'commit' });

      expect(result).toMatchObject({ action: 'commit', paths: 2, clean: true });
      expect(result.commit).not.toBe(before);
      expect(await git(['status', '--porcelain=v1'], repoDir)).toBe('');
      expect(await git(['log', '--format=%an%n%s', '-n', '1'], repoDir)).toBe(
        'Dorian\nKeep changes made outside DorkOS'
      );
      // Both files are in it, which is the whole point of not asking for a list.
      expect(await git(['show', '--name-only', '--format=', 'HEAD'], repoDir)).toContain(
        'notes.md'
      );
    });

    it('discards exactly the files it was handed, and nothing else', async () => {
      const repoDir = await withFiles();
      const before = await git(['rev-parse', 'HEAD'], repoDir);
      const original = await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8');
      await writeFile(path.join(repoDir, ROOM_MD_FILENAME), '# edited by hand\n', 'utf-8');
      await writeFile(path.join(repoDir, 'keep.md'), 'still wanted\n', 'utf-8');
      await writeFile(path.join(repoDir, 'throw-away.md'), 'not wanted\n', 'utf-8');

      const result = await service.repairMainCheckout(ROOM_ID, OPERATOR, {
        action: 'discard',
        paths: [ROOM_MD_FILENAME, 'throw-away.md'],
      });

      // A tracked file goes back to what the commit has; an untracked one is
      // removed. The file nobody named is untouched — so the room is still
      // dirty, and the answer says so rather than implying merges resumed.
      expect(result).toMatchObject({ action: 'discard', commit: null, paths: 2, clean: false });
      expect(await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8')).toBe(original);
      expect(existsSync(path.join(repoDir, 'throw-away.md'))).toBe(false);
      expect(existsSync(path.join(repoDir, 'keep.md'))).toBe(true);
      expect(await git(['rev-parse', 'HEAD'], repoDir)).toBe(before);
    });

    it('undoes a rename whole, rather than deleting the file it renamed', async () => {
      // Found in review: a rename is one stray with TWO paths, and a discard
      // that knew only the new one deleted the file from the room and left the
      // old name still missing — destroying work while claiming to undo it.
      const repoDir = await withFiles();
      const before = await git(['rev-parse', 'HEAD'], repoDir);
      const original = await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8');
      await git(['mv', ROOM_MD_FILENAME, 'renamed.md'], repoDir);

      // Whatever the room reports is what the operator can name, so discarding
      // "everything on the list" is the case to prove.
      const listed = await service.repairMainCheckout(ROOM_ID, OPERATOR, {
        action: 'discard',
        paths: ['renamed.md'],
      });

      expect(listed).toMatchObject({ action: 'discard', paths: 1, clean: true });
      expect(await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8')).toBe(original);
      expect(existsSync(path.join(repoDir, 'renamed.md'))).toBe(false);
      expect(await git(['status', '--porcelain=v1'], repoDir)).toBe('');
      expect(await git(['rev-parse', 'HEAD'], repoDir)).toBe(before);
    });

    it('refuses a path the room is not reporting as changed', async () => {
      const repoDir = await withFiles();
      await writeFile(path.join(repoDir, 'notes.md'), 'jotted down\n', 'utf-8');

      // The stale-screen case, and the invented-path case, are the same case:
      // if it is not on the list right now, it is not discarded.
      await expectRoomError(
        service.repairMainCheckout(ROOM_ID, OPERATOR, {
          action: 'discard',
          paths: ['notes.md', ROOM_MD_FILENAME],
        }),
        'ROOM_FILE_NOT_FOUND'
      );
      // And nothing was discarded — the refusal comes before any of it runs.
      expect(existsSync(path.join(repoDir, 'notes.md'))).toBe(true);
    });

    it('refuses everybody but the operator, and answers 404 for a room they cannot see', async () => {
      await withFiles();

      await expectRoomError(
        service.repairMainCheckout(ROOM_ID, AGENT, { action: 'commit' }),
        'OPERATOR_ONLY'
      );
      visible = false;
      await expectRoomError(
        service.repairMainCheckout(ROOM_ID, AGENT, { action: 'commit' }),
        'ROOM_NOT_FOUND'
      );
    });

    it('refuses to move a branch somebody else checked out', async () => {
      const repoDir = await withFiles();
      await git(['checkout', '-q', '-b', 'somebody-elses-work'], repoDir);

      await expectRoomError(
        service.repairMainCheckout(ROOM_ID, OPERATOR, { action: 'commit' }),
        'MAIN_CHECKOUT_DIRTY'
      );
      // Still where they left it: DorkOS does not check out over work it did
      // not put there.
      expect(await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).toBe('somebody-elses-work');
    });

    it('is a no-op on a room whose files are already clean', async () => {
      const repoDir = await withFiles();
      const before = await git(['rev-parse', 'HEAD'], repoDir);

      const result = await service.repairMainCheckout(ROOM_ID, OPERATOR, { action: 'commit' });

      expect(result).toEqual({ action: 'commit', commit: null, paths: 0, clean: true });
      expect(await git(['rev-parse', 'HEAD'], repoDir)).toBe(before);
    });

    it('refuses a room with no files of its own', async () => {
      await expectRoomError(
        service.repairMainCheckout(ROOM_ID, OPERATOR, { action: 'commit' }),
        'ROOM_HAS_NO_REPO'
      );
    });
  });
});
