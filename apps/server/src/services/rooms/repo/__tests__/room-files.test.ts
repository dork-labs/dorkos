/**
 * Reading a room's files (spec `project-rooms` §3.9).
 *
 * Real git, on a temporary DorkOS home prepared by fixture-only commands.
 * Finite production reads delegate unchanged except the explicit provenance
 * fault control. No injected raw runner can replace security observations; every
 * claim under test is about what git actually answers: what a tree holds, which
 * commit last touched a path, and what a symlink is when you refuse to follow
 * it.
 *
 * **The fixture home sits inside an enclosing git repository on purpose**, and
 * it is worth being exact about what that still buys now that `requireRepo`
 * stats `repo/.git` before anything spawns. It mirrors the dev layout
 * (`apps/server/.temp/.dork/` lives inside the dorkos checkout), and it is what
 * makes the two degraded-repo tests mean something rather than pass by
 * accident: with a `repo/` that exists but holds no `.git`, a git command run
 * without a discovery ceiling walks UP, finds the enclosing repository, and
 * answers happily — so a room would serve the dorkos checkout's files as its
 * own. The enclosing repo ignores everything and has a commit of its own, so it
 * reads clean: exactly the answer that would let a ceiling-less read believe it
 * was looking at the room. Remove the ceiling and "a repo directory with no git
 * in it" turns green for the wrong reason.
 *
 * Historical predecessor seeded defects (this successor is UNRUN):
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
 * - Stripping `/^\n+/` from every path part, rather than one `\n` from the
 *   first, reddens the leading-newline forgery test.
 * - `.trim()`ing the path reddens the padded-twin test AND the round trip.
 * - Dropping `stripControlCharacters` from `commitAll` reddens the hostile
 *   author test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDb } from '@dorkos/test-utils/db';
import { rooms, type Db } from '@dorkos/db';
import { RoomError } from '../../data/room-errors.js';
import { RoomRepoStore } from '../room-repo-store.js';
import { RoomFilesService, normalizeRoomFilePath } from '../room-files.js';
import { commitAll } from '../room-repo-git.js';
import {
  fixtureGit,
  fixtureGitFastImport,
  removeFixtureTree,
  silenceGitAutoMaintenance,
} from './fixture-git.js';
import { createOriginalOwnedRoomFixture } from './room-original-owned-fixture.js';
import {
  readInstallationRoomMutationContext,
  withRecognizedInstallationRoomNamespace,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { logger } from '../../../../lib/logger.js';

/** Observe the actual finite readers; this cannot supply arbitrary Git argv. */
const reads = vi.hoisted(() => ({
  calls: [] as string[][],
  contentBudgets: [] as number[],
  failProvenance: false,
}));
// Observe the actual child-process cut before the heavy Room module graph can
// capture its original finite readers. No caller supplies or changes Git argv.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const originalPromisified = promisify(real.execFile);
  const observe = (
    file: string,
    argv: readonly string[] | null | undefined,
    options: import('node:child_process').ExecFileOptions | null | undefined
  ) => {
    if (
      file === 'git' &&
      Array.isArray(argv) &&
      options?.encoding === 'buffer' &&
      options.env?.GIT_OPTIONAL_LOCKS === '0'
    ) {
      const index = argv.findIndex((part) =>
        ['rev-parse', 'ls-tree', 'cat-file', 'log'].includes(part)
      );
      const command = argv.slice(index);
      if (index >= 0 && command[0] === 'rev-parse') reads.calls.push(['rev-parse', command[2]]);
      if (index >= 0 && command[0] === 'ls-tree') reads.calls.push(['ls-tree', command[3]]);
      if (index >= 0 && command[0] === 'cat-file' && command[1] === 'blob') {
        reads.calls.push(['cat-file', command[2]]);
        if (typeof options.maxBuffer === 'number') reads.contentBudgets.push(options.maxBuffer);
      }
      if (index >= 0 && command[0] === 'log') {
        const format = command.find((part) => part.startsWith('--format='));
        const nonce = format && /^--format=([0-9a-f]{24})%H/.exec(format)?.[1];
        if (nonce) {
          const count = command.indexOf('1000');
          reads.calls.push(['log', command[count + 1], '', nonce]);
          if (reads.failProvenance) {
            const error = new Error('stdout maxBuffer length exceeded');
            (error as NodeJS.ErrnoException).code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
            throw error;
          }
        }
      }
    }
  };
  const execFile = (...args: Parameters<typeof real.execFile>) => {
    observe(args[0], args[1], args[2]);
    return real.execFile(...args);
  };
  // Preserve Node's actual multi-result Promise and original acquired ChildProcess.
  // Default promisify on a plain wrapper would lose { stdout, stderr }.
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: Parameters<typeof originalPromisified>) => {
      observe(args[0], args[1], args[2]);
      return originalPromisified(...args);
    },
  });
  return { ...real, execFile };
});

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
  /** Every finite production read requested by the service during one test. */
  const calls = reads.calls;

  /** Run git in the room's repo, with the room's home as the ceiling. */
  function git(args: string[], dir = repoDir): Promise<string> {
    return fixtureGit(args, dir, store.homeDir(ROOM_ID));
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

  /** Actual production finite reads are observed at their module boundary. */
  function makeService(): RoomFilesService {
    return new RoomFilesService({
      store,
      hasRepo: () => hasRepo,
      maxFileBytes: () => maxFileBytes,
    });
  }

  beforeEach(async () => {
    scratch = '';
    reads.calls.length = 0;
    reads.contentBudgets.length = 0;
    reads.failProvenance = false;
    db = createTestDb();
    // Before any repo exists: a `git commit` otherwise leaves a DETACHED
    // maintenance process writing into `.git` after it returns, and this
    // suite's teardown deletes that directory. See `fixture-git.ts`.
    silenceGitAutoMaintenance();
    scratch = await mkdtemp(path.join(await realpath(tmpdir()), 'dorkos-room-files-'));
    // The enclosing repository — see the module doc. It ignores everything and
    // has a commit of its own, so it reads clean: exactly the answer that would
    // make a ceiling-less read believe it was looking at the room.
    await fixtureGit(['init', '-b', 'main', '--quiet', '.'], scratch, scratch);
    await writeFile(path.join(scratch, '.gitignore'), '*\n', 'utf-8');
    await fixtureGit(['add', '-f', '.gitignore'], scratch, scratch);
    await fixtureGit(
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
    calls.length = 0;
    service = makeService();
  });

  afterEach(async () => {
    let failed = false,
      cause: unknown;
    try {
      if (db?.$client.open) db.$client.close();
    } catch (error) {
      failed = true;
      cause = error;
    }
    try {
      if (scratch) await removeFixtureTree(scratch);
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
    reads.failProvenance = false;
    if (failed) throw cause;
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

    it('answers a binding whose repo never got made as a room with no files', async () => {
      // Reachable, not hypothetical: the enable path writes the sidecar BEFORE
      // it creates the checkout. Without this guard git is spawned with a cwd
      // that does not exist, and `execFile` spells that ENOENT — the same code
      // a missing git binary has — so the person would be told to install a
      // program they already have.
      await rm(repoDir, { recursive: true, force: true });

      await expect(service.list(ROOM_ID)).rejects.toMatchObject({ code: 'ROOM_HAS_NO_REPO' });
      await expect(service.read(ROOM_ID, 'ROOM.md')).rejects.toMatchObject({
        code: 'ROOM_HAS_NO_REPO',
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
      calls.length = 0;

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

      calls.length = 0;
      await expect(service.list(ROOM_ID, '.git')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
      await expect(service.read(ROOM_ID, '.git/config')).rejects.toMatchObject({
        code: 'ROOM_FILE_NOT_FOUND',
      });
      // Every public read family refuses normalized repository metadata before
      // any Git read, retaining typed 404 rather than leaking a private guard error.
      for (const metadataPath of ['.git', '.git/', '.git/config', '.git/objects/pack']) {
        await expect(service.list(ROOM_ID, metadataPath)).rejects.toMatchObject({
          code: 'ROOM_FILE_NOT_FOUND',
        });
        await expect(service.read(ROOM_ID, metadataPath)).rejects.toMatchObject({
          code: 'ROOM_FILE_NOT_FOUND',
        });
        await expect(service.lastCommitFor(ROOM_ID, metadataPath)).rejects.toMatchObject({
          code: 'ROOM_FILE_NOT_FOUND',
        });
      }
      expect(calls).toEqual([]);
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
      expect(reads.contentBudgets).toEqual([]);
      // A file at the ceiling still reads: the cap is "larger than", not "at".
      maxFileBytes = 2048;
      expect((await service.read(ROOM_ID, 'big.txt')).body).toMatchObject({ kind: 'text' });
      expect(reads.contentBudgets).toEqual([2048 + 1024]);
      expect(calls.filter(([verb]) => verb === 'cat-file')).toHaveLength(1);
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
      calls.length = 0;

      const started = Date.now();
      const listed = await service.list(ROOM_ID, 'docs');
      const elapsedMs = Date.now() - started;

      expect(listed.entries).toHaveLength(500);
      // Every entry is attributed, and the whole listing cost a fixed number of
      // finite reads: resolve the commit, stat the directory, list it, walk the
      // history once. The naive `git log -1 -- <path>` per entry would be 500
      // more, which is the difference this bound exists to buy.
      expect(calls).toHaveLength(4);
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
      calls.length = 0;

      await service.list(ROOM_ID);
      await service.list(ROOM_ID);

      const markers = calls.filter((args) => args[0] === 'log').map((args) => args[3]);
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
  describe('what a hostile name cannot do', () => {
    it("cannot steal a neighbour's provenance with a leading newline", async () => {
      // git's `-z --name-only` layout puts ONE line feed between a commit's
      // header and its first path. A filename may itself begin with a newline,
      // so a parser that strips `/^\\n+/` eats the real first character and reads
      // "\\nplain.md" as "plain.md" — handing the victim's row the forger's
      // commit. Proven before the fix: plain.md was attributed to Attacker.
      await put('plain.md', 'victim\n');
      const honest = await commit('victim commit', 'Dorian');
      await put('\nplain.md', 'forged\n');
      await commit('forger commit', 'Attacker');

      const listed = await service.list(ROOM_ID);

      expect(listed.entries.find((e) => e.name === 'plain.md')?.lastCommit).toMatchObject({
        sha: honest,
        author: 'Dorian',
        subject: 'victim commit',
      });
      // And the forger's own file keeps its own name and its own commit.
      expect(listed.entries.find((e) => e.name === '\nplain.md')?.lastCommit).toMatchObject({
        author: 'Attacker',
      });
    });

    it("cannot serve a neighbour's bytes through a padded twin", async () => {
      // A filename may end in a space. Trimming the REQUEST silently rewrote
      // "notes " to "notes" and answered with the other file's contents under a
      // path field that named neither honestly — a decoy primitive. Proven
      // before the fix: reading "notes " returned SECRET-INNOCENT.
      await put('notes', 'SECRET-INNOCENT\n');
      await put('notes ', 'DECOY\n');
      await commit('both', 'Dorian');

      const refusal = await service.read(ROOM_ID, 'notes ').catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(RoomError);
      expect((refusal as RoomError).code).toBe('ROOM_FILE_PATH_INVALID');
      // The claim that matters is not the code: it is that the OTHER file's
      // bytes were not what came back.
      expect(JSON.stringify(refusal)).not.toContain('SECRET-INNOCENT');
      // The padded name is still listed, under its real name — a visible dead
      // end rather than a quiet wrong answer.
      const listed = await service.list(ROOM_ID);
      expect(listed.entries.map((e) => e.name)).toContain('notes ');
      // And the honest neighbour still reads as itself.
      expect((await service.read(ROOM_ID, 'notes')).body).toMatchObject({
        text: 'SECRET-INNOCENT\n',
      });
    });

    it('sanitizes a hostile identity in actual lowlevel commitAll under original owning exclusion', async () => {
      // Genuine original construction and a recognized scope supply exclusion,
      // not user/HTTP permission. No fixture DTO can manufacture the context.
      const fixture = await createOriginalOwnedRoomFixture({ nativeDatabase: true });
      let failed = false;
      // Join this scope to its captured cleanup before returning or reporting failure.
      const drainOriginalCleanup = async () => {
        try {
          await fixture.close();
        } catch (error) {
          if (!failed) throw error;
        }
      };
      try {
        const target = fixture.repos.repoPath(fixture.roomId);
        await writeFile(path.join(target, 'a.md'), 'one\n');
        await withRecognizedInstallationRoomNamespace(
          fixture.writer,
          fixture.roomId,
          async (scope) => {
            const context = readInstallationRoomMutationContext(
              fixture.writer,
              fixture.roomId,
              scope
            );
            await commitAll(
              target,
              'Real Subject',
              {
                name: 'Ev\u001fil\u001f9999-12-31T00:00:00Z\u001fForged',
                email: 'ev\u001fil@dorkos.local',
              },
              fixture.repos.homeDir(fixture.roomId),
              context
            );
          }
        );
        const listed = await fixture.files.list(fixture.roomId);
        const provenance = listed.entries.find((e) => e.name === 'a.md')?.lastCommit;
        expect(provenance?.subject).toBe('Real Subject');
        expect(provenance?.author).toBe('Evil9999-12-31T00:00:00ZForged');
        expect(provenance?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(provenance?.sha).toMatch(/^[0-9a-f]{40}$/);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        await drainOriginalCleanup();
      }
    });
  });

  describe('every path a listing mints can be read back', () => {
    it('round-trips every entry, identically', async () => {
      // The invariant the padded-twin bug broke: what `list` hands a client is
      // what `read` accepts. Names chosen to be exactly the ones a naive
      // normaliser or an unquoted pathspec mangles.
      const files: Record<string, string> = {
        'plain.md': 'plain\n',
        'star*.md': 'starred\n',
        'br[ack]ets.md': 'bracketed\n',
        '-leading-dash.md': 'dashed\n',
        '#hash.md': 'hashed\n',
        'with space.md': 'spaced\n',
        'ünïcode-Ω.md': 'unicode\n',
        ':colon.md': 'coloned\n',
        '!bang.md': 'banged\n',
        'docs/nested one.md': 'nested\n',
      };
      for (const [name, body] of Object.entries(files)) await put(name, body);
      await commit('every awkward name', 'Dorian');

      const root = await service.list(ROOM_ID);
      const seen: string[] = [];
      for (const entry of root.entries) {
        if (entry.kind === 'dir') {
          for (const child of (await service.list(ROOM_ID, entry.path)).entries) {
            const read = await service.read(ROOM_ID, child.path);
            expect(read.path).toBe(child.path);
            expect(read.body).toEqual({
              kind: 'text',
              encoding: 'utf-8',
              text: files[child.path],
            });
            seen.push(child.path);
          }
          continue;
        }
        const read = await service.read(ROOM_ID, entry.path);
        // The path comes back exactly as it went out — no rewriting anywhere.
        expect(read.path).toBe(entry.path);
        expect(read.size).toBe(entry.size);
        expect(read.body).toEqual({ kind: 'text', encoding: 'utf-8', text: files[entry.path] });
        seen.push(entry.path);
      }
      expect(seen.sort()).toEqual(Object.keys(files).sort());
    });

    it('lists in one order on every machine', async () => {
      // Byte order, never `localeCompare`, whose answer depends on the
      // machine's locale and ICU build — one room would list two ways on two
      // computers and a client diffing listings would see phantom moves.
      // Names that differ by more than case: this repo is tested on a
      // case-INSENSITIVE filesystem, where `A.md` and `a.md` are one file.
      for (const name of ['banana.md', 'Beta.md', 'apple.md', 'Zeta.md', 'zz/keep.md']) {
        await put(name, 'x\n');
      }
      await commit('mixed case', 'Dorian');

      const listed = await service.list(ROOM_ID);

      // Code-unit order puts every capital ahead of every lowercase.
      // `localeCompare` interleaves them — apple, banana, Beta, Zeta — which is
      // what this asserts is NOT happening.
      expect(listed.entries.map((e) => e.name)).toEqual([
        'zz',
        'Beta.md',
        'Zeta.md',
        'apple.md',
        'banana.md',
      ]);
    });

    it('refuses a doubled slash the same way wherever it appears', async () => {
      await put('docs/one.md', 'one\n');
      await commit('seed');

      // One trailing slash is the file-explorer spelling of the same folder.
      expect((await service.list(ROOM_ID, 'docs/')).path).toBe('docs');
      // Two is a second spelling with an empty part in it, and it used to be
      // quietly repaired here while being refused one segment deeper.
      for (const bad of ['docs//', 'docs//one.md', '//docs']) {
        await expect(service.list(ROOM_ID, bad)).rejects.toMatchObject({
          code: 'ROOM_FILE_PATH_INVALID',
        });
      }
    });
  });

  describe('when git will not answer', () => {
    it('says plainly that git is missing, rather than answering 500', async () => {
      await put('ROOM.md', 'hello\n');
      await commit('seed');
      // git is looked up on PATH, so an empty PATH is a machine without it.
      // `vi.stubEnv` rather than assigning, so vitest unwinds it even if the
      // call throws — an escaped empty PATH breaks every later test in this
      // worker that spawns anything.
      vi.stubEnv('PATH', '');
      try {
        // Each call is awaited and given its `.rejects` handler before the
        // next one is even created — building an array of both promises
        // first (as `for (const call of [a, b])` would) leaves the second
        // one rejecting with no handler attached until the loop reaches it,
        // which Node can flag as an unhandled rejection under CI timing
        // even though the test goes on to handle it (DOR-1638).
        await expect(service.list(ROOM_ID)).rejects.toMatchObject({
          code: 'ROOM_REPO_GIT_UNAVAILABLE',
        });
        await expect(service.read(ROOM_ID, 'ROOM.md')).rejects.toMatchObject({
          code: 'ROOM_REPO_GIT_UNAVAILABLE',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('lists without provenance rather than not at all when the walk blows its cap', async () => {
      await put('a.md', 'one\n');
      await put('b.md', 'two\n');
      await commit('seed');
      const warn = vi.spyOn(logger, 'warn');
      // The one failure this service is expected to absorb: provenance is a
      // column, not the content, so a history too big for the output ceiling
      // must cost the column and not the file list.
      reads.failProvenance = true;
      try {
        const listed = await service.list(ROOM_ID);
        expect(listed.entries.map((e) => e.name)).toEqual(['a.md', 'b.md']);
        expect(listed.entries.every((e) => e.lastCommit === null)).toBe(true);
        expect(calls.filter(([verb]) => verb === 'log')).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('provenance'),
          expect.objectContaining({ roomId: ROOM_ID })
        );
      } finally {
        reads.failProvenance = false;
        warn.mockRestore();
      }
    });

    it('stops at the actual fixed 1000-commit window without changing production arguments', async () => {
      // One fixture-only native fast-import seeds 1001 commits efficiently.
      // The real finite reader retains its original -n 1000 and output budgets.
      const stream: string[] = ['feature done\n'];
      for (let index = 1; index <= 1001; index++) {
        const message = index === 1 ? 'seed' : 'advance';
        const body = index === 1 ? 'old\n' : `new-${index}\n`;
        stream.push(
          `commit refs/heads/main\nmark :${index}\ncommitter Dorian <d@dorkos.local> ${1700000000 + index} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`
        );
        if (index > 1) stream.push(`from :${index - 1}\n`);
        stream.push(
          `M 100644 inline ${index === 1 ? 'old.md' : 'new.md'}\ndata ${Buffer.byteLength(body)}\n${body}\n`
        );
      }
      stream.push('done\n');
      await fixtureGitFastImport(stream.join(''), repoDir, store.homeDir(ROOM_ID));
      expect(await git(['rev-list', '--count', 'main'])).toBe('1001');
      const newest = await git(['rev-parse', 'main']);
      const listed = await service.list(ROOM_ID);
      expect(listed.entries.map((entry) => entry.name)).toEqual(['new.md', 'old.md']);
      expect(listed.entries.find((entry) => entry.name === 'new.md')?.lastCommit?.sha).toBe(newest);
      expect(listed.entries.find((entry) => entry.name === 'old.md')?.lastCommit).toBeNull();
    });

    it('refuses a repo directory with no git in it, rather than answering for the one around it', async () => {
      // Without the discovery ceiling this is the test that would pass for the
      // wrong reason: git walks up from `repo/`, finds the ENCLOSING repository
      // the fixture deliberately sits in, and lists its files as the room's.
      await rm(path.join(repoDir, '.git'), { recursive: true, force: true });

      await expect(service.list(ROOM_ID)).rejects.toMatchObject({ code: 'ROOM_HAS_NO_REPO' });
    });
  });
});
