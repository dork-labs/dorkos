/**
 * Fetch exactly one commit's tree from a git remote, and say which commit it
 * was (DOR-2248).
 *
 * The package cache is keyed `<name>@<sha>` (ADR-0232) and an install records
 * that SHA as the commit it came from (DOR-147). Both are only true if the SHA
 * is read from the checkout, so this module never trusts a lookup for it:
 *
 * 1. {@link lookupRemoteRef} turns a ref into an exact refname and the commit it
 *    names: a full commit id is itself, `HEAD` is the default branch, a
 *    `refs/…` name is taken as written, and any other name is
 *    `refs/heads/<ref>` before `refs/tags/<ref>` (the order `git clone --branch`
 *    uses), with an annotated tag peeled to its commit. Only exact names count:
 *    `git ls-remote` matches a pattern against the TAIL of every ref, so
 *    `main` also returns `refs/heads/x/main`.
 * 2. {@link fetchTree} fetches that commit by id at depth 1, so a push after
 *    the lookup cannot change what arrives. A server that refuses to serve an
 *    unadvertised commit (protocol v0 without
 *    `uploadpack.allowReachableSHA1InWant`) gets a fallback that is still
 *    exact: the refname the lookup chose, keeping whatever commit arrives; or,
 *    for a pinned commit, every branch and tag, after which the commit must be
 *    present. It then checks the commit out, requires `HEAD` to be it, removes
 *    `.git`, and returns it. That return value is the only commit the cache
 *    will key an entry by.
 *
 * Security posture, the same as every other marketplace git call: the caller
 * has already asked `assertSafeGitRemote`; every spawn is an argv array with
 * {@link hardenedGitEnv}; `--end-of-options` precedes every author-supplied
 * value; the GitHub token goes to a GitHub host only, and git's output is
 * passed through {@link redactAuthTokens} before it reaches a message.
 *
 * How the token travels depends on the git installed (read once per process,
 * see {@link gitAuth}): from 2.31, as {@link gitHubAuthConfig}'s header in the
 * environment (`GIT_CONFIG_COUNT`), on no command line and in no
 * `.git/config`; before 2.31, which cannot read that, embedded in the remote
 * URL by {@link withGitHubToken}, exactly as `execGitClone` always has. That
 * URL lives only in the temporary repository's `.git`, which is removed before
 * the tree is cached, with the temp directory on failure, and by the cache's
 * startup sweep after a crash.
 *
 * Git floor, measured in Docker against this exact command sequence: 2.26
 * through 2.49 pass; 2.24 has no `sparse-checkout`. Two version traps shape
 * the commands. `checkout --detach` rejects `--end-of-options` up to 2.43, so
 * the checkout names the commit bare (it is always a verified full id, never
 * author text). And `sparse-checkout set --cone` does not turn cone mode on
 * before 2.35, so cone mode is set with `sparse-checkout init --cone` first.
 *
 * @module services/marketplace/lib/git-tree
 */
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  CLONE_SIZE_LIMITS,
  PackageTooLargeError,
  measurePackageTree,
} from '@dorkos/marketplace/package-size';
import { GitDownloadTooLargeError, runGit, type GitConfigEntry } from './git-runner.js';
import {
  gitHubAuthConfig,
  isGitHubCredentialHost,
  redactAuthTokens,
  resolveGitAuth,
  withGitHubToken,
} from '../../../core/template-downloader.js';

export { GitDownloadTooLargeError } from './git-runner.js';

/** Max time to wait for `git ls-remote`. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/** Max time for any one git step of a fetch; matches the clone it replaced. */
const GIT_FETCH_TIMEOUT_MS = 120_000;

/**
 * Max time for a whole {@link fetchTree}, every step together (DOR-2321). Each
 * step gets what is left of it, so a server that answers every step just
 * inside {@link GIT_FETCH_TIMEOUT_MS} cannot hold an install for hours across
 * a blobless download's many batches. Ten minutes covers the slowest honest
 * case with room: the full-history fallback for a large repository on a slow
 * connection, then its checkout. A normal package takes seconds.
 */
export const FETCH_DEADLINE_MS = 10 * 60_000;

/** A fetch that ran out of its whole-fetch time ({@link FETCH_DEADLINE_MS}). */
class GitDeadlineError extends Error {
  /** Build the error; the message is the reason a person reads. */
  constructor() {
    super(`the download took longer than ${FETCH_DEADLINE_MS / 60_000} minutes`);
    this.name = 'GitDeadlineError';
  }
}

/** How many blob ids one fetch names; well inside Windows' command-line limit. */
const BLOB_FETCH_BATCH = 500;

/** Everything after it is a value, never a flag (git ≥ 2.24). */
const END_OF_OPTIONS = '--end-of-options';

/** How long a resolved GitHub token is reused before `resolveGitAuth` runs again. */
const AUTH_TTL_MS = 60_000;

/** The remote name the temporary repository fetches through. */
const REMOTE = 'origin';

/** What makes {@link REMOTE} a blob-filtered partial clone. */
const PARTIAL_CLONE_CONFIG = [
  ['core.repositoryformatversion', '1'],
  ['extensions.partialClone', REMOTE],
  [`remote.${REMOTE}.promisor`, 'true'],
  [`remote.${REMOTE}.partialclonefilter`, 'blob:none'],
] as const;

/** A full commit id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase as git prints it. */
const FULL_COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What git prints when a server will not serve a commit it did not advertise. */
const REFUSAL_RE = /unadvertised object|not our ref/i;

/**
 * True when `value` is a full commit id. False for every placeholder the
 * marketplace has ever written in place of one (`tmp-<ms>`, `local`,
 * `relative-path`) and for an abbreviated id.
 *
 * @param value - The candidate commit id.
 */
export function isFullCommitSha(value: string | undefined): value is string {
  return value !== undefined && FULL_COMMIT_SHA_RE.test(value);
}

/** What a ref resolved to on a remote. */
export type RemoteRef =
  /** The commit, and the exact refname that names it; no refname for a pinned commit. */
  | { kind: 'found'; commitSha: string; refName?: string }
  /** The remote answered and has no such branch or tag. */
  | { kind: 'missing' }
  /** git could not ask: no network, no access, no git. */
  | { kind: 'unreachable'; reason: string };

/** One tree fetch: where from, which commit, and where to put it. */
export interface TreeRequest {
  /** The address to fetch from, uncredentialed; this module adds any token. */
  cloneUrl: string;
  /** The commit to fetch, from {@link lookupRemoteRef}. */
  commitSha: string;
  /** The refname the lookup chose; absent for a pinned commit. */
  refName?: string;
  /** The package's directory in the repository; `''` checks out the whole tree. */
  subpath: string;
  /** An existing, empty directory to fetch into. */
  destDir: string;
}

/**
 * The network seam `PackageFetcher` depends on, so tests can replace git with
 * a fake in one place.
 */
export interface GitTreeSource {
  /** Resolve a ref on a remote. See {@link lookupRemoteRef}. */
  lookup(cloneUrl: string, ref: string): Promise<RemoteRef>;
  /** Fetch one commit's tree and return the verified commit. See {@link fetchTree}. */
  fetch(req: TreeRequest): Promise<string>;
}

/** The real git behind {@link GitTreeSource}. */
export const gitTreeSource: GitTreeSource = {
  lookup: lookupRemoteRef,
  fetch: fetchTree,
};

/** A branch or tag the repository does not have. */
export class GitRefNotFoundError extends Error {
  constructor(
    public readonly ref: string,
    cloneUrl: string
  ) {
    super(
      ref === 'HEAD'
        ? `${describeRemote(cloneUrl)} has no commits yet.`
        : `There's no branch or tag named "${ref}" in ${describeRemote(cloneUrl)}.`
    );
    this.name = 'GitRefNotFoundError';
  }
}

/** A pinned commit the repository does not have. */
export class GitCommitNotFoundError extends Error {
  constructor(
    public readonly commitSha: string,
    cloneUrl: string
  ) {
    super(`Commit ${commitSha} isn't in ${describeRemote(cloneUrl)}.`);
    this.name = 'GitCommitNotFoundError';
  }
}

/** The ref could not be looked up at all. */
export class GitRemoteUnreachableError extends Error {
  constructor(cloneUrl: string, reason: string) {
    super(`Couldn't reach ${describeRemote(cloneUrl)}: ${reason}`);
    this.name = 'GitRemoteUnreachableError';
  }
}

/** A git step of a fetch failed, or its result could not be verified. */
export class GitFetchError extends Error {
  constructor(cloneUrl: string, reason: string) {
    super(`Couldn't fetch ${describeRemote(cloneUrl)}: ${reason}`);
    this.name = 'GitFetchError';
  }
}

/**
 * Resolve `ref` on the remote at `cloneUrl` to an exact refname and commit.
 * Never throws: a failed `ls-remote` is `unreachable`, with git's reason.
 *
 * @param cloneUrl - The remote, already accepted by `assertSafeGitRemote`.
 * @param ref - `HEAD`, a branch or tag name, a `refs/…` name, or a full commit id.
 */
export async function lookupRemoteRef(cloneUrl: string, ref: string): Promise<RemoteRef> {
  if (isFullCommitSha(ref)) return { kind: 'found', commitSha: ref };

  const candidates = candidateRefNames(ref);
  const patterns = candidates.flatMap((name) => [name, `${name}^{}`]);
  let stdout: string;
  try {
    const auth = await gitAuth(cloneUrl);
    ({ stdout } = await runGit(
      ['ls-remote', END_OF_OPTIONS, auth.url, ...patterns],
      undefined,
      LS_REMOTE_TIMEOUT_MS,
      auth.config
    ));
  } catch (err) {
    return { kind: 'unreachable', reason: reasonOf(err) };
  }

  const advertised = parseLsRemote(stdout);
  for (const name of candidates) {
    // A peeled line exists only for an annotated tag, and it is the commit.
    const commitSha = advertised.get(`${name}^{}`) ?? advertised.get(name);
    if (isFullCommitSha(commitSha)) return { kind: 'found', commitSha, refName: name };
  }
  return { kind: 'missing' };
}

/**
 * Fetch `req.commitSha`'s tree into `req.destDir` (just `req.subpath` when one
 * is given), verify it, remove `.git`, and return the commit checked out.
 *
 * The returned commit equals `req.commitSha` except on one path: a server that
 * refused the commit by id, where the named ref is fetched instead and may have
 * moved since the lookup. What is returned is always what is on disk.
 *
 * @param req - The remote, commit, optional refname, subpath and destination.
 * @returns The full commit id of the checkout.
 * @throws {GitCommitNotFoundError} When a pinned commit is not in the repository.
 * @throws {GitFetchError} When any git step fails or the checkout is not the
 *   commit it should be.
 */
export async function fetchTree(req: TreeRequest): Promise<string> {
  // Every step gets the auth: a sparse checkout fetches the blobs it lacks
  // from the remote, so the checkout needs it as much as the fetch does.
  const auth = await gitAuth(req.cloneUrl);
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  const git: GitRunner = (args, options = {}) => {
    // Each step gets what is left of the whole fetch's time (DOR-2321).
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new GitDeadlineError());
    }
    return runGit(args, req.destDir, Math.min(GIT_FETCH_TIMEOUT_MS, remaining), auth.config, {
      // A download is watched on disk while git runs, so a server cannot
      // stream more than the clone limit however it answers (DOR-2321).
      ...(options.watchBytes && {
        watch: {
          dir: path.join(req.destDir, '.git'),
          freeSpaceOf: req.destDir,
          maxBytes: CLONE_SIZE_LIMITS.maxTotalBytes,
        },
      }),
      ...(options.onStdoutLine && { onStdoutLine: options.onStdoutLine }),
      ...(options.stdin !== undefined && { stdin: options.stdin }),
      ...(options.env && { env: options.env }),
    });
  };

  try {
    const commit = await fetchCommit(git, req, auth.url);
    // The checked-out tree, measured before anything reads it (DOR-2321). The
    // download and the tree listing were bounded before the checkout; this is
    // what actually landed, which a blobless fetch could not know in advance.
    try {
      await measurePackageTree(req.destDir, CLONE_SIZE_LIMITS);
    } catch (err) {
      if (!(err instanceof PackageTooLargeError)) throw err;
      throw new GitFetchError(req.cloneUrl, err.message);
    }
    return commit;
  } catch (err) {
    // Whatever failed, nothing half-fetched is left for anything to read. A
    // destination that cannot be emptied (already gone) is no reason to lose
    // the real error.
    await emptyDir(req.destDir).catch(() => {});
    if (err instanceof GitCommitNotFoundError || err instanceof GitFetchError) throw err;
    if (err instanceof GitDownloadTooLargeError) throw new GitFetchError(req.cloneUrl, err.message);
    throw new GitFetchError(req.cloneUrl, reasonOf(err));
  }
}

/**
 * Fetch and check out the commit, with the partial-clone optimisation and its
 * one fallback. See {@link fetchTree}.
 *
 * @param git - Runs git in `req.destDir` with the remote's auth.
 * @param req - The remote, commit, optional refname, subpath and destination.
 * @param remoteUrl - The remote URL with any auth applied.
 * @returns The full commit id of the checkout.
 */
async function fetchCommit(git: GitRunner, req: TreeRequest, remoteUrl: string): Promise<string> {
  if (req.subpath !== '') {
    // A subpath is first tried as a blob-filtered partial clone, which
    // downloads only the package's own files. It is an optimisation, so ANY
    // failure of it starts over once with the full fetch below: a server
    // that refuses unadvertised objects refuses the lazy blob requests
    // checkout makes, and git words that differently by version ("could not
    // fetch … from promisor remote", "bad pack header" on 2.26, a silent
    // "invalid object" on 2.30–2.36). A real failure fails again, unfiltered,
    // and is reported from there.
    try {
      return await attempt(git, req, remoteUrl, true);
    } catch (err) {
      // Too large, or out of time, is the answer, not a reason to try again
      // without the filter.
      if (err instanceof GitDownloadTooLargeError || err instanceof GitDeadlineError) throw err;
      await emptyDir(req.destDir);
    }
  }
  return await attempt(git, req, remoteUrl, false);
}

/**
 * One try at {@link fetchTree} in an empty `req.destDir`. `filtered` is the
 * partial-clone optimisation: it fetches by id only, and any failure is the
 * caller's cue to start over unfiltered. Unfiltered, a refusal of the commit
 * by id takes the refname or branches-and-tags fallback.
 */
async function attempt(
  git: GitRunner,
  req: TreeRequest,
  remoteUrl: string,
  filtered: boolean
): Promise<string> {
  await git(['init', '--quiet']);
  // A named remote, not a bare URL: a partial fetch records its promisor
  // settings under the remote's name, and the checkout needs them to fetch
  // the blobs it lacks.
  await git(['remote', 'add', END_OF_OPTIONS, REMOTE, remoteUrl]);
  if (req.subpath !== '') {
    // `init --cone` first: `set --cone` alone leaves cone mode off before
    // git 2.35, and the subpath would be read as a gitignore pattern.
    await git(['sparse-checkout', 'init', '--cone']);
    await git(['sparse-checkout', 'set', END_OF_OPTIONS, req.subpath]);
  }
  if (filtered) {
    // Partial clone, configured by hand: git 2.26 refuses a filtered fetch
    // into a fresh repository ("--filter can only be used when
    // extensions.partialClone is set"); 2.30 and later set this themselves.
    for (const [key, value] of PARTIAL_CLONE_CONFIG) {
      await git(['config', key, value]);
    }
  }

  let arrived: string;
  // Only the refname fallback may bring back a different commit than the one
  // asked for: the ref moved after the lookup. By id, and for a pin by any
  // route, anything else is a failure.
  let mayDiffer = false;
  try {
    await git(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        ...(filtered ? ['--filter=blob:none'] : []),
        END_OF_OPTIONS,
        REMOTE,
        req.commitSha,
      ],
      { watchBytes: true }
    );
    arrived = await commitOf(git, 'FETCH_HEAD');
  } catch (err) {
    if (err instanceof GitDownloadTooLargeError) throw err;
    if (filtered || !REFUSAL_RE.test(reasonOf(err))) throw err;
    if (req.refName === undefined) {
      arrived = await fetchPinnedFromAllRefs(git, req.commitSha, req.cloneUrl);
    } else {
      arrived = await fetchByRefName(git, req.refName);
      mayDiffer = true;
    }
  }
  if (!mayDiffer && arrived !== req.commitSha) {
    throw new Error(`expected commit ${req.commitSha}, received ${arrived}`);
  }

  // Before a single file is written: the tree must fit the clone limits. A
  // few kilobytes of trees can name millions of files (DOR-2321).
  await checkTreeBeforeCheckout(git, arrived, req.subpath, !filtered);

  // No `--end-of-options` here: `checkout --detach` rejects it up to git
  // 2.43, and `arrived` is a verified full commit id, never author text.
  // Watched, because a blobless checkout downloads the files it writes.
  const checkout = await git(
    ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', arrived],
    { watchBytes: true }
  );
  // Git 2.30–2.36 (measured) can report a blob it failed to fetch lazily as
  // `error: invalid object … for '<path>'` and still exit 0, leaving HEAD
  // right and the file missing. So an `error:` line fails the checkout, and
  // every file the index expects must be on disk.
  const reported = checkout.stderr.split('\n').find((line) => /^error:/i.test(line.trim()));
  if (reported) throw Object.assign(new Error(reported.trim()), { stderr: reported });
  const head = await commitOf(git, 'HEAD');
  if (head !== arrived) {
    throw new Error(`checked out ${head}, expected ${arrived}`);
  }
  const { stdout: missing } = await git(['ls-files', '--deleted']);
  if (missing.trim() !== '') {
    throw new Error(`the checkout is missing files: ${missing.trim().split('\n')[0]}`);
  }

  await rm(path.join(req.destDir, '.git'), { recursive: true, force: true });
  return arrived;
}

/**
 * Refuse a tree that is larger than the clone limits before checking it out
 * (DOR-2321), so nothing is ever written past them.
 *
 * `git ls-tree -r -t` is streamed and git is stopped the moment the entries
 * (files and folders; `-t` lists folders) pass the limit. With the file
 * contents already downloaded (`withSizes`), `-l` sizes every file as it is
 * listed. A blobless fetch has no sizes yet, so its files are downloaded here
 * first, in batches and under the byte watch, exactly as the checkout would
 * have downloaded them, and `git cat-file --batch-check` then sizes them from
 * the local copies. Every file counts once per place it appears, so one small
 * download named forty times is sized as forty files.
 *
 * @param git - Runs git in the fetch directory.
 * @param commit - The verified commit to be checked out.
 * @param subpath - The package's directory, or `''` for the whole tree.
 * @param withSizes - Whether file contents are already downloaded.
 * @throws {GitDownloadTooLargeError} Past a limit.
 */
async function checkTreeBeforeCheckout(
  git: GitRunner,
  commit: string,
  subpath: string,
  withSizes: boolean
): Promise<void> {
  const { maxEntries, maxTotalBytes, maxFileBytes } = CLONE_SIZE_LIMITS;
  let entries = 0;
  let bytes = 0;
  let over: GitDownloadTooLargeError | null = null;
  /** Blob id to how many times the tree names it, when sizes are not known yet. */
  const blobs = new Map<string, number>();
  const addBytes = (size: number): void => {
    if (size > maxFileBytes || (bytes += size) > maxTotalBytes) {
      over ??= new GitDownloadTooLargeError('bytes', maxTotalBytes);
    }
  };
  const count = (line: string): boolean => {
    if (line === '' || over) return over === null;
    entries += 1;
    if (entries > maxEntries) over = new GitDownloadTooLargeError('entries', maxEntries);
    // "<mode> <type> <object>[ <size>]\t<path>", with "-" for a folder's size.
    const fields = line.slice(0, line.indexOf('\t')).trim().split(/\s+/);
    if (fields[1] === 'blob') {
      if (withSizes) addBytes(Number(fields[3]));
      else blobs.set(fields[2]!, (blobs.get(fields[2]!) ?? 0) + 1);
    }
    return over === null;
  };
  await git(
    [
      'ls-tree',
      '-r',
      '-t',
      ...(withSizes ? ['-l'] : []),
      commit,
      ...(subpath !== '' ? ['--', subpath] : []),
    ],
    { onStdoutLine: count }
  ).catch((err: unknown) => {
    // Stopping git early is how the limit is enforced; its exit is expected.
    if (over) return { stdout: '', stderr: '' };
    throw err;
  });
  if (over) throw over;
  if (withSizes || blobs.size === 0) return;

  const ids = [...blobs.keys()];
  // The download the checkout would make, made here in batches that fit on a
  // command line (Windows allows about 32,000 characters), under the byte
  // watch. Fetching by id, not `--stdin`, keeps git 2.26 working.
  for (let i = 0; i < ids.length; i += BLOB_FETCH_BATCH) {
    await git(
      [
        '-c',
        'fetch.negotiationAlgorithm=noop',
        'fetch',
        '--quiet',
        '--no-tags',
        '--recurse-submodules=no',
        '--filter=blob:none',
        END_OF_OPTIONS,
        REMOTE,
        ...ids.slice(i, i + BLOB_FETCH_BATCH),
      ],
      { watchBytes: true }
    );
  }
  // Sized from the local copies. GIT_NO_LAZY_FETCH exists from git 2.45: there
  // a blob that somehow did not arrive reads as missing instead of being
  // fetched one at a time. Older git ignores it and fetches such a blob, still
  // under the byte watch, so the limit holds either way.
  const { stdout: sized } = await git(['cat-file', '--batch-check=%(objectname) %(objectsize)'], {
    stdin: `${ids.join('\n')}\n`,
    env: { GIT_NO_LAZY_FETCH: '1' },
    watchBytes: true,
  });
  for (const line of sized.split('\n')) {
    if (line === '') continue;
    const [id, size] = line.split(' ');
    if (size === 'missing' || !Number.isFinite(Number(size))) {
      throw new Error(`the download is missing ${id}`);
    }
    for (let n = blobs.get(id!) ?? 0; n > 0 && !over; n -= 1) addBytes(Number(size));
    if (over) throw over;
  }
}

/** Remove everything inside `dir`, keeping `dir` itself. */
async function emptyDir(dir: string): Promise<void> {
  const entries = await readdir(dir);
  await Promise.all(entries.map((e) => rm(path.join(dir, e), { recursive: true, force: true })));
}

/** Run git in the fetch's directory. */
type GitRunner = (
  args: string[],
  options?: {
    watchBytes?: boolean;
    onStdoutLine?: (line: string) => boolean;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
  }
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The fallback for a named ref: fetch the exact refname the lookup chose (never
 * a bare name, which git's own lookup would resolve tag-first) and return the
 * commit it points at now.
 */
async function fetchByRefName(git: GitRunner, refName: string): Promise<string> {
  await git(['fetch', '--quiet', '--no-tags', '--depth=1', END_OF_OPTIONS, REMOTE, refName], {
    watchBytes: true,
  });
  return commitOf(git, 'FETCH_HEAD');
}

/**
 * The fallback for a pinned commit: a server that will not serve it by id
 * still serves every branch and tag, and the pin must be reachable from one of
 * them. Unfiltered and unshallow: the price of a pin on such a server.
 */
async function fetchPinnedFromAllRefs(
  git: GitRunner,
  commitSha: string,
  cloneUrl: string
): Promise<string> {
  // Reached on text the server sends (REFUSAL_RE), so it is untrusted: the
  // full history it downloads is watched against the same byte limit as any
  // other fetch (DOR-2321). It stays unfiltered: a server that refuses a
  // fetch by id also refuses the blob requests a filtered checkout makes.
  await git(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      END_OF_OPTIONS,
      REMOTE,
      `+refs/heads/*:refs/remotes/${REMOTE}/*`,
      '+refs/tags/*:refs/tags/*',
    ],
    { watchBytes: true }
  );
  try {
    return await commitOf(git, commitSha);
  } catch {
    throw new GitCommitNotFoundError(commitSha, cloneUrl);
  }
}

/**
 * The full commit id `rev` points at, peeling a tag. `rev` is always
 * `FETCH_HEAD`, `HEAD` or a full commit id, never author text.
 */
async function commitOf(git: GitRunner, rev: string): Promise<string> {
  const { stdout } = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const sha = stdout.trim();
  if (!isFullCommitSha(sha)) throw new Error(`${rev} is not a commit`);
  return sha;
}

/**
 * The refnames `ref` may mean, in the order they win. A `refs/…` name and
 * `HEAD` mean themselves; anything else is a branch, then a tag.
 */
function candidateRefNames(ref: string): string[] {
  if (ref === 'HEAD' || ref.startsWith('refs/')) return [ref];
  return [`refs/heads/${ref}`, `refs/tags/${ref}`];
}

/** Parse `ls-remote` output into refname → id. */
function parseLsRemote(stdout: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const [sha, name] = line.trim().split('\t');
    if (sha && name) refs.set(name, sha);
  }
  return refs;
}

/** The token {@link gitAuth} last resolved, and when. */
let cachedAuth: { token: string | undefined; at: number } | undefined;

/** The installed git's `[major, minor]`, read once per process. */
let installedGit: Promise<[number, number] | undefined> | undefined;

/**
 * Parse `git --version` output into `[major, minor]`, tolerating the suffixes
 * vendors add: `git version 2.39.5 (Apple Git-154)`,
 * `git version 2.43.0.windows.1`. `undefined` when there is no version in it.
 *
 * @param stdout - What `git --version` printed.
 */
export function parseGitVersion(stdout: string): [number, number] | undefined {
  const match = /git version (\d+)\.(\d+)/.exec(stdout);
  return match ? [Number(match[1]), Number(match[2])] : undefined;
}

/** The installed git's version, from one `git --version` per process. */
function gitVersion(): Promise<[number, number] | undefined> {
  installedGit ??= runGit(['--version'], undefined, LS_REMOTE_TIMEOUT_MS).then(
    ({ stdout }) => parseGitVersion(stdout),
    () => undefined
  );
  return installedGit;
}

/** How a request to one remote authenticates: the URL git is given, and env config. */
interface GitAuth {
  /** The remote URL: credentialed only on git older than 2.31. */
  url: string;
  /** Config passed through the environment: the token header on git 2.31+. */
  config: GitConfigEntry[];
}

/**
 * How to authenticate a request to `cloneUrl`. A GitHub host gets the
 * operator's token; any other host gets nothing. The token is resolved only
 * when it could be used, so a third-party host never costs a `gh auth token`
 * call, and it is reused for {@link AUTH_TTL_MS}: `resolveGitAuth` may run
 * `gh` synchronously, and an update check looks up many packages at once.
 *
 * Git 2.31 and later read {@link gitHubAuthConfig}'s header from the
 * environment, which keeps the token off every command line. Older git cannot,
 * so the token is embedded in the URL as `execGitClone` does; so is it when
 * the version cannot be read, because that form works on every git.
 */
async function gitAuth(cloneUrl: string): Promise<GitAuth> {
  if (!isGitHubCredentialHost(cloneUrl)) return { url: cloneUrl, config: [] };
  const now = Date.now();
  if (!cachedAuth || now - cachedAuth.at > AUTH_TTL_MS) {
    cachedAuth = { token: resolveGitAuth(), at: now };
  }
  const token = cachedAuth.token;
  if (!token) return { url: cloneUrl, config: [] };
  const version = await gitVersion();
  if (version && (version[0] > 2 || (version[0] === 2 && version[1] >= 31))) {
    const header = gitHubAuthConfig(cloneUrl, token);
    return { url: cloneUrl, config: header ? [header] : [] };
  }
  return { url: withGitHubToken(cloneUrl, token), config: [] };
}

/**
 * How a remote is named in a message a person reads: host and path, with any
 * userinfo (which may be a credential) and query left out.
 *
 * @param cloneUrl - The remote's address.
 */
function describeRemote(cloneUrl: string): string {
  try {
    const parsed = new URL(cloneUrl);
    if (parsed.host) return `${parsed.host}${parsed.pathname.replace(/\.git$/, '')}`;
  } catch {
    // Not a WHATWG URL — the scp-style form below.
  }
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(cloneUrl);
  return scp ? `${scp[1]}/${scp[2].replace(/\.git$/, '')}` : cloneUrl;
}

/**
 * The part of a git failure a person can act on: git's last `fatal:` or
 * `error:` line, redacted, else the error's own message. Never the argv.
 */
function reasonOf(err: unknown): string {
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err
      ? String((err as { stderr: unknown }).stderr ?? '')
      : '';
  const lines = redactAuthTokens(stderr)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const reported = [...lines].reverse().find((line) => /^(fatal|error):/i.test(line));
  if (reported) return reported.replace(/^(fatal|error):\s*/i, '');
  if (lines.length > 0) return lines[lines.length - 1]!;
  if (err instanceof Error) {
    // execFile's own message starts with "Command failed: git …" and the argv;
    // keep only what follows it, or a timeout's signal.
    if ('killed' in err && (err as { killed?: boolean }).killed) return 'timed out';
    return redactAuthTokens(
      err.message.split('\n')[0]!.replace(/^Command failed:.*$/, 'git failed')
    );
  }
  return redactAuthTokens(String(err));
}
