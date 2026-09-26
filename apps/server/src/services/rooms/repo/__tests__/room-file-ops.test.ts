/**
 * A person uploading, renaming, deleting and keeping a chat attachment in a
 * room's files (spec `agent-home-desk` §7.1-§7.2).
 *
 * Real git, on a real temporary DorkOS home, through the module's own hardened
 * runner — the same shape as `room-file-editor.test.ts`, whose save tests this
 * file extends to the four new operations. Every claim is about what is on disk
 * and in the history afterwards: one commit, authored as whom, under which
 * subject, the tree left clean, and — when something fails — `main` and `repo/`
 * exactly as they were.
 *
 * Seeded defects, each run and each red before the code stood:
 *
 * - Removing `rollbackChangeSet`'s body reddens "a failed upload leaves main
 *   and repo/ exactly as they were" (the half-written files stay behind).
 * - Comparing case only on the whole path (the old check) reddens every
 *   "`Notes/plan.md` when `notes/` exists" case.
 * - Writing a move's new path before removing its old one reddens "renames a
 *   file whose name only changes in capitals": on a folding filesystem the
 *   removal deletes the file just written.
 * - Authoring every commit as the operator reddens "two signed-in people get
 *   two authors".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import { ROOM_REPO_CAP_DEFAULTS, type RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomRepoMutex } from '../room-repo-mutex.js';
import { RoomFilesService } from '../room-files.js';
import {
  RoomFileEditor,
  type RoomFileActor,
  type RoomFileAnnouncement,
  type RoomFileChangeOutcome,
  type RoomFileEditorDeps,
} from '../room-file-editor.js';
import { commitAll, runGit } from '../room-repo-git.js';
import { commitChangeSet } from '../room-file-ops.js';
import { codeSpan, escapeMarkdown, fileChangeSentence } from '../room-file-change-text.js';
import { removeFixtureTree, silenceGitAutoMaintenance } from './fixture-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR: RoomFileActor = { authorId: 'author-operator', signedIn: false };
const ANA: RoomFileActor = { authorId: '01ANAAAAAAAAAAAAAAAAAAAAAA', signedIn: true };
const BEN: RoomFileActor = { authorId: '01BENAAAAAAAAAAAAAAAAAAAAA', signedIn: true };

describe('RoomFileEditor — upload, move, delete, from the chat', () => {
  let db: Db;
  let scratch: string;
  let stagingRoot: string;
  let store: RoomRepoStore;
  let editor: RoomFileEditor;
  let editorDeps: RoomFileEditorDeps;
  let repoDir: string;
  let mutex: RoomRepoMutex;
  let caps: RoomRepoCaps;
  let announced: RoomFileAnnouncement[];
  let writeRefusal: RoomError | null;

  function git(args: string[]): Promise<string> {
    return runGit(args, repoDir, store.homeDir(ROOM_ID));
  }

  async function put(relPath: string, body: string | Buffer): Promise<void> {
    const target = path.join(repoDir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async function commit(message: string): Promise<string> {
    return commitAll(
      repoDir,
      message,
      { name: 'Ana', email: 'who@dorkos.local' },
      store.homeDir(ROOM_ID)
    );
  }

  function head(): Promise<string> {
    return git(['rev-parse', 'HEAD']);
  }

  /** Stage bytes the way multer would, and describe them as an upload item. */
  async function staged(name: string, body: string | Buffer) {
    const file = path.join(stagingRoot, `${Math.random().toString(36).slice(2)}`);
    await mkdir(stagingRoot, { recursive: true });
    await writeFile(file, body);
    return { name, content: { file, size: Buffer.byteLength(body) } };
  }

  function changed(outcome: RoomFileChangeOutcome) {
    if (outcome.status !== 'changed') throw new Error(`expected a change, got ${outcome.status}`);
    return outcome.result;
  }

  async function expectRoomError(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toThrow(RoomError);
    await expect(promise).rejects.toMatchObject({ code });
  }

  /** Everything that says whether `repo/` is exactly as it was. */
  async function snapshot(): Promise<{ head: string; files: string; status: string }> {
    return {
      head: await head(),
      files: await git(['ls-files', '-s']),
      status: await git(['status', '--porcelain=v1', '--ignored', '--untracked-files=all']),
    };
  }

  beforeEach(async () => {
    db = createTestDb();
    silenceGitAutoMaintenance();
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-file-ops-'));
    stagingRoot = path.join(scratch, 'staging');
    const dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
    store = new RoomRepoStore(db, dorkHome);
    db.insert(rooms)
      .values({
        id: ROOM_ID,
        kind: 'channel',
        title: 'Release train',
        createdAt: '2026-09-26T12:00:00.000Z',
        lastActivityAt: '2026-09-26T12:00:00.000Z',
      })
      .run();

    caps = { ...ROOM_REPO_CAP_DEFAULTS };
    announced = [];
    writeRefusal = null;
    mutex = new RoomRepoMutex();

    repoDir = store.repoPath(ROOM_ID);
    await mkdir(repoDir, { recursive: true });
    await git(['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.']);
    await store.write({
      roomId: ROOM_ID,
      mode: 'owned',
      createdAt: '2026-09-26T12:00:00.000Z',
      createdBy: OPERATOR.authorId,
      defaultBranch: 'main',
      caps,
      lastMergeSeq: null,
    });
    await put('ROOM.md', '# Release train\n');
    await put('notes/plan.md', '# Plan\n');
    await put('notes/todo.md', '- ship\n');
    await put('bin/run.sh', '#!/bin/sh\necho hi\n');
    await chmod(path.join(repoDir, 'bin/run.sh'), 0o755);
    await commit('Start');

    const files = new RoomFilesService({
      store,
      hasRepo: () => true,
      maxFileBytes: () => caps.maxFileBytes,
    });
    editorDeps = {
      store,
      mutex,
      enabled: () => true,
      queueWaitMs: () => 5000,
      assertCanWriteFiles: () => {
        if (writeRefusal) throw writeRefusal;
      },
      operatorGitName: () => 'Dorian',
      personName: (authorId) =>
        authorId === ANA.authorId ? 'Ana Lima' : authorId === BEN.authorId ? 'Ben' : null,
      announce: (_roomId, input) => {
        announced.push(input);
      },
      uploadStagingRoot: () => stagingRoot,
      files,
    };
    editor = new RoomFileEditor(editorDeps);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeFixtureTree(scratch);
  });

  describe('upload', () => {
    it('adds files, binary included, as one commit into a folder it creates', async () => {
      const before = await head();
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);

      const result = changed(
        await editor.upload(ROOM_ID, OPERATOR, {
          dir: 'designs/v1',
          baseCommit: before,
          replace: [],
          files: [await staged('logo.png', png), await staged('brief.md', 'brief\n')],
        })
      );

      expect(await git(['rev-list', '--count', `${before}..HEAD`])).toBe('1');
      expect(await git(['log', '--format=%an <%ae>%n%s', '-n', '1'])).toBe(
        'Dorian <operator@dorkos.local>\nUpload 2 files to designs/v1/'
      );
      expect(await readFile(path.join(repoDir, 'designs/v1/logo.png'))).toEqual(png);
      expect(result.paths).toEqual(['designs/v1/brief.md', 'designs/v1/logo.png']);
      expect(result.commit).toBe(await head());
      expect(result.lastCommit).toMatchObject({
        author: 'Dorian',
        subject: 'Upload 2 files to designs/v1/',
      });
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses a name the folder already has, naming it, unless it is listed to replace', async () => {
      const base = await head();
      const promise = editor.upload(ROOM_ID, OPERATOR, {
        dir: 'notes',
        baseCommit: base,
        replace: [],
        files: [await staged('plan.md', 'mine\n')],
      });
      await expectRoomError(promise, 'ROOM_FILE_EXISTS');
      await expect(promise).rejects.toThrow(/notes\/plan\.md/);

      changed(
        await editor.upload(ROOM_ID, OPERATOR, {
          dir: 'notes',
          baseCommit: base,
          replace: ['plan.md'],
          files: [await staged('plan.md', 'mine\n')],
        })
      );
      expect(await readFile(path.join(repoDir, 'notes/plan.md'), 'utf-8')).toBe('mine\n');
    });

    it('refuses to replace a file that changed since the person looked', async () => {
      const opened = await head();
      await put('notes/plan.md', '# Plan, revised\n');
      await commit('Revise the plan');

      const outcome = await editor.upload(ROOM_ID, OPERATOR, {
        dir: 'notes',
        baseCommit: opened,
        replace: ['plan.md'],
        files: [await staged('plan.md', 'mine\n')],
      });

      expect(outcome).toMatchObject({
        status: 'conflict',
        conflict: { path: 'notes/plan.md', commit: await head() },
      });
      expect(await readFile(path.join(repoDir, 'notes/plan.md'), 'utf-8')).toBe(
        '# Plan, revised\n'
      );
    });

    it('refuses a folder that differs from a real one only in capitals, naming the real one', async () => {
      const promise = editor.upload(ROOM_ID, OPERATOR, {
        dir: 'Notes',
        baseCommit: await head(),
        replace: [],
        files: [await staged('plan2.md', 'x\n')],
      });
      await expectRoomError(promise, 'ROOM_FILE_NOT_READABLE');
      await expect(promise).rejects.toThrow(/`notes\/`/);
    });

    it('refuses two files in one upload that are one file on a folding filesystem', async () => {
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: await head(),
          replace: [],
          files: [await staged('Logo.png', 'a'), await staged('logo.png', 'b')],
        }),
        'ROOM_FILE_NOT_READABLE'
      );
    });

    it('refuses a name with a slash in it, and the room’s own git directory', async () => {
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: null,
          replace: [],
          files: [await staged('../escape.md', 'x')],
        }),
        'ROOM_FILE_PATH_INVALID'
      );
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '.GIT',
          baseCommit: null,
          replace: [],
          files: [await staged('config', 'x')],
        }),
        'ROOM_FILE_PATH_INVALID'
      );
    });

    it('refuses to write through a link on disk that git has been told to ignore', async () => {
      const outside = path.join(scratch, 'outside');
      await mkdir(outside);
      await put('.gitignore', 'drop\n');
      await commit('Ignore drop');
      await symlink(outside, path.join(repoDir, 'drop'));

      await expect(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: 'drop',
          baseCommit: null,
          replace: [],
          files: [await staged('x.md', 'x')],
        })
      ).rejects.toThrow(RoomError);
      expect(existsSync(path.join(outside, 'x.md'))).toBe(false);
    });

    it('refuses a file over the room’s ceiling, and one that takes the repo past its cap', async () => {
      caps.maxFileBytes = 8;
      await store.write({ ...(await store.readSidecar(ROOM_ID))!, caps });
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: null,
          replace: [],
          files: [await staged('big.bin', 'x'.repeat(9))],
        }),
        'FILE_TOO_LARGE'
      );

      caps.maxFileBytes = ROOM_REPO_CAP_DEFAULTS.maxFileBytes;
      caps.maxRepoBytes = 64;
      await store.write({ ...(await store.readSidecar(ROOM_ID))!, caps });
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: null,
          replace: [],
          files: [await staged('a.bin', 'x'.repeat(30))],
        }),
        'REPO_CAP_EXCEEDED'
      );
    });

    it('refuses while somebody outside DorkOS has been writing in the room’s copy', async () => {
      await put('ROOM.md', '# edited in a terminal\n');
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: null,
          replace: [],
          files: [await staged('x.md', 'x')],
        }),
        'MAIN_CHECKOUT_DIRTY'
      );
    });

    it('refuses more than twenty files', async () => {
      const files = [];
      for (let i = 0; i < 21; i++) files.push(await staged(`f${i}.md`, 'x'));
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, { dir: '', baseCommit: null, replace: [], files }),
        'ROOM_UPLOAD_TOO_MANY_FILES'
      );
    });

    it('stages each request in a folder of its own, and removes it', async () => {
      const { stagingDir, maxFileBytes } = await editor.prepareUpload(ROOM_ID, OPERATOR);
      expect(path.dirname(stagingDir)).toBe(stagingRoot);
      expect(maxFileBytes).toBe(caps.maxFileBytes);
      expect((await stat(stagingDir)).isDirectory()).toBe(true);

      await editor.discardUpload(stagingDir);
      expect(existsSync(stagingDir)).toBe(false);
    });
  });

  describe('rollback', () => {
    async function lockMainRef(): Promise<() => Promise<void>> {
      const lock = path.join(repoDir, '.git', 'refs', 'heads', 'main.lock');
      await writeFile(lock, '', 'utf-8');
      return () => rm(lock, { force: true });
    }

    it('a failed upload leaves main and repo/ exactly as they were', async () => {
      const base = await head();
      const before = await snapshot();
      const unlock = await lockMainRef();

      await expect(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: 'fresh/deep',
          baseCommit: base,
          replace: ['plan.md'],
          files: [await staged('a.md', 'a\n'), await staged('b.md', 'b\n')],
        })
      ).rejects.toThrow();
      await expect(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: 'notes',
          baseCommit: base,
          replace: ['plan.md'],
          files: [await staged('plan.md', 'replaced\n'), await staged('new.md', 'new\n')],
        })
      ).rejects.toThrow();
      await unlock();

      expect(await snapshot()).toEqual(before);
      expect(existsSync(path.join(repoDir, 'fresh'))).toBe(false);
      expect(await readFile(path.join(repoDir, 'notes/plan.md'), 'utf-8')).toBe('# Plan\n');
      expect(announced).toEqual([]);
    });

    it('a failed rename and a failed delete of a folder put every file back', async () => {
      const base = await head();
      const before = await snapshot();
      const unlock = await lockMainRef();

      await expect(
        editor.move(ROOM_ID, OPERATOR, { from: 'notes', to: 'archive/notes', baseCommit: base })
      ).rejects.toThrow();
      await expect(
        editor.remove(ROOM_ID, OPERATOR, { path: 'notes', baseCommit: base })
      ).rejects.toThrow();
      await unlock();

      expect(await snapshot()).toEqual(before);
      expect(existsSync(path.join(repoDir, 'archive'))).toBe(false);
    });
  });

  describe('move', () => {
    it('renames a file as one commit with the pinned subject', async () => {
      const base = await head();
      const result = changed(
        await editor.move(ROOM_ID, OPERATOR, {
          from: 'ROOM.md',
          to: 'docs/ROOM-old.md',
          baseCommit: base,
        })
      );

      expect(await git(['log', '--format=%s', '-n', '1'])).toBe(
        'Rename ROOM.md to docs/ROOM-old.md'
      );
      expect(await git(['rev-list', '--count', `${base}..HEAD`])).toBe('1');
      expect(result.paths).toEqual(['docs/ROOM-old.md']);
      expect(existsSync(path.join(repoDir, 'ROOM.md'))).toBe(false);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('moves a folder, keeping the executable bit, and removes the old folder', async () => {
      const base = await head();
      changed(
        await editor.move(ROOM_ID, OPERATOR, { from: 'bin', to: 'tools/bin', baseCommit: base })
      );

      expect(await git(['log', '--format=%s', '-n', '1'])).toBe('Rename bin/ to tools/bin/');
      expect(await git(['ls-files', '-s', 'tools/bin/run.sh'])).toMatch(/^100755 /);
      expect(existsSync(path.join(repoDir, 'bin'))).toBe(false);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('renames a file whose name only changes in capitals', async () => {
      changed(
        await editor.move(ROOM_ID, OPERATOR, {
          from: 'notes/plan.md',
          to: 'notes/Plan.md',
          baseCommit: await head(),
        })
      );

      expect(await git(['ls-files', 'notes'])).toBe('notes/Plan.md\nnotes/todo.md');
      expect(await readFile(path.join(repoDir, 'notes/Plan.md'), 'utf-8')).toBe('# Plan\n');
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses a destination that exists, and one whose folder differs only in capitals', async () => {
      const base = await head();
      await expectRoomError(
        editor.move(ROOM_ID, OPERATOR, { from: 'ROOM.md', to: 'notes/plan.md', baseCommit: base }),
        'ROOM_FILE_EXISTS'
      );
      const promise = editor.move(ROOM_ID, OPERATOR, {
        from: 'ROOM.md',
        to: 'Notes/plan-room.md',
        baseCommit: base,
      });
      await expectRoomError(promise, 'ROOM_FILE_NOT_READABLE');
      await expect(promise).rejects.toThrow(/`notes\/`/);
    });

    it('refuses when any file under the folder changed since the person looked', async () => {
      const opened = await head();
      await put('notes/todo.md', '- ship\n- test\n');
      await commit('More todo');

      const outcome = await editor.move(ROOM_ID, OPERATOR, {
        from: 'notes',
        to: 'old-notes',
        baseCommit: opened,
      });

      expect(outcome).toMatchObject({ status: 'conflict', conflict: { path: 'notes/todo.md' } });
      expect(existsSync(path.join(repoDir, 'notes/todo.md'))).toBe(true);
    });

    it('refuses a folder moved inside itself, and a path the room does not have', async () => {
      const base = await head();
      await expectRoomError(
        editor.move(ROOM_ID, OPERATOR, { from: 'notes', to: 'notes/inner', baseCommit: base }),
        'ROOM_FILE_PATH_INVALID'
      );
      await expectRoomError(
        editor.move(ROOM_ID, OPERATOR, { from: 'nope.md', to: 'yes.md', baseCommit: base }),
        'ROOM_FILE_NOT_FOUND'
      );
    });
  });

  describe('delete', () => {
    it('deletes a folder as one commit, and the folder is gone from disk', async () => {
      const base = await head();
      const result = changed(
        await editor.remove(ROOM_ID, OPERATOR, { path: 'notes', baseCommit: base })
      );

      expect(await git(['log', '--format=%s', '-n', '1'])).toBe('Delete notes/');
      expect(result.paths).toEqual(['notes/plan.md', 'notes/todo.md']);
      expect(existsSync(path.join(repoDir, 'notes'))).toBe(false);
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('refuses when the file changed since the person looked', async () => {
      const opened = await head();
      await put('ROOM.md', '# changed\n');
      await commit('Change');

      const outcome = await editor.remove(ROOM_ID, OPERATOR, {
        path: 'ROOM.md',
        baseCommit: opened,
      });

      expect(outcome).toMatchObject({ status: 'conflict', conflict: { path: 'ROOM.md' } });
      expect(existsSync(path.join(repoDir, 'ROOM.md'))).toBe(true);
    });
  });

  describe('from the chat', () => {
    it('saves bytes under the given name, with the pinned subject, refusing a name that exists', async () => {
      const base = await head();
      changed(
        await editor.saveAttachment(ROOM_ID, OPERATOR, {
          dir: 'designs',
          name: 'screenshot.png',
          baseCommit: base,
          bytes: Buffer.from([1, 0, 2]),
        })
      );
      expect(await git(['log', '--format=%s', '-n', '1'])).toBe(
        'Add designs/screenshot.png from the chat'
      );

      await expectRoomError(
        editor.saveAttachment(ROOM_ID, OPERATOR, {
          dir: 'designs',
          name: 'screenshot.png',
          baseCommit: await head(),
          bytes: Buffer.from([3]),
        }),
        'ROOM_FILE_EXISTS'
      );
      const promise = editor.saveAttachment(ROOM_ID, OPERATOR, {
        dir: 'Notes',
        name: 'shot.png',
        baseCommit: await head(),
        bytes: Buffer.from([3]),
      });
      await expectRoomError(promise, 'ROOM_FILE_NOT_READABLE');
      await expect(promise).rejects.toThrow(/`notes\/`/);
    });
  });

  describe('authorship', () => {
    it('two signed-in people get two authors, neither of them the operator', async () => {
      await editor.save(ROOM_ID, ANA, { path: 'a.md', baseCommit: null, text: 'a\n' });
      await editor.save(ROOM_ID, BEN, { path: 'b.md', baseCommit: null, text: 'b\n' });

      expect(await git(['log', '--format=%an <%ae>', '-n', '2'])).toBe(
        [
          `Ben <person-${BEN.authorId}@dorkos.local>`,
          `Ana Lima <person-${ANA.authorId}@dorkos.local>`,
        ].join('\n')
      );
    });

    it('a signed-in person with no name git will take is authored under the fallback', async () => {
      const nameless: RoomFileActor = { authorId: 'someone-else', signedIn: true };
      await editor.remove(ROOM_ID, nameless, { path: 'ROOM.md', baseCommit: await head() });

      expect(await git(['log', '--format=%an <%ae>', '-n', '1'])).toBe(
        'DorkOS operator <person-someone-else@dorkos.local>'
      );
      expect(announced.at(-1)?.text).toBe('Someone deleted `ROOM.md`');
    });

    it('with login off, every change is the operator’s', async () => {
      await editor.remove(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: await head() });
      expect(await git(['log', '--format=%an <%ae>', '-n', '1'])).toBe(
        'Dorian <operator@dorkos.local>'
      );
    });
  });

  describe('the room entry', () => {
    it('posts one entry per commit, naming the person, for every operation — and none for a no-op', async () => {
      await editor.save(ROOM_ID, ANA, { path: 'ROOM.md', baseCommit: await head(), text: 'new\n' });
      await editor.save(ROOM_ID, ANA, { path: 'notes/new.md', baseCommit: null, text: 'n\n' });
      await editor.save(ROOM_ID, ANA, {
        path: 'notes/new.md',
        baseCommit: await head(),
        text: 'n\n',
      });
      await editor.upload(ROOM_ID, ANA, {
        dir: 'designs',
        baseCommit: await head(),
        replace: [],
        files: [await staged('a.png', 'a'), await staged('b.png', 'b'), await staged('c.png', 'c')],
      });
      await editor.move(ROOM_ID, ANA, {
        from: 'notes/todo.md',
        to: 'notes/done.md',
        baseCommit: await head(),
      });
      await editor.remove(ROOM_ID, ANA, { path: 'notes', baseCommit: await head() });
      await editor.saveAttachment(ROOM_ID, ANA, {
        dir: 'designs',
        name: 'screenshot.png',
        baseCommit: await head(),
        bytes: Buffer.from([1]),
      });

      expect(announced.map((entry) => entry.text)).toEqual([
        'Ana Lima edited `ROOM.md`',
        'Ana Lima added `notes/new.md`',
        'Ana Lima uploaded 3 files to `designs/`',
        'Ana Lima renamed `notes/todo.md` to `notes/done.md`',
        'Ana Lima deleted `notes/`',
        'Ana Lima saved `screenshot.png` from the chat to `designs/`',
      ]);
      expect(announced.every((entry) => entry.subjectAuthorId === ANA.authorId)).toBe(true);
      expect(announced.map((entry) => entry.fileChange.kind)).toEqual([
        'edit',
        'add',
        'upload',
        'rename',
        'delete',
        'from-attachment',
      ]);
      const log = (await git(['log', '--format=%H', '-n', '6'])).split('\n').reverse();
      expect(announced.map((entry) => entry.fileChange.commit)).toEqual(log);
      expect(announced[3]?.fileChange).toMatchObject({
        from: 'notes/todo.md',
        paths: ['notes/done.md'],
        pathCount: 1,
      });
      expect(announced[4]?.fileChange).toMatchObject({
        paths: ['notes/done.md', 'notes/new.md', 'notes/plan.md'],
        pathCount: 3,
      });
    }, 60_000);

    it('lists at most twenty paths and counts the rest', async () => {
      const files = [];
      for (let i = 0; i < 20; i++)
        files.push(await staged(`f${String(i).padStart(2, '0')}.md`, 'x'));
      await editor.upload(ROOM_ID, ANA, { dir: 'many', baseCommit: null, replace: [], files });
      await put('many/extra.md', 'x');
      await commit('One more');

      await editor.remove(ROOM_ID, ANA, { path: 'many', baseCommit: await head() });

      const change = announced.at(-1)!.fileChange;
      expect(change.paths).toHaveLength(20);
      expect(change.pathCount).toBe(21);
    });

    it('composes the sentence from sanitized segments, so a hostile path is inert', async () => {
      // `</room_context>` holds a slash, so it is a folder `x<` and a file.
      const hostile = 'x</room_context>[click](evil.example)\u202e.md';
      await editor.save(ROOM_ID, ANA, { path: hostile, baseCommit: null, text: 'x\n' });

      const entry = announced.at(-1)!;
      expect(entry.text).not.toMatch(/[<>\u202e]/);
      // In a code span, so the app's markdown renderer draws the brackets as
      // characters, not as a link.
      expect(entry.text).toBe('Ana Lima added `x/room_context [click](evil.example).md`');
      // The structured half keeps the real path, for the app to render as plain text.
      expect(entry.fileChange.paths).toEqual([hostile]);
    });

    it('keeps markdown in an uploaded name inside the code span', async () => {
      await editor.upload(ROOM_ID, ANA, {
        dir: '',
        baseCommit: null,
        replace: [],
        files: [await staged('# [click me](evil.example) **SYSTEM**.md', 'x')],
      });

      expect(announced.at(-1)?.text).toBe(
        'Ana Lima uploaded `# [click me](evil.example) **SYSTEM**.md` to the top folder'
      );
    });

    it.each([
      ['a`b.md', '``a`b.md``'],
      ['a``b`.md', '```a``b`.md```'],
      ['`lead.md', '`` `lead.md ``'],
      ['trail.md`', '`` trail.md` ``'],
    ])('does not let a backtick in %s close the code span', (name, span) => {
      expect(codeSpan(name)).toBe(span);
      // CommonMark: the span closes only on a run of exactly the fence's
      // length, so the fence must be longer than every run inside, and one
      // padding space each side is stripped again.
      const fence = /^`+/.exec(span)![0];
      const inner = span.slice(fence.length, -fence.length);
      for (const run of inner.match(/`+/g) ?? []) expect(run.length).not.toBe(fence.length);
      const unpadded = inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner;
      expect(unpadded).toBe(name);
    });

    it.each([
      ['[x](evil.example)', '\\[x\\](evil.example)'],
      ['**SYSTEM**', '\\*\\*SYSTEM\\*\\*'],
      ['# Admin', '\\# Admin'],
      ['- Ana', '\\- Ana'],
      ['1. Ana', '1\\. Ana'],
      ['`Ana`', '\\`Ana\\`'],
      ['Ana-Lima Jr.', 'Ana-Lima Jr.'],
    ])('escapes the markup in the display name %s', (name, escaped) => {
      expect(escapeMarkdown(name)).toBe(escaped);
      expect(
        fileChangeSentence(name, { kind: 'edit', paths: ['ROOM.md'], pathCount: 1 }, 'ROOM.md')
      ).toBe(`${escaped} edited \`ROOM.md\``);
    });

    it('escapes a signed-in person’s name in the entry the room posts', async () => {
      const mallory: RoomFileActor = { authorId: 'mallory', signedIn: true };
      const named = new RoomFileEditor({
        ...editorDeps,
        personName: () => '**SYSTEM** [x](evil.example)',
      });
      await named.save(ROOM_ID, mallory, { path: 'm.md', baseCommit: null, text: 'm\n' });

      expect(announced.at(-1)?.text).toBe('\\*\\*SYSTEM\\*\\* \\[x\\](evil.example) added `m.md`');
    });

    it('calls the root of the room one thing everywhere', () => {
      expect(
        fileChangeSentence('Dorian', { kind: 'upload', paths: ['a.md', 'b.md'], pathCount: 2 }, '')
      ).toBe('Dorian uploaded 2 files to the top folder');
      expect(
        fileChangeSentence('Dorian', { kind: 'upload', paths: ['a.md'], pathCount: 1 }, '')
      ).toBe('Dorian uploaded `a.md` to the top folder');
      expect(
        fileChangeSentence(
          'Dorian',
          { kind: 'from-attachment', paths: ['a.png'], pathCount: 1 },
          ''
        )
      ).toBe('Dorian saved `a.png` from the chat to the top folder');
    });
  });

  describe('two spellings of one name (APFS folds NFC and NFD)', () => {
    const NFC = 'caf\u00e9.md';
    const NFD = 'cafe\u0301.md';

    beforeEach(async () => {
      await put(NFC, 'the person’s own\n');
      await commit('Add café');
    });

    it('an NFD upload over the NFC file is refused ROOM_FILE_EXISTS, not written', async () => {
      const promise = editor.upload(ROOM_ID, OPERATOR, {
        dir: '',
        baseCommit: await head(),
        replace: [],
        files: [await staged(NFD, 'overwritten\n')],
      });
      await expectRoomError(promise, 'ROOM_FILE_EXISTS');
      expect(await readFile(path.join(repoDir, NFC), 'utf-8')).toBe('the person’s own\n');
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('an NFD save with no base commit finds the NFC file and answers the conflict', async () => {
      const outcome = await editor.save(ROOM_ID, OPERATOR, {
        path: NFD,
        baseCommit: null,
        text: 'overwritten\n',
      });
      expect(outcome).toMatchObject({ status: 'conflict', conflict: { path: NFC } });
      expect(await readFile(path.join(repoDir, NFC), 'utf-8')).toBe('the person’s own\n');
    });

    it('an NFD replace meets the lock and replaces the one NFC file', async () => {
      const opened = await head();
      await put(NFC, 'somebody else’s\n');
      await commit('Edit café');
      const stale = await editor.upload(ROOM_ID, OPERATOR, {
        dir: '',
        baseCommit: opened,
        replace: [NFD],
        files: [await staged(NFD, 'mine\n')],
      });
      expect(stale).toMatchObject({ status: 'conflict', conflict: { path: NFC } });

      changed(
        await editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: await head(),
          replace: [NFD],
          files: [await staged(NFD, 'mine\n')],
        })
      );
      expect(await git(['ls-files', '-z'])).not.toContain(NFD);
      expect(await readFile(path.join(repoDir, NFC), 'utf-8')).toBe('mine\n');
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });

    it('a change set refuses an NFD path exactly when this filesystem makes it the NFC file', async () => {
      // Straight at the engine, with the tree's answer deliberately wrong: the
      // path is "new" to the change set. On APFS the NFD name OPENS the NFC
      // file — the state the NFD bug produced — and the exclusive create must
      // refuse it. On ext4 the two are different files, so the NFD file is a
      // new file of its own and the person's NFC file is untouched either way.
      // (The editor never gets here with an NFD twin: it resolves each segment
      // to the tree's own spelling first — the tests above, which hold on both.)
      const folds = existsSync(path.join(repoDir, NFD));
      const before = await head();
      const attempt = commitChangeSet(
        repoDir,
        store.homeDir(ROOM_ID),
        [{ path: NFD, content: Buffer.from('another file\n'), existed: false }],
        'Add café again',
        { name: 'Dorian', email: 'operator@dorkos.local' }
      );

      if (folds) {
        await expect(attempt).rejects.toMatchObject({ code: 'ROOM_FILE_EXISTS' });
        expect(await head()).toBe(before);
      } else {
        await expect(attempt).resolves.toMatch(/^[0-9a-f]{40}$/);
        expect(await readFile(path.join(repoDir, NFD), 'utf-8')).toBe('another file\n');
      }
      expect(await readFile(path.join(repoDir, NFC), 'utf-8')).toBe('the person’s own\n');
      expect(await git(['status', '--porcelain=v1'])).toBe('');
    });
  });

  describe('the exclusive create', () => {
    it('never overwrites, and a rollback never deletes, a file it did not create', async () => {
      // Filesystem-independent: something stands at a path the tree does not
      // list (here an untracked file). The change set must refuse rather than
      // truncate it, and must not count it as its own to remove.
      await put('stray.md', 'somebody’s own\n');
      const before = await head();

      await expect(
        commitChangeSet(
          repoDir,
          store.homeDir(ROOM_ID),
          [
            { path: 'fresh.md', content: Buffer.from('new\n'), existed: false },
            { path: 'stray.md', content: Buffer.from('overwritten\n'), existed: false },
          ],
          'Add two files',
          { name: 'Dorian', email: 'operator@dorkos.local' }
        )
      ).rejects.toMatchObject({ code: 'ROOM_FILE_EXISTS' });

      expect(await readFile(path.join(repoDir, 'stray.md'), 'utf-8')).toBe('somebody’s own\n');
      // The file it DID create is gone again; the stray one is exactly as it was.
      expect(existsSync(path.join(repoDir, 'fresh.md'))).toBe(false);
      expect(await git(['status', '--porcelain=v1'])).toBe('?? stray.md');
      expect(await head()).toBe(before);
    });
  });

  describe('every door into .git', () => {
    it.each([
      '.git../x.md',
      '.git. ./x.md',
      '.git::$INDEX_ALLOCATION/x.md',
      '.git:x/y.md',
      'GIT~2/config',
      'git~9/config',
      '.g\u200cit/config',
      'notes/.GIT\ufeff/config',
      'a:b.md',
    ])('refuses %s before anything is written', async (bad) => {
      const before = await snapshot();
      await expectRoomError(
        editor.save(ROOM_ID, OPERATOR, { path: bad, baseCommit: null, text: 'x\n' }),
        'ROOM_FILE_PATH_INVALID'
      );
      expect(await snapshot()).toEqual(before);
    });

    it('refuses an upload named for an NTFS stream of .git, with the rest of the batch unwritten', async () => {
      const before = await snapshot();
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: null,
          replace: [],
          files: [await staged('ok.md', 'x'), await staged('.git::$INDEX_ALLOCATION', 'x')],
        }),
        'ROOM_FILE_PATH_INVALID'
      );
      expect(await snapshot()).toEqual(before);
      expect(existsSync(path.join(repoDir, 'ok.md'))).toBe(false);
    });
  });

  describe('large folders', () => {
    it('moves and deletes a folder of more files than one git command is handed', async () => {
      for (let i = 0; i < 230; i++) await put(`big/f${String(i).padStart(3, '0')}.md`, `${i}\n`);
      await commit('A big folder');

      changed(
        await editor.move(ROOM_ID, OPERATOR, { from: 'big', to: 'huge', baseCommit: await head() })
      );
      expect((await git(['ls-files', 'huge'])).split('\n')).toHaveLength(230);
      expect(await git(['status', '--porcelain=v1'])).toBe('');

      changed(await editor.remove(ROOM_ID, OPERATOR, { path: 'huge', baseCommit: await head() }));
      expect(await git(['ls-files', 'huge'])).toBe('');
      expect(existsSync(path.join(repoDir, 'huge'))).toBe(false);
    }, 180_000);
  });

  describe('the gates around it', () => {
    it('refuses whoever the room says may not change its files, for every operation', async () => {
      writeRefusal = new RoomError('PEOPLE_ONLY', 'Only people can change a room’s files');
      const base = await head();

      await expectRoomError(editor.prepareUpload(ROOM_ID, OPERATOR), 'PEOPLE_ONLY');
      await expectRoomError(
        editor.upload(ROOM_ID, OPERATOR, {
          dir: '',
          baseCommit: base,
          replace: [],
          files: [await staged('a', 'a')],
        }),
        'PEOPLE_ONLY'
      );
      await expectRoomError(
        editor.move(ROOM_ID, OPERATOR, { from: 'ROOM.md', to: 'R.md', baseCommit: base }),
        'PEOPLE_ONLY'
      );
      await expectRoomError(
        editor.remove(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: base }),
        'PEOPLE_ONLY'
      );
      await expectRoomError(
        editor.saveAttachment(ROOM_ID, OPERATOR, {
          dir: '',
          name: 'a',
          baseCommit: base,
          bytes: Buffer.from('a'),
        }),
        'PEOPLE_ONLY'
      );
      expect(await head()).toBe(base);
    });

    it('waits behind a running merge in the same queue, then lands', async () => {
      let release = (): void => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const holder = mutex.run(ROOM_ID, { waitMs: 5000, busy: () => new Error('unused') }, () =>
        held.then(() => undefined)
      );
      const base = await head();
      const pending = editor.remove(ROOM_ID, OPERATOR, { path: 'ROOM.md', baseCommit: base });
      let settled = false;
      void pending.finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(await head()).toBe(base);

      release();
      await holder;
      changed(await pending);
      expect(await head()).not.toBe(base);
    });
  });
});
