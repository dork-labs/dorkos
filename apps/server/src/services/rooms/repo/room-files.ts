/**
 * Reading a room's files (spec `project-rooms` §3.9, server half).
 *
 * Read-only, and read out of a COMMIT rather than out of the checkout on disk.
 * That single choice is what most of this module is about, so it is worth
 * saying plainly what it buys:
 *
 * - **A half-written file never leaks.** An agent's editor, a merge in flight,
 *   a stray `git checkout` — none of it is visible here, because `main`'s tip
 *   is resolved once per request and every later question is asked of that
 *   snapshot. The `commit` on every answer says which one, so a reader can tell
 *   two requests apart and a later write can check itself against it.
 * - **`.git` is not reachable, by construction rather than by a rule.** The
 *   repository's own storage is not IN the tree, so no path can name it and
 *   there is no denylist to forget. The same goes for anything git ignores and
 *   anything that was never committed.
 * - **A symlink is a value, not a door.** In a tree a symlink is a blob holding
 *   a path; nothing here resolves it, so a link pointing at `/etc/passwd` lists
 *   as a link and refuses to be read. The alternative — resolving on disk and
 *   then checking the result is inside the repo — is the check that is
 *   forgotten once.
 *
 * ## Path safety
 *
 * Every path is normalised and refused BEFORE git is asked anything
 * ({@link normalizeRoomFilePath}): no `..`, no absolute path, no backslash, no
 * control character. A refused path costs no process. Past that, paths reach
 * git in the two forms that carry no magic — `<sha>:<path>`, where the path is
 * a path and not a pattern, and `:(literal)<path>` pathspecs, where every
 * character means itself.
 *
 * ## Why provenance costs three git processes and not five hundred
 *
 * Every entry in a listing carries the last commit that touched it, which is
 * the obvious `git log -1 -- <path>` per entry — one process per file, so a
 * directory of 500 files spawns 500 gits. Measured on a fixture repo, that is
 * the difference between a listing that answers in milliseconds and one that
 * takes tens of seconds, and it grows with the directory.
 *
 * So provenance comes from ONE walk of the room's history
 * ({@link RoomFilesService.provenanceFor}): `git log --name-only` scoped to the
 * directory, newest first, with each commit's fields marked by a per-call
 * random nonce. Walking newest-first means the FIRST time a name appears is its
 * last commit, so one pass attributes every entry, and a whole listing costs a
 * fixed three or four git processes however many files it holds — pinned by a
 * test that counts them.
 *
 * The nonce is not decoration. The walk's output interleaves DorkOS's own
 * fields with member-written filenames, and a filename may contain any byte but
 * `NUL` and `/` — including whatever separator a parser keys on. A fixed marker
 * would let somebody commit a file whose NAME forges a commit header and so
 * attribute a sibling file to an author who never touched it. A marker the
 * committer cannot predict cannot be forged, which is the same reasoning the
 * per-turn nonce in `room-context-block.ts` rests on.
 *
 * The walk is bounded by {@link PROVENANCE_COMMIT_LIMIT}. Past it, entries
 * nobody touched inside the window answer `lastCommit: null` — an honest "not
 * known here" rather than an unbounded walk of a history the person can grow
 * without limit.
 *
 * @module server/services/rooms/repo/room-files
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  RoomFileCommit,
  RoomFileContentResponse,
  RoomFileEntry,
  RoomFileKind,
  RoomFileListResponse,
} from '@dorkos/shared/room-files';
import { RoomError } from '../room-errors.js';
import { logger } from '../../../lib/logger.js';
import type { RoomRepoStore } from './room-repo-store.js';
import { GitUnavailableError, runGit, runGitRaw } from './room-repo-git.js';

/**
 * How many commits one provenance walk may look at.
 *
 * Module-private: it is a policy this module applies, not a value anything
 * outside it configures. The test that proves the bound rewrites the `-n`
 * argument through the injected runner instead of importing the number, which
 * has the side benefit of proving the argument really reaches git.
 *
 * A ceiling on work, not a statement about how much history matters. A room
 * repo is young and small, so in practice every entry is attributed long before
 * this; a room that outgrows it loses provenance on its oldest untouched files
 * and nothing else.
 */
const PROVENANCE_COMMIT_LIMIT = 1000;

/** The branch a room's files are read from. Always `main` (spec §3.1). */
const DEFAULT_BRANCH = 'main';

/** The field separator inside one commit's header in the provenance walk. */
const FIELD_SEPARATOR = '\u001f';

/**
 * What `%aI` looks like — a strict ISO 8601 instant with an offset.
 *
 * Used to decide whether a parsed record's head really is a commit header. A
 * loose check would be no check: the point is that the two fields git controls
 * are shaped the way git shapes them.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** How git spells "this is a symlink" in a tree. */
const SYMLINK_MODE = '120000';

/** How git spells "this is a pointer at another repository" in a tree. */
const GITLINK_MODE = '160000';

/** The signature {@link RoomFilesService} calls git through. */
export type GitTextRunner = (args: string[], cwd: string, ceilingDir: string) => Promise<string>;

/** The signature {@link RoomFilesService} reads file bytes through. */
export type GitBytesRunner = (
  args: string[],
  cwd: string,
  ceilingDir: string,
  options?: { maxBuffer?: number }
) => Promise<Buffer>;

/** The seams {@link RoomFilesService} needs from the rest of the server. */
export interface RoomFilesServiceDeps {
  /** Where a room's repo lives on disk. */
  store: RoomRepoStore;
  /**
   * Whether this room has files a caller may read right now —
   * `RoomRepoService.hasRepo` in production, which is `false` both for a room
   * that was never given files and for every room while
   * `config.rooms.repo.enabled` is off.
   */
  hasRepo: (roomId: string) => boolean;
  /**
   * The largest file that is answered with its contents, read LIVE from
   * `config.rooms.repo.maxFileBytes`.
   *
   * Deliberately the live setting rather than the caps stored on the room's
   * sidecar: those say what a merge may bring INTO the repo and must not move
   * under a repo that already exists, while this one says how much this server
   * will hold in memory to show somebody a file — so lowering it has to bind
   * the next request, not the next room.
   */
  maxFileBytes: () => number;
  /** Injectable only so a test can count git invocations. */
  runGit?: GitTextRunner;
  /** Injectable only so a test can count git invocations. */
  runGitRaw?: GitBytesRunner;
}

/**
 * Normalise a caller's path and refuse anything that could mean somewhere else.
 *
 * Refused BEFORE git runs, so a hostile path never becomes an argument. The
 * rules, and what each one is actually stopping:
 *
 * - **`..` in any segment** — the classic escape. Rejected rather than
 *   resolved: `a/../../b` resolving to something inside the repo by accident is
 *   not a reason to accept a path that asked to leave it.
 * - **A leading `/`, or a `C:`-style drive** — an absolute path is never
 *   relative to the repo root, whatever it happens to name.
 * - **A backslash** — a Windows separator that a POSIX path parser reads as an
 *   ordinary character, which is how one parser's "filename" becomes another's
 *   "directory".
 * - **Control characters, `NUL` included** — nothing legitimate names a file
 *   with one, and they are the bytes a delimiter-based protocol confuses.
 * - **An empty segment** — `a//b` is a second spelling of one path, and two
 *   spellings of one thing is what a later comparison gets wrong.
 *
 * - **Leading or trailing whitespace** — refused, and this is the rule that was
 *   learned the hard way. The normaliser used to `.trim()` the whole path, and
 *   a filename may legitimately end in a space: with `notes` and `notes ` both
 *   committed, asking for `notes ` was silently rewritten to `notes` and
 *   answered with the OTHER FILE's bytes under a `path` field that named
 *   neither honestly. That is a decoy primitive — commit a padded twin of a
 *   file somebody trusts and their reader serves the wrong one — and it came
 *   entirely from a normaliser that mutated instead of refusing. **Nothing here
 *   rewrites a path any more.** The emptiness test runs on a trimmed COPY; the
 *   value itself is never touched.
 *
 *   The consequence is deliberate and worth stating: a file whose name begins
 *   or ends in whitespace is listed, under its real name, and cannot be opened.
 *   A visible dead end carrying a reason beats a quiet wrong answer.
 *
 * ONE trailing `/` is dropped, because asking for `docs/` is asking for `docs`
 * and every file explorer spells it that way. `docs//` is not that: it is a
 * second spelling with an empty segment in it, and it now refuses exactly as
 * `docs//two.md` does — the two used to disagree.
 *
 * @param raw - The path as the caller sent it. `undefined` or `''` is the root.
 * @returns The path, unchanged but for one optional trailing slash; `''` for the
 *   repo root.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID` when it could mean somewhere else.
 */
export function normalizeRoomFilePath(raw: string | undefined): string {
  const value = raw ?? '';
  if (value === '' || value === '.') return '';

  if (value.length > 4096) refusePath('it is too long');
  // The one place a trimmed copy is consulted, and it decides nothing but the
  // refusal. The value below is the caller's, byte for byte.
  if (value !== value.trim()) refusePath('it starts or ends with a space');
  if (value.includes('\\')) refusePath('it uses backslashes');
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects.
  if (/[\u0000-\u001f\u007f]/.test(value)) refusePath('it contains a control character');
  if (value.startsWith('/')) refusePath('it is absolute');
  if (/^[A-Za-z]:/.test(value)) refusePath('it names a drive');

  // Exactly one, so `docs//` keeps its empty segment and is refused below with
  // every other doubled slash rather than being quietly repaired.
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutTrailingSlash === '') return '';
  const segments = withoutTrailingSlash.split('/');
  for (const segment of segments) {
    if (segment === '') refusePath('it has an empty part');
    if (segment === '..') refusePath('it points outside the room');
    if (segment === '.') refusePath('it has a "." in it');
    if (segment !== segment.trim()) refusePath('one of its parts starts or ends with a space');
  }
  return withoutTrailingSlash;
}

/**
 * Refuse a path, naming what is wrong with it.
 *
 * Its own function rather than a closure inside the normaliser, so every rule
 * refuses in one voice and TypeScript narrows past each call.
 *
 * @param why - The reason, completing "that path is not one this room can have".
 * @throws {RoomError} Always `ROOM_FILE_PATH_INVALID`.
 */
function refusePath(why: string): never {
  throw new RoomError('ROOM_FILE_PATH_INVALID', `That path is not one this room can have: ${why}`);
}

/** One line of `git ls-tree --long`, parsed. */
interface TreeEntry {
  mode: string;
  type: string;
  size: number;
  /** The name exactly as git printed it — a basename or a full path, per call. */
  name: string;
}

/**
 * Parse `git ls-tree -z --long` output.
 *
 * The format is `<mode> SP <type> SP <sha> SP* <size> TAB <name>`, NUL-separated
 * and — because of `-z` — never quoted, which is what makes a name holding a
 * quote or a newline survive intact.
 *
 * @param stdout - Raw stdout from the command.
 * @returns One record per entry.
 */
function parseTreeEntries(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const record of stdout.split('\u0000')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const fields = record.slice(0, tab).split(/\s+/);
    const [mode, type, , size] = fields;
    if (!mode || !type) continue;
    out.push({
      mode,
      type,
      // A tree and a gitlink print `-`; `Number.parseInt` answers `NaN`, and a
      // size of "not applicable" is reported as zero rather than as nothing.
      size: Number.parseInt(size ?? '', 10) || 0,
      name: record.slice(tab + 1),
    });
  }
  return out;
}

/**
 * What kind of thing a tree entry is, from its mode.
 *
 * The MODE and not the type: git calls a symlink a `blob`, exactly as it calls
 * a file one, so a reader that trusts the type follows links.
 *
 * @param entry - The parsed tree line.
 */
function kindOf(entry: TreeEntry): RoomFileKind {
  if (entry.mode === SYMLINK_MODE) return 'symlink';
  if (entry.mode === GITLINK_MODE) return 'submodule';
  return entry.type === 'tree' ? 'dir' : 'file';
}

/** Read-only access to one room's files, as of `main`'s tip. */
export class RoomFilesService {
  private readonly git: GitTextRunner;
  private readonly gitBytes: GitBytesRunner;

  constructor(private readonly deps: RoomFilesServiceDeps) {
    this.git = deps.runGit ?? runGit;
    this.gitBytes = deps.runGitRaw ?? runGitRaw;
  }

  /**
   * List one directory of a room's files, as of `main`'s tip.
   *
   * **Membership is NOT checked here.** It is checked by the caller, one line
   * earlier, through `RoomService.assertCanReadFiles` — the same shape
   * `POST /:id/attachments` takes with `assertCanAttach`, so the room domain
   * keeps one visibility predicate and this module keeps none.
   *
   * @param roomId - The room.
   * @param rawPath - The directory, relative to the repo root. Root by default.
   * @returns The directory's entries, with provenance.
   * @throws {RoomError} `ROOM_HAS_NO_REPO`, `ROOM_FILE_PATH_INVALID`,
   *   `ROOM_FILE_NOT_FOUND`, `ROOM_FILE_NOT_READABLE`, or
   *   `ROOM_REPO_GIT_UNAVAILABLE`.
   */
  async list(roomId: string, rawPath?: string): Promise<RoomFileListResponse> {
    await this.requireRepo(roomId);
    const dir = normalizeRoomFilePath(rawPath);

    return this.translatingGitAbsence(async () => {
      const commit = await this.resolveCommit(roomId);
      if (!commit) {
        // A repo with no commits. The root of it is honestly empty; anything
        // deeper is honestly not there.
        if (dir === '') return { path: '', commit: null, entries: [] };
        throw new RoomError('ROOM_FILE_NOT_FOUND', 'No such file in this room');
      }

      if (dir !== '') {
        const entry = await this.statPath(roomId, commit, dir);
        if (!entry) throw new RoomError('ROOM_FILE_NOT_FOUND', 'No such file in this room');
        const kind = kindOf(entry);
        if (kind !== 'dir') {
          throw new RoomError(
            'ROOM_FILE_NOT_READABLE',
            kind === 'symlink'
              ? 'That is a link, not a folder. DorkOS does not follow links out of a room.'
              : 'That is a file, not a folder.'
          );
        }
      }

      const listed = parseTreeEntries(
        await this.git(
          ['ls-tree', '-z', '--long', dir === '' ? commit : `${commit}:${dir}`],
          this.repoDir(roomId),
          this.ceiling(roomId)
        )
      );

      const provenance = await this.provenanceFor(roomId, commit, dir, listed);
      const entries: RoomFileEntry[] = listed.map((entry) => ({
        name: entry.name,
        path: dir === '' ? entry.name : `${dir}/${entry.name}`,
        kind: kindOf(entry),
        size: entry.size,
        lastCommit: provenance.get(entry.name) ?? null,
      }));
      // Directories first, then code-unit order — deliberately NOT
      // `localeCompare`, whose answer depends on the machine's ICU data and
      // locale, so one room would list in two orders on two computers and a
      // client diffing two listings would see phantom moves.
      entries.sort((a, b) => {
        const aDir = a.kind === 'dir' ? 0 : 1;
        const bDir = b.kind === 'dir' ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });

      return { path: dir, commit, entries };
    });
  }

  /**
   * Read one file out of `main`'s tip.
   *
   * Three honest outcomes and no fourth: the text, "this is binary", or "this
   * is over the ceiling". The ceiling is checked against the SIZE git already
   * knows, before a byte is read, so an enormous file costs nothing to refuse.
   * Binary is a `NUL` anywhere in the contents — git's own test, and the one
   * `GET /api/files/content` already applies to a session's files.
   *
   * A directory, a symlink and a submodule are all refused: none of them is a
   * file, and a link in particular is never followed (see the module doc).
   *
   * Membership is the caller's to check, exactly as in
   * {@link RoomFilesService.list}.
   *
   * @param roomId - The room.
   * @param rawPath - The file, relative to the repo root.
   * @returns The file, or the reason its bytes are not here.
   * @throws {RoomError} `ROOM_HAS_NO_REPO`, `ROOM_FILE_PATH_INVALID`,
   *   `ROOM_FILE_NOT_FOUND`, `ROOM_FILE_NOT_READABLE`, or
   *   `ROOM_REPO_GIT_UNAVAILABLE`.
   */
  async read(roomId: string, rawPath: string): Promise<RoomFileContentResponse> {
    await this.requireRepo(roomId);
    const filePath = normalizeRoomFilePath(rawPath);
    if (filePath === '') {
      throw new RoomError('ROOM_FILE_NOT_READABLE', 'That is the whole room, not a file in it.');
    }

    return this.translatingGitAbsence(async () => {
      const commit = await this.resolveCommit(roomId);
      if (!commit) throw new RoomError('ROOM_FILE_NOT_FOUND', 'No such file in this room');

      const entry = await this.statPath(roomId, commit, filePath);
      if (!entry) throw new RoomError('ROOM_FILE_NOT_FOUND', 'No such file in this room');

      const kind = kindOf(entry);
      if (kind !== 'file') {
        throw new RoomError(
          'ROOM_FILE_NOT_READABLE',
          kind === 'symlink'
            ? 'That is a link, not a file. DorkOS does not follow links out of a room.'
            : kind === 'submodule'
              ? 'That is another repository inside this one, not a file.'
              : 'That is a folder, not a file.'
        );
      }

      const lastCommit =
        (await this.provenanceFor(roomId, commit, parentOf(filePath), [entry])).get(
          basenameOf(filePath)
        ) ?? null;

      const maxBytes = this.deps.maxFileBytes();
      if (entry.size > maxBytes) {
        return {
          path: filePath,
          commit,
          size: entry.size,
          lastCommit,
          body: { kind: 'too-large' as const, maxBytes },
        };
      }

      const bytes = await this.gitBytes(
        ['cat-file', 'blob', `${commit}:${filePath}`],
        this.repoDir(roomId),
        this.ceiling(roomId),
        // The size is already known and under the ceiling, so this is a
        // backstop against a blob that grew between the two calls rather than
        // the cap itself. `+ 1024` leaves room for nothing in particular; it is
        // slack, not a budget.
        { maxBuffer: maxBytes + 1024 }
      );

      if (bytes.includes(0)) {
        return {
          path: filePath,
          commit,
          size: entry.size,
          lastCommit,
          body: { kind: 'binary' as const },
        };
      }

      return {
        path: filePath,
        commit,
        size: entry.size,
        lastCommit,
        body: { kind: 'text' as const, encoding: 'utf-8' as const, text: bytes.toString('utf-8') },
      };
    });
  }

  /**
   * Refuse a room that has no files to read.
   *
   * **Called AFTER the caller's membership has been checked, never before.** A
   * non-member must not be able to tell a room with files from one without, so
   * the 404 that answers "not a member" has to come first; by the time this
   * runs, the caller is somebody the room admits.
   *
   * The same refusal covers a room that was never given files and every room on
   * an install where the feature is switched off, because `hasRepo` is one
   * predicate over both — which is what makes `enabled: false` behave as "every
   * room is a room without files" rather than as a second, differently-shaped
   * kind of no.
   *
   * @param roomId - The room.
   * @throws {RoomError} `ROOM_HAS_NO_REPO`.
   */
  private async requireRepo(roomId: string): Promise<void> {
    const missing = (): never => {
      throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
    };
    if (!this.deps.hasRepo(roomId)) missing();
    // **And the repo is really there.** A binding without a repo behind it is a
    // reachable state, not a hypothetical: `RoomRepoService.enable` writes the
    // sidecar BEFORE it creates the checkout, so a process killed between them
    // leaves a room that says it has files and has none. It heals on the next
    // enable — but until then git would be spawned with a cwd that does not
    // exist, and `execFile` reports THAT as `ENOENT` too, which this module
    // would otherwise report to the person as "git is not installed".
    try {
      await fs.stat(path.join(this.repoDir(roomId), '.git'));
    } catch {
      logger.warn('[rooms] a room repo binding has no repo behind it', { roomId });
      missing();
    }
  }

  /** The room's main checkout. */
  private repoDir(roomId: string): string {
    return this.deps.store.repoPath(roomId);
  }

  /**
   * The directory git's repository search may not climb past.
   *
   * Never omitted, and never anything wider than the room's own home: without
   * it a room whose `repo/` is missing answers for whatever repository encloses
   * the DorkOS data directory — in dev, the dorkos checkout — and this API
   * would serve that repository's files as the room's. See `room-repo-git.ts`.
   *
   * @param roomId - The room.
   */
  private ceiling(roomId: string): string {
    return this.deps.store.homeDir(roomId);
  }

  /**
   * The commit `main` points at, or `null` when the repo has no commits.
   *
   * Resolved ONCE per request and threaded through every later call, so a merge
   * landing mid-request cannot make one listing describe two trees.
   *
   * @param roomId - The room.
   * @returns The full sha, or `null`.
   */
  private async resolveCommit(roomId: string): Promise<string | null> {
    try {
      return await this.git(
        ['rev-parse', '--verify', '--quiet', `refs/heads/${DEFAULT_BRANCH}^{commit}`],
        this.repoDir(roomId),
        this.ceiling(roomId)
      );
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      // `--verify --quiet` exits 1 with no output for a ref that is not there,
      // which is a repo whose first commit has not happened. Anything else is
      // not this question's to swallow.
      if ((err as { code?: unknown })?.code === 1) return null;
      throw err;
    }
  }

  /**
   * One path's tree entry at `commit`, or `null` when it is not in the tree.
   *
   * `:(literal)` on the pathspec, so every character in a member's filename
   * means itself — without it a file called `*` matches its whole directory and
   * a file called `!x` means "not x".
   *
   * @param roomId - The room.
   * @param commit - The commit to look in.
   * @param filePath - A normalised repo-relative path.
   */
  private async statPath(
    roomId: string,
    commit: string,
    filePath: string
  ): Promise<TreeEntry | null> {
    const lines = parseTreeEntries(
      await this.git(
        ['ls-tree', '-z', '--long', commit, '--', `:(literal)${filePath}`],
        this.repoDir(roomId),
        this.ceiling(roomId)
      )
    );
    return lines[0] ?? null;
  }

  /**
   * The last commit that touched each of `entries`, from ONE history walk.
   *
   * Newest-first, so the first appearance of a name is its answer; bounded by
   * {@link PROVENANCE_COMMIT_LIMIT}; scoped to the directory being listed, so a
   * busy sibling directory costs nothing.
   *
   * **A failure here is not a failure of the listing.** Provenance is a column,
   * not the content: a walk that blows its output cap or trips over a history
   * git cannot read is logged and answered as "unknown" for every entry, rather
   * than taking the file list down with it.
   *
   * @param roomId - The room.
   * @param commit - The commit to walk back from.
   * @param dir - The directory being listed, `''` for the root.
   * @param entries - The entries needing attribution.
   * @returns Entry name to its last commit, missing where unknown.
   */
  private async provenanceFor(
    roomId: string,
    commit: string,
    dir: string,
    entries: readonly TreeEntry[]
  ): Promise<Map<string, RoomFileCommit>> {
    const found = new Map<string, RoomFileCommit>();
    if (entries.length === 0) return found;

    // Unpredictable per call, so a member-written FILENAME cannot forge a
    // commit header and attribute somebody else's file to an author who never
    // touched it. See the module doc.
    const nonce = randomBytes(12).toString('hex');
    const wanted = new Set(entries.map((entry) => basenameOf(entry.name)));

    let stdout: string;
    try {
      stdout = await this.git(
        [
          'log',
          '-z',
          '--name-only',
          '--no-renames',
          `--format=${nonce}%H${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%s`,
          `-n`,
          String(PROVENANCE_COMMIT_LIMIT),
          commit,
          ...(dir === '' ? [] : ['--', `:(literal)${dir}/`]),
        ],
        this.repoDir(roomId),
        this.ceiling(roomId)
      );
    } catch (err) {
      if (err instanceof GitUnavailableError) throw err;
      logger.warn('[rooms] could not read file provenance; listing without it', { roomId, err });
      return found;
    }

    const prefix = dir === '' ? '' : `${dir}/`;
    for (const record of stdout.split(nonce)) {
      if (record === '') continue;
      const parts = record.split('\u0000');
      const header = parts[0] ?? '';
      const fields = header.split(FIELD_SEPARATOR);
      const [sha, at, author] = fields;
      // **The two machine-shaped fields are checked, not assumed.** `%H` and
      // `%aI` are git's own and cannot hold the separator; the AUTHOR NAME can,
      // because a commit made in an agent's worktree carries whatever
      // `user.name` that tree was given. `commitAll` strips control characters
      // on the way in, so this is the second of two closures rather than the
      // only one — and a record whose head is not a sha and a timestamp is
      // dropped rather than half-read.
      const subject = fields.slice(3).join(FIELD_SEPARATOR);
      if (!sha || !at || !/^[0-9a-f]{40}$/.test(sha) || !ISO_TIMESTAMP.test(at)) continue;

      // **Exactly one leading newline, and only from the FIRST name.** git's
      // `-z --name-only` layout is `<header>NUL LF <path>NUL<path>NUL…`: that
      // line feed is a separator that appears once per record, before the first
      // path and nowhere else. Stripping `/^\n+/` from every part instead ate
      // the first character of a filename that legitimately BEGINS with a
      // newline — and a filename may. Proven: a file named "\nplain.md" read as
      // "plain.md" and handed its neighbour's row the forger's commit.
      for (const [index, raw] of parts.slice(1).entries()) {
        const changed = index === 0 && raw.startsWith('\n') ? raw.slice(1) : raw;
        if (changed === '' || !changed.startsWith(prefix)) continue;
        const name = changed.slice(prefix.length).split('/')[0];
        if (!name || !wanted.has(name) || found.has(name)) continue;
        found.set(name, { sha, author: author ?? '', at, subject });
      }
      if (found.size === wanted.size) break;
    }
    return found;
  }

  /**
   * Turn "this machine has no git" into the room domain's own refusal.
   *
   * A room's files ARE a git repository, so a missing binary is not a 500: the
   * request was well formed, nothing is broken, and installing a program is
   * what changes the answer. The same code and the same sentence the enable
   * path already gives.
   *
   * @param work - The git-touching body.
   * @returns Whatever `work` answers.
   */
  private async translatingGitAbsence<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof GitUnavailableError) {
        throw new RoomError(
          'ROOM_REPO_GIT_UNAVAILABLE',
          'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
        );
      }
      throw err;
    }
  }
}

/**
 * The directory part of a normalised path, `''` at the root.
 *
 * @param filePath - A normalised repo-relative path.
 */
function parentOf(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? '' : filePath.slice(0, cut);
}

/**
 * The last segment of a path.
 *
 * `path.basename` is deliberately not used: this operates on repo paths, which
 * are `/`-separated on every platform, and the node helper would split on `\`
 * as well on Windows — turning one legitimate filename into two segments.
 *
 * @param filePath - A `/`-separated path.
 */
function basenameOf(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? filePath : filePath.slice(cut + 1);
}
