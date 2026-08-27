/**
 * Reading a room's files (spec `project-rooms` §3.9).
 *
 * Real git, on a real temporary DorkOS home built through the module's own
 * hardened runner. Nothing below the service's seams is mocked, because every
 * claim under test is about what git actually answers: what a tree holds, which
 * commit last touched a path, and what a symlink is when you refuse to follow
 * it.
 *
 * **The fixture home sits inside an enclosing git repository on purpose** — the
 * dev layout (`apps/server/.temp/.dork/`) does, and without a discovery ceiling
 * a room whose `repo/` is missing would answer for whatever repository encloses
 * the data directory. That is a room serving the dorkos checkout's files as its
 * own.
 *
 * Seeded defects, each run and each red before the code stood:
 *
 * - Reading the working tree instead of the commit turns "an uncommitted edit
 *   is invisible" green-to-red.
 * - Taking `kind` from ls-tree's TYPE rather than its MODE reddens both symlink
 *   tests — a symlink is a `blob`, exactly as a file is.
 * - Dropping the `..` check from `normalizeRoomFilePath` reddens the traversal
 *   test; dropping the whole normaliser reddens the backslash and absolute-path
 *   cases too.
 * - Answering `text` before checking the size reddens the cap test.
 * - Reading provenance per entry instead of in one walk reddens the
 *   git-invocation count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import { RoomError } from '../../room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomFilesService, normalizeRoomFilePath } from '../room-files.js';
import { runGit, runGitRaw } from '../room-repo-git.js';

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';

/** The default file ceiling the tests run under, unless one overrides it. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

describe('RoomFilesService', () => {
  let db: Db;
  let scratch: string;
  let dorkHome: string;
  let store: RoomRepoStore;
  let service: RoomFilesService;
  let repoDir: string;
  let hasRepo: boolean;
  let maxFileBytes: number;
  /** Every git command the service ran during one test. */
  let calls: string[][];

  /** Run git in the room's repo, with the room's home as the ceiling. */
  function git(args: string[], dir = repoDir): Promise<string> {
    return runGit(args, dir, store.homeDir(ROOM_ID));
  }

  /** Commit everything in the room's repo under `who`. */
  async function commit(message: string, who = 'Dorian'): Promise<string> {
    await git(['add', '--all']);
    await git([
      '-c',
      `user.name=${who}`,
      '-c',
      'user.email=who@dorkos.local',
      'commit',
      '--quiet',
      '-m',
      message,
    ]);
    return git(['rev-parse', 'HEAD']);
  }

  /** Write a file inside the room's repo, creating its directory. */
  async function put(relPath: string, body: string | Buffer): Promise<void> {
    const target = path.join(repoDir, relPath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  beforeEach(async () => {
    db = createTestDb();
    scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-room-files-'));
    // The enclosing repository — see the module doc. It ignores everything and
    // has a commit of its own, so it reads clean: exactly the answer that would
    // make a ceiling-less read believe it was looking at the room.
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

    repoDir = store.repoPath(ROOM_ID);
    await mkdir(repoDir, { recursive: true });
    await git(['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.']);

    hasRepo = true;
    maxFileBytes = MAX_FILE_BYTES;
    calls = [];
    service = new RoomFilesService({
      store,
      hasRepo: () => hasRepo,
      maxFileBytes: () => maxFileBytes,
      runGit: (args, cwd, ceiling) => {
        calls.push(args);
        return runGit(args, cwd, ceiling);
      },
      runGitRaw: (args, cwd, ceiling, options) => {
        calls.push(args);
        return runGitRaw(args, cwd, ceiling, options);
      },
    });
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  describe('listing', () => {
    it('serves the commit, so an uncommitted edit is invisible', async () => {
      await put('ROOM.md', '# Release train\n');
      await commit('seed');
      // Now dirty the checkout the way a half-finished agent turn would.
      await put('ROOM.md', '# HALF WRITTEN');
      await put('scratch.txt', 'not committed');

      const listed = await service.list(ROOM_ID);

      expect(listed.entries.map((e) => e.name)).toEqual(['ROOM.md']);
      const roomMd = await service.read(ROOM_ID, 'ROOM.md');
      expect(roomMd.body).toEqual({ kind: 'text', encoding: 'utf-8', text: '# Release train\n' });
    });

    it('names each entry, its kind, its size and who last touched it', async () => {
      await put('ROOM.md', 'hello\n');
      await put('docs/one.md', 'one\n');
      const first = await commit('Start this room’s files', 'Dorian');
      await put('docs/two.md', 'two\n');
      const second = await commit('Add the second note', 'Ana');

      const root = await service.list(ROOM_ID);
      expect(root.commit).toBe(second);
      expect(root.path).toBe('');
      expect(root.entries.map((e) => [e.name, e.kind])).toEqual([
        ['docs', 'dir'],
        ['ROOM.md', 'file'],
      ]);
      expect(root.entries.find((e) => e.name === 'ROOM.md')).toMatchObject({
        path: 'ROOM.md',
        size: 6,
        lastCommit: { sha: first, author: 'Dorian', subject: 'Start this room’s files' },
      });
      // The DIRECTORY's provenance is the newest commit touching anything in it.
      expect(root.entries.find((e) => e.name === 'docs')?.lastCommit).toMatchObject({
        sha: second,
        author: 'Ana',
      });

      const docs = await service.list(ROOM_ID, 'docs');
      expect(docs.path).toBe('docs');
      expect(docs.entries.map((e) => [e.name, e.path])).toEqual([
        ['one.md', 'docs/one.md'],
        ['two.md', 'docs/two.md'],
      ]);
      expect(docs.entries[0].lastCommit).toMatchObject({
        sha: first,
        subject: 'Start this room’s files',
      });
      expect(docs.entries[1].lastCommit).toMatchObject({
        sha: second,
        subject: 'Add the second note',
      });
      expect(docs.entries[0].lastCommit?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('lists a symlink as a link and never as what it points at', async () => {
      await put('ROOM.md', 'hello\n');
      await symlink('/etc/passwd', path.join(repoDir, 'secrets'));
      await commit('link it');

      const listed = await service.list(ROOM_ID);

      const link = listed.entries.find((e) => e.name === 'secrets');
      expect(link?.kind).toBe('symlink');
      // Its size is the length of the path it names — all a link stores.
      expect(link?.size).toBe('/etc/passwd'.length);
    });

    it('answers an empty repo honestly rather than failing', async () => {
      const listed = await service.list(ROOM_ID);
      expect(listed).toEqual({ path: '', commit: null, entries: [] });
      await expect(service.list(ROOM_ID, 'docs')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
    });

    it('refuses to list something that is not a directory', async () => {
      await put('ROOM.md', 'hello\n');
      await symlink('..', path.join(repoDir, 'up'));
      await commit('seed');

      await expect(service.list(ROOM_ID, 'ROOM.md')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_READABLE',
      });
      // The link points at the parent of the repo. Following it would list the
      // DorkOS data directory; refusing it is the whole rule.
      await expect(service.list(ROOM_ID, 'up')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_READABLE',
      });
      await expect(service.list(ROOM_ID, 'nope')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
    });

    it('answers a room with no files as a room with no files', async () => {
      hasRepo = false;
      await expect(service.list(ROOM_ID)).rejects.toMatchObject({ code: 'ROOM_HAS_NO_REPO' });
      await expect(service.read(ROOM_ID, 'ROOM.md')).rejects.toMatchObject({
        code: 'ROOM_HAS_NO_REPO',
      });
    });
  });

  describe('path safety', () => {
    it.each([
      ['..', 'the bare parent'],
      ['../../etc/passwd', 'a traversal'],
      ['docs/../../secrets', 'a traversal in the middle'],
      ['/etc/passwd', 'an absolute path'],
      ['C:\\Windows\\win.ini', 'a drive'],
      ['docs\\..\\..\\secrets', 'backslashes'],
      ['docs//two.md', 'an empty part'],
      ['docs/\u0000two.md', 'a NUL'],
      ['docs/two\u001f.md', 'a control character'],
    ])('refuses %s (%s) before git is asked anything', async (bad) => {
      await put('ROOM.md', 'hello\n');
      await commit('seed');
      calls = [];

      await expect(service.list(ROOM_ID, bad)).rejects.toMatchObject({
        code: 'ROOM_FILE_PATH_INVALID',
      });
      await expect(service.read(ROOM_ID, bad)).rejects.toMatchObject({
        code: 'ROOM_FILE_PATH_INVALID',
      });
      // The claim is not just "refused": it is refused with no process spawned.
      expect(calls).toEqual([]);
    });

    it('accepts the harmless spellings of the root', () => {
      expect(normalizeRoomFilePath(undefined)).toBe('');
      expect(normalizeRoomFilePath('')).toBe('');
      expect(normalizeRoomFilePath('.')).toBe('');
      expect(normalizeRoomFilePath('docs/')).toBe('docs');
    });

    it('cannot reach .git, because it is not in the tree', async () => {
      await put('ROOM.md', 'hello\n');
      await commit('seed');

      await expect(service.list(ROOM_ID, '.git')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
      await expect(service.read(ROOM_ID, '.git/config')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
    });

    it('takes a filename that would otherwise be a pathspec pattern literally', async () => {
      await put('star*.md', 'starred\n');
      await put('other.md', 'other\n');
      await commit('seed');

      const read = await service.read(ROOM_ID, 'star*.md');
      expect(read.body).toEqual({ kind: 'text', encoding: 'utf-8', text: 'starred\n' });
    });
  });

  describe('reading', () => {
    it('answers text exactly as committed, trailing newline included', async () => {
      await put('notes.md', '  padded  \n\n');
      const sha = await commit('seed', 'Ana');

      const read = await service.read(ROOM_ID, 'notes.md');

      expect(read).toMatchObject({
        path: 'notes.md',
        commit: sha,
        size: 12,
        body: { kind: 'text', encoding: 'utf-8', text: '  padded  \n\n' },
        lastCommit: { sha, author: 'Ana', subject: 'seed' },
      });
    });

    it('answers a binary file as binary, and never as text', async () => {
      await put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
      await commit('seed');

      const read = await service.read(ROOM_ID, 'logo.png');

      expect(read.body).toEqual({ kind: 'binary' });
      expect(read.size).toBe(7);
      expect(JSON.stringify(read)).not.toContain('PNG');
    });

    it('answers an over-cap file with its size and the ceiling, and no bytes', async () => {
      await put('big.txt', 'x'.repeat(2048));
      await commit('seed');
      maxFileBytes = 1024;

      const read = await service.read(ROOM_ID, 'big.txt');

      expect(read.body).toEqual({ kind: 'too-large', maxBytes: 1024 });
      expect(read.size).toBe(2048);
      expect(JSON.stringify(read)).not.toContain('xxx');
      // A file at the ceiling still reads: the cap is "larger than", not "at".
      maxFileBytes = 2048;
      expect((await service.read(ROOM_ID, 'big.txt')).body).toMatchObject({ kind: 'text' });
    });

    it('refuses to follow a symlink, whatever it points at', async () => {
      await put('ROOM.md', 'hello\n');
      await symlink('/etc/passwd', path.join(repoDir, 'secrets'));
      await symlink('ROOM.md', path.join(repoDir, 'inside'));
      await commit('seed');

      for (const link of ['secrets', 'inside']) {
        const refusal = await service.read(ROOM_ID, link).catch((err: unknown) => err);
        expect(refusal).toBeInstanceOf(RoomError);
        expect((refusal as RoomError).code).toBe('ROOM_FILE_NOT_READABLE');
        expect((refusal as RoomError).message).toContain('link');
      }
    });

    it('refuses a directory and the root', async () => {
      await put('docs/one.md', 'one\n');
      await commit('seed');

      await expect(service.read(ROOM_ID, 'docs')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_READABLE',
      });
      await expect(service.read(ROOM_ID, '')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_READABLE',
      });
    });
  });

  describe('provenance cost', () => {
    it('lists a 500-file directory with a handful of git commands, not 500', async () => {
      await put('ROOM.md', 'hello\n');
      for (let i = 0; i < 500; i += 1) {
        await put(`docs/note-${String(i).padStart(3, '0')}.md`, `note ${i}\n`);
      }
      const sha = await commit('five hundred notes');
      calls = [];

      const started = Date.now();
      const listed = await service.list(ROOM_ID, 'docs');
      const elapsedMs = Date.now() - started;

      expect(listed.entries).toHaveLength(500);
      // Every entry is attributed, and the whole listing cost a fixed number of
      // processes: resolve the commit, stat the directory, list it, walk the
      // history once. The naive `git log -1 -- <path>` per entry would be 500
      // more, which is the difference this bound exists to buy.
      expect(calls.length).toBeLessThanOrEqual(4);
      expect(listed.entries.every((e) => e.lastCommit?.sha === sha)).toBe(true);
      expect(elapsedMs).toBeLessThan(5_000);
    });

    it('attributes a file to the newest commit that touched it, not the first', async () => {
      await put('a.md', 'one\n');
      await put('b.md', 'one\n');
      await commit('first', 'Dorian');
      await put('a.md', 'two\n');
      const second = await commit('second', 'Ana');

      const listed = await service.list(ROOM_ID);

      expect(listed.entries.find((e) => e.name === 'a.md')?.lastCommit).toMatchObject({
        sha: second,
        author: 'Ana',
      });
      expect(listed.entries.find((e) => e.name === 'b.md')?.lastCommit?.sha).not.toBe(second);
    });

    it('marks each history walk with a marker the committer could not have predicted', async () => {
      // The walk interleaves DorkOS's own commit fields with member-written
      // FILENAMES, and a filename may hold any byte but NUL and `/` — including
      // whatever a parser keys on. With a fixed marker, committing a file whose
      // name contains it splits the stream where the committer chose, and the
      // files listed after it are attributed to a header they wrote themselves.
      // A marker they cannot predict cannot be spelled, so this asserts the
      // property rather than the parse: two walks, two different markers.
      await put('a.md', 'one\n');
      await commit('seed');
      calls = [];

      await service.list(ROOM_ID);
      await service.list(ROOM_ID);

      const markers = calls
        .filter((args) => args[0] === 'log')
        .map((args) => args.find((a) => a.startsWith('--format='))?.slice(9, 33));
      expect(markers).toHaveLength(2);
      expect(markers[0]).toMatch(/^[0-9a-f]{24}$/);
      expect(markers[0]).not.toBe(markers[1]);
    });

    it('parses a listing whose filenames hold characters a parser might key on', async () => {
      await put('plain.md', 'plain\n');
      await put('odd\nname.md', 'odd\n');
      const sha = await commit('odd names', 'Dorian');

      const listed = await service.list(ROOM_ID);

      expect(listed.entries.map((e) => e.name).sort()).toEqual(['odd\nname.md', 'plain.md']);
      // The odd name must not have eaten its neighbour's provenance.
      expect(listed.entries.find((e) => e.name === 'plain.md')?.lastCommit).toMatchObject({
        sha,
        author: 'Dorian',
        subject: 'odd names',
      });
    });
  });
});
