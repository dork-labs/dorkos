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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
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
import { ROOM_MD_FILENAME } from '../room-md.js';
import { commitAll, runGit } from '../room-repo-git.js';

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
  let dorkHome: string;
  let store: RoomRepoStore;
  let service: RoomRepoService;
  let enabled: boolean;
  let visible: boolean;
  let operatorName: string | null;

  beforeEach(async () => {
    db = createTestDb();
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-room-repo-svc-'));
    store = new RoomRepoStore(db, dorkHome);
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
      enabled: () => enabled,
      getRoom: () => (visible ? ROOM : null),
      isOwnerAuthor: (authorId) => authorId === OPERATOR,
      operatorGitName: () => operatorName,
      caps: () => ({ ...ROOM_REPO_CAP_DEFAULTS }),
    });
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
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
      expect(await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)).toBe('main');
      expect(await runGit(['log', '--format=%an <%ae>%n%s'], repoDir)).toContain(
        'Dorian <operator@dorkos.local>'
      );
      // ROOM.md is committed, not merely written: a file left untracked would
      // vanish the first time an agent's worktree was created from main.
      expect(await runGit(['ls-files'], repoDir)).toBe(ROOM_MD_FILENAME);

      const body = await readFile(path.join(repoDir, ROOM_MD_FILENAME), 'utf-8');
      expect(body).toContain('# Release train');
      expect(body).toContain('Shipping 0.70');
      expect(body).toContain('never a replacement');
    });

    it('writes the sidecar outside the repo, where the repo cannot rewrite it', async () => {
      await service.enable(ROOM_ID, OPERATOR);
      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);
      expect(await runGit(['ls-files'], store.repoPath(ROOM_ID))).not.toContain('room-repo.json');
      expect(store.getRow(ROOM_ID)).toMatchObject({ roomId: ROOM_ID, mode: 'owned' });
    });

    it('falls back to a plain name when this install has no name for the operator', async () => {
      operatorName = null;
      await service.enable(ROOM_ID, OPERATOR);
      expect(await runGit(['log', '--format=%an'], store.repoPath(ROOM_ID))).toBe(
        'DorkOS operator'
      );
    });

    it('is idempotent: the second call changes nothing and answers the binding it found', async () => {
      const first = await service.enable(ROOM_ID, OPERATOR);
      const head = await runGit(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID));

      const second = await service.enable(ROOM_ID, OPERATOR);

      expect(second.created).toBe(false);
      expect(second.repo).toEqual(first.repo);
      expect(await runGit(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID))).toBe(head);
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
      await runGit(
        ['worktree', 'add', '-b', `room/${agent}`, dir, 'main'],
        store.repoPath(ROOM_ID)
      );
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
      await commitAll(dir, 'work', { name: 'Bo', email: 'bo@dorkos.local' });

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
      await service.enable(ROOM_ID, OPERATOR);
      await mkdir(path.join(store.worktreesPath(ROOM_ID), 'mystery'), { recursive: true });
      await writeFile(
        path.join(store.worktreesPath(ROOM_ID), 'mystery', 'notes.md'),
        'not a checkout',
        'utf-8'
      );

      await expect(service.listStrandedWorktrees(ROOM_ID)).resolves.toEqual(['mystery']);
    });
  });

  describe('archiving', () => {
    it('is nothing at all — an archived room keeps its files', async () => {
      // Archiving is a `rooms.archived` flip and nothing else; this pins that
      // the repo domain has no hook on it. The service exposes no archive
      // method BY DESIGN, so the assertion is that the files survive the flip.
      await service.enable(ROOM_ID, OPERATOR);
      const head = await runGit(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID));

      db.update(rooms).set({ archived: true }).run();

      expect(existsSync(store.sidecarPath(ROOM_ID))).toBe(true);
      expect(await runGit(['rev-parse', 'HEAD'], store.repoPath(ROOM_ID))).toBe(head);
      expect(store.getRow(ROOM_ID)).not.toBeNull();
      expect(service.hasRepo(ROOM_ID)).toBe(true);
    });
  });
});
