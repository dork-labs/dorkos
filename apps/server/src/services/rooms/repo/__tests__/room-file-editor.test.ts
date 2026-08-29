/**
 * A person saving a file into a room's `main` (spec `project-rooms` §3.10).
 *
 * Real git, on a real temporary DorkOS home, through the module's own hardened
 * runner. Nothing below the service's seams is mocked, because every claim
 * under test is about what is on disk and in the history afterwards: whether a
 * commit was made, who it is authored by, whether the working tree was left
 * clean, and — for half of this file — whether a hostile path or a hidden
 * symlink got out of the room.
 *
 * **The fixture home sits inside an enclosing git repository on purpose**, the
 * same way `room-files.test.ts`'s does: it mirrors the dev layout, and it is
 * what makes a missing discovery ceiling fail loudly instead of quietly
 * answering for the wrong repository.
 *
 * Seeded defects, each run and each red before the code stood:
 *
 * - Comparing `baseCommit` against `main`'s tip instead of comparing the PATH
 *   reddens "a merge somewhere else does not stop a save".
 * - Dropping the path comparison altogether (always saving) reddens the
 *   conflict tests, which then overwrite somebody's edit.
 * - Dropping the writable-path check reddens every `.git` spelling — and the
 *   `.GIT` one in particular, which a case-blind check lets through onto APFS.
 * - Dropping the on-disk lstat walk reddens "a hidden symlink is not a door":
 *   the save lands outside the room.
 * - Dropping the dirty-main gate reddens "refuses while somebody else has been
 *   writing here", and the save mixes a stranger's edit into its own commit.
 * - Removing the rollback reddens "a failed commit leaves the room's files
 *   clean", which then wedges every merge in the room.
 * - Committing unconditionally reddens "saving an unchanged file commits
 *   nothing".
 * - Dropping `:(literal)` from `stagePaths` reddens "stages the file it was
 *   handed": `ax.md` is swept into a save of `[a]x.md`.
 * - Dropping the `mode` half of the lock's comparison reddens "treats a file
 *   somebody made executable as a change".
 * - Running the path checks before the lock reddens "answers a stale save with
 *   the choice, even when the folder itself has gone".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS, type RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomFilesService } from '../room-files.js';
import { RoomFileEditor, type RoomFileSaveOutcome } from '../room-file-editor.js';
import { commitAll, runGit, stagePaths } from '../room-repo-git.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = 'author-operator';

describe('RoomFileEditor', () => {
  let db: Db;
  let scratch: string;
  let dorkHome: string;
  let store: RoomRepoStore;
  let editor: RoomFileEditor;
  let repoDir: string;
  let mutex: RoomRepoMutex;
  let caps: RoomRepoCaps;
  let operatorName: string | null;
  let queueWaitMs: number;
  /** What the room's own write gate answers; a route test drives the real one. */
  let writeRefusal: RoomError | null;

  /** Run git in the room's repo, with the room's home as the ceiling. */
  function git(args: string[], dir = repoDir): Promise<string> {
    return runGit(args, dir, store.homeDir(ROOM_ID));
  }

  /** Write a file into the room's repo, creating its directory. */
  async function put(relPath: string, body: string): Promise<void> {
    const target = path.join(repoDir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf-8');
  }

  /** Commit everything in the room's repo under `who`. */
  async function commit(message: string, who = 'Ana'): Promise<string> {
    return commitAll(repoDir, message, { name: who, email: 'who@dorkos.local' }, dorkHomeOf());
  }

  /** The room's home, which is git's discovery ceiling for every call here. */
  function dorkHomeOf(): string {
    return store.homeDir(ROOM_ID);
  }

  /** What `main` points at right now. */
  function head(): Promise<string> {
    return git(['rev-parse', 'HEAD']);
  }

  /** Save, and fail the test if it came back a conflict. */
  async function save(
    input: { path: string; baseCommit: string | null; text: string },
    caller = OPERATOR
  ): Promise<Extract<RoomFileSaveOutcome, { status: 'saved' }>['result']> {
    const outcome = await editor.save(ROOM_ID, caller, input);
    if (outcome.status !== 'saved') throw new Error(`expected a save, got ${outcome.status}`);
    return outcome.result;
  }

  /** Assert a thrown value is a {@link RoomError} with this code. */
  async function expectRoomError(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toThrow(RoomError);
    await expect(promise).rejects.toMatchObject({ code });
  }

  beforeEach(async () => {
    db = createTestDb();
    silenceGitAutoMaintenance();
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-file-editor-'));
    // The enclosing repository — see the module doc.
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
    db.insert(rooms)
      .values({
        id: ROOM_ID,
        kind: 'channel',
        title: 'Release train',
        createdAt: '2026-08-27T12:00:00.000Z',
        lastActivityAt: '2026-08-27T12:00:00.000Z',
      })
      .run();

    caps = { ...ROOM_REPO_CAP_DEFAULTS };
    operatorName = 'Dorian';
    queueWaitMs = 5000;
    writeRefusal = null;
    mutex = new RoomRepoMutex();

    repoDir = store.repoPath(ROOM_ID);
    await mkdir(repoDir, { recursive: true });
    await git(['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.']);
    await store.write({
      roomId: ROOM_ID,
      mode: 'owned',
      createdAt: '2026-08-27T12:00:00.000Z',
      createdBy: OPERATOR,
      defaultBranch: 'main',
      caps,
      lastMergeSeq: null,
    });
    await put('ROOM.md', '# Release train\n');
    await put('docs/plan.md', '# Plan\n');
    await commit('Start this room’s files', 'Dorian');

    const files = new RoomFilesService({
      store,
      hasRepo: () => true,
      maxFileBytes: () => caps.maxFileBytes,
    });
    editor = new RoomFileEditor({
      store,
      mutex,
      enabled: () => true,
      queueWaitMs: () => queueWaitMs,
      assertCanWriteFiles: () => {
        if (writeRefusal) throw writeRefusal;
      },
      operatorGitName: () => operatorName,
      files,
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await removeFixtureTree(scratch);
  });

  describe('saving', () => {
    it('writes one commit, authored as the person, and leaves the tree clean', async () => {
      const before = await head();

      const result = await save({
        path: 'ROOM.md',
        baseCommit: before,
        text: '# Release train\n\nWe ship on Thursdays.\n',
      });

      expect(result.committed).toBe(true);
      expect(result.commit).not.toBe(before);
      expect(result.size).toBe(Buffer.byteLength('# Release train\n\nWe ship on Thursdays.\n'));
      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toContain(
        'We ship on Thursdays.'
      );
      // One commit, not two, and authored as the person — the whole of "the
      // server commits as the user".
      expect(await git(['log', '--format=%an <%ae>%n%s', '-n', '1'])).toBe(
        'Dorian <operator@dorkos.local>\nEdit ROOM.md'
      );
      expect(await git(['rev-list', '--count', `${before}..HEAD`])).toBe('1');
      // Nothing left behind: a dirty tree stops every merge in the room.
      expect(await git(['status', '--porcelain=v1'])).toBe('');
      expect(result.lastCommit).toMatchObject({ author: 'Dorian', subject: 'Edit ROOM.md' });
    });

    it('creates a file the room did not have, in a folder it does', async () => {
      const result = await save({
        path: 'docs/decisions.md',
        baseCommit: null,
        text: 'We decided.\n',
      });

      expect(result.committed).toBe(true);
      expect(await git(['log', '--format=%s', '-n', '1'])).toBe('Add docs/decisions.md');
      expect(await git(['ls-files'])).toContain('docs/decisions.md');
    });

    it('commits nothing when the text is what the file already held', async () => {
      const before = await head();

      const result = await save({ path: 'ROOM.md', baseCommit: before, text: '# Release train\n' });

      // A person pressing save on an unchanged file is not an error and is not
      // history either.
      expect(result.committed).toBe(false);
      expect(result.commit).toBe(before);
      expect(await head()).toBe(before);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('falls back to a plain name when the install has no name for the person', async () => {
      operatorName = null;

      await save({ path: 'ROOM.md', baseCommit: await head(), text: 'renamed\n' });

      expect(await git(['log', '--format=%an', '-n', '1'])).toBe('DorkOS operator');
    });
  });

  describe('the optimistic lock', () => {
    it('saves even though main moved, when the move was somewhere else', async () => {
      const opened = await head();
      // Somebody merges work that touches another file entirely — which is what
      // `main` moving normally means in a busy room.
      await put('docs/plan.md', '# Plan\n\nStep one.\n');
      await commit('Add a step');
      expect(await head()).not.toBe(opened);

      const result = await save({ path: 'ROOM.md', baseCommit: opened, text: 'still mine\n' });

      expect(result.committed).toBe(true);
      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toBe('still mine\n');
    });

    it('refuses, and writes nothing, when the file itself changed underneath', async () => {
      const opened = await head();
      await put('ROOM.md', '# Release train\n\nAna got here first.\n');
      const theirs = await commit('Ana edits the room notes');

      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: 'ROOM.md',
        baseCommit: opened,
        text: 'mine, which would have destroyed theirs\n',
      });

      expect(outcome.status).toBe('conflict');
      if (outcome.status !== 'conflict') throw new Error('unreachable');
      expect(outcome.conflict).toMatchObject({ path: 'ROOM.md', commit: theirs });
      expect(outcome.conflict.lastCommit).toMatchObject({
        author: 'Ana',
        subject: 'Ana edits the room notes',
      });
      // The other person's work is still there, and nothing was committed.
      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toContain('Ana got here');
      expect(await head()).toBe(theirs);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses to create a file somebody else created first', async () => {
      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: 'docs/plan.md',
        baseCommit: null,
        text: 'mine\n',
      });

      expect(outcome.status).toBe('conflict');
      expect(await readFile(path.join(repoDir, 'docs/plan.md'), 'utf-8')).toBe('# Plan\n');
    });

    it('refuses a base commit this room’s files do not have', async () => {
      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: 'ROOM.md',
        // Well-formed and utterly unrelated: a sha from somewhere else, or from
        // a repo this room used to have.
        baseCommit: '0123456789abcdef0123456789abcdef01234567',
        text: 'overwrite\n',
      });

      expect(outcome.status).toBe('conflict');
      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toBe('# Release train\n');
    });
  });

  describe('dirty main', () => {
    it('refuses while somebody outside DorkOS has been writing here', async () => {
      const opened = await head();
      // A person with a terminal, editing the room's own copy.
      await put('ROOM.md', '# edited in a terminal\n');

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'docs/plan.md', baseCommit: opened, text: 'x\n' }),
        'MAIN_CHECKOUT_DIRTY'
      );

      // Their edit is untouched, and nothing of the save landed.
      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toBe(
        '# edited in a terminal\n'
      );
      expect(await head()).toBe(opened);
    });

    it('refuses when the room’s copy is not on main at all', async () => {
      const opened = await head();
      await git(['checkout', '-q', '-b', 'somewhere-else']);

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: opened, text: 'x\n' }),
        'MAIN_CHECKOUT_DIRTY'
      );
    });
  });

  describe('paths a save must not take', () => {
    it('refuses a path that could mean somewhere else', async () => {
      for (const bad of [
        '../escape.md',
        '/etc/passwd',
        'docs\\..\\..\\x',
        'docs//plan.md',
        // Pathspec magic. Every other command here wraps a path in
        // `:(literal)`, which disarms it — but `check-ignore` refuses that
        // wrapper, so `:!x.md` reached git as magic, exited 128, and answered a
        // bare 500 that any member could trigger (found in review).
        ':!x.md',
        ':(exclude)x.md',
        ':/x.md',
      ]) {
        await expectRoomError(
          editor.save(ROOM_ID, OPERATOR, { path: bad, baseCommit: null, text: 'x\n' }),
          'ROOM_FILE_PATH_INVALID'
        );
      }
    });

    it('refuses every spelling of the room’s own git directory', async () => {
      // `.GIT` and `.Git` are the ones a case-blind check lets through: on APFS
      // and NTFS they open exactly the files `.git` opens, and in this checkout
      // `.git/config` is the common directory every worktree of the room
      // shares while `hooks/` is code the next git command would run.
      const doors = [
        '.git/config',
        '.GIT/config',
        '.Git/hooks/pre-commit',
        '.git./config',
        'git~1/config',
        'docs/.git/config',
      ];
      const configBefore = await readFile(path.join(repoDir, '.git/config'), 'utf-8');

      for (const door of doors) {
        await expectRoomError(
          editor.save(ROOM_ID, OPERATOR, { path: door, baseCommit: null, text: 'evil = true\n' }),
          'ROOM_FILE_PATH_INVALID'
        );
      }

      expect(await readFile(path.join(repoDir, '.git/config'), 'utf-8')).toBe(configBefore);
    });

    it('refuses to write through a link that is in the room’s files', async () => {
      await symlink('/etc/passwd', path.join(repoDir, 'secrets'));
      await commit('Add a link');

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'secrets',
          baseCommit: await head(),
          text: 'root::0:0\n',
        }),
        'ROOM_FILE_NOT_READABLE'
      );

      // The link is still a link, pointing where it did.
      expect(await readlink(path.join(repoDir, 'secrets'))).toBe('/etc/passwd');
    });

    it('refuses to write through a link git has been told to ignore', async () => {
      // The one a tree check cannot see: the link is untracked AND hidden from
      // `git status` by a member-written `.gitignore`, so the room's files look
      // clean and the tree has nothing at that path. Only the on-disk walk
      // catches it — and without it, the save lands outside the room.
      const outside = path.join(scratch, 'outside');
      await mkdir(outside, { recursive: true });
      await writeFile(path.join(outside, 'notes.md'), 'not the room’s\n', 'utf-8');
      await put('.gitignore', 'escape.md\n');
      await commit('Ignore that');
      await symlink(path.join(outside, 'notes.md'), path.join(repoDir, 'escape.md'));
      // The room's files look clean and the tree has nothing at that path, so
      // every check above this one passes.
      expect(await git(['status', '--porcelain=v1'])).toBe('');

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'escape.md',
          baseCommit: await head(),
          text: 'written straight out of the room\n',
        }),
        'ROOM_FILE_NOT_READABLE'
      );

      expect(await readFile(path.join(outside, 'notes.md'), 'utf-8')).toBe('not the room’s\n');
    });

    it('refuses a name that differs from a real file only in capitals', async () => {
      // macOS and Windows open `room.md` and `ROOM.md` as one file while git
      // records them as two: the write lands on the other file's bytes, the
      // commit records only the name that was asked for, and the room's own
      // copy is left dirty — which stops every merge in the room.
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'room.md', baseCommit: null, text: 'sneaky\n' }),
        'ROOM_FILE_NOT_READABLE'
      );

      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toBe('# Release train\n');
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses a path the room’s own ignore rules exclude', async () => {
      await put('.gitignore', 'secrets.txt\n');
      await commit('Ignore that');

      // Without this the save would write the file, `git add` would refuse it,
      // and the request would fail as a server error after taking the file back
      // again. A sentence beats that.
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'secrets.txt',
          baseCommit: null,
          text: 'nothing to see\n',
        }),
        'ROOM_FILE_NOT_READABLE'
      );
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses a folder, and a folder the room does not have', async () => {
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'docs', baseCommit: null, text: 'x\n' }),
        'ROOM_FILE_NOT_READABLE'
      );
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'brand/new/note.md',
          baseCommit: null,
          text: 'x\n',
        }),
        'ROOM_FILE_NOT_FOUND'
      );
    });
  });

  describe('guards that a passing suite would not have noticed', () => {
    it('stages the file it was handed and nothing that merely matches it', async () => {
      // `git add` reads a bare path as a PATTERN: `git add -- '[a]x.md'` was
      // measured to stage `ax.md` alongside it. Through the save path that
      // cannot be seen — the dirty-main gate means every neighbour is already
      // identical to the commit, so an over-broad `git add` stages nothing
      // extra — which is exactly why this is asked of the PRIMITIVE, with a
      // neighbour deliberately made dirty first. A test that could not fail
      // would be worse than none (the review's own mutation survived the suite
      // at the service level, and this is where it does not).
      await put('[a]x.md', 'the file that was asked for\n');
      await put('ax.md', 'the neighbour a glob would sweep in\n');

      await stagePaths(repoDir, ['[a]x.md'], dorkHomeOf());

      expect((await git(['diff', '--cached', '--name-only'])).split('\n')).toEqual(['[a]x.md']);
    });

    it('treats a file somebody made executable as a change, though its bytes are identical', async () => {
      // A `chmod +x` moves the mode and not the blob, so a lock that compared
      // only shas called it "no change" and dropped it on the next save. Two
      // files with one sha are one file's contents; they are not one file.
      const opened = await head();
      // On disk rather than through the index, because the commit below stages
      // from the working tree — an index-only chmod would be undone by it.
      await chmod(path.join(repoDir, 'docs/plan.md'), 0o755);
      await commit('Make the plan runnable');

      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: 'docs/plan.md',
        baseCommit: opened,
        text: '# Plan\n\nMine.\n',
      });

      expect(outcome.status).toBe('conflict');
      expect(await git(['ls-tree', '-z', 'HEAD', '--', 'docs/plan.md'])).toContain('100755');
    });

    it('answers a stale save with the choice, even when the folder itself has gone', async () => {
      // The path checks used to win this race and answer "there is no such
      // folder — saving does not make new folders", which is true and useless:
      // the person did not ask for a folder, they were editing a file that has
      // since been deleted, and what they need is reload-or-keep-mine.
      const opened = await head();
      await git(['rm', '-r', '-q', 'docs']);
      await commit('Ana clears out the docs');

      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: 'docs/plan.md',
        baseCommit: opened,
        text: 'still working on this\n',
      });

      expect(outcome.status).toBe('conflict');
      if (outcome.status !== 'conflict') throw new Error('unreachable');
      expect(outcome.conflict.path).toBe('docs/plan.md');
      expect(outcome.conflict.commit).toBe(await head());
    });
  });

  describe('what a save may contain', () => {
    it('refuses text that would stop being text', async () => {
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'ROOM.md',
          baseCommit: await head(),
          text: 'looks fine\u0000until you read it back\n',
        }),
        'ROOM_FILE_NOT_TEXT'
      );
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses a file over the room’s own ceiling', async () => {
      caps = { ...caps, maxFileBytes: 32 };
      await store.write({
        roomId: ROOM_ID,
        mode: 'owned',
        createdAt: '2026-08-27T12:00:00.000Z',
        createdBy: OPERATOR,
        defaultBranch: 'main',
        caps,
        lastMergeSeq: null,
      });

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'ROOM.md',
          baseCommit: await head(),
          text: 'x'.repeat(64),
        }),
        'FILE_TOO_LARGE'
      );
    });

    it('refuses a save that would take the whole repo past its cap', async () => {
      caps = { ...caps, maxRepoBytes: 40 };
      await store.write({
        roomId: ROOM_ID,
        mode: 'owned',
        createdAt: '2026-08-27T12:00:00.000Z',
        createdBy: OPERATOR,
        defaultBranch: 'main',
        caps,
        lastMergeSeq: null,
      });

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'ROOM.md',
          baseCommit: await head(),
          text: 'x'.repeat(64),
        }),
        'REPO_CAP_EXCEEDED'
      );
    });
  });

  describe('the gates around it', () => {
    it('refuses whoever the room says may not save here', async () => {
      writeRefusal = new RoomError('PEOPLE_ONLY', 'Only people can save a room’s files');

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: null, text: 'x\n' }),
        'PEOPLE_ONLY'
      );
    });

    it('refuses a room with no files of its own', async () => {
      store.removeRow(ROOM_ID);

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: null, text: 'x\n' }),
        'ROOM_HAS_NO_REPO'
      );
    });

    it('waits in the same queue a merge takes, and says so when the wait runs out', async () => {
      queueWaitMs = 5;
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Somebody else holds the room's lane — a merge, in production.
      const holder = mutex.run(ROOM_ID, { waitMs: 1000, busy: () => new Error('unused') }, () =>
        held.then(() => undefined)
      );

      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: null, text: 'x\n' }),
        'MERGE_IN_FLIGHT'
      );

      release();
      await holder;
    });
  });

  describe('when the commit itself fails', () => {
    it('puts the file back, so one failed save does not wedge the room', async () => {
      const before = await head();
      const original = await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8');
      // A name made entirely of control characters is stripped to nothing on
      // the way into the commit, and git refuses an empty author. It is the one
      // failure that happens AFTER the file has been written.
      operatorName = '';

      await expect(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'ROOM.md',
          baseCommit: before,
          text: 'half a save\n',
        })
      ).rejects.toThrow();

      expect(await readFile(path.join(repoDir, 'ROOM.md'), 'utf-8')).toBe(original);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
      expect(await head()).toBe(before);
    });

    it('removes a file it created, rather than leaving it untracked', async () => {
      const before = await head();
      operatorName = '';

      await expect(
        editor.save(ROOM_ID, OPERATOR, {
          path: 'docs/new.md',
          baseCommit: null,
          text: 'half a save\n',
        })
      ).rejects.toThrow();

      expect(await git(['status', '--porcelain=v1'])).toBe('');
      expect(await head()).toBe(before);
    });
  });
});
