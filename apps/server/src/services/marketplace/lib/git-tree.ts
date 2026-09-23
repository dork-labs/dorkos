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
 * value; the GitHub token is attached only by {@link withGitHubToken}, and git's
 * output is passed through {@link redactAuthTokens} before it reaches a message.
 *
 * @module services/marketplace/lib/git-tree
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hardenedGitEnv } from '../../../lib/git-safety.js';
import {
  isGitHubCredentialHost,
  redactAuthTokens,
  resolveGitAuth,
  withGitHubToken,
} from '../../core/template-downloader.js';

const execFileAsync = promisify(execFile);

/** Max time to wait for `git ls-remote`. */
const LS_REMOTE_TIMEOUT_MS = 15_000;

/** Max time for any one git step of a fetch; matches the clone it replaced. */
const GIT_FETCH_TIMEOUT_MS = 120_000;

/** Everything after it is a value, never a flag (git ≥ 2.24). */
const END_OF_OPTIONS = '--end-of-options';

/** The remote name the temporary repository fetches through. */
const REMOTE = 'origin';

/** A full commit id: SHA-1 (40 hex) or SHA-256 (64 hex), lowercase as git prints it. */
const FULL_COMMIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What git prints when a server will not serve a commit it did not advertise. */
const UNADVERTISED_REFUSAL_RE = /unadvertised object|not our ref/i;

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
  /** The address git is given (never credentialed; this module adds the token). */
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
    super(`There's no branch or tag named "${ref}" in ${describeRemote(cloneUrl)}.`);
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
    ({ stdout } = await runGit(
      ['ls-remote', END_OF_OPTIONS, credentialed(cloneUrl), ...patterns],
      undefined,
      LS_REMOTE_TIMEOUT_MS
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
  const git = (args: string[]) => runGit(args, req.destDir, GIT_FETCH_TIMEOUT_MS);
  const sparse = req.subpath !== '';
  // Blob-filtered only when sparse: a whole-tree checkout needs every blob, and
  // a filtered fetch would just fetch them again, one round trip later.
  const filter = sparse ? ['--filter=blob:none'] : [];

  try {
    await git(['init', '--quiet']);
    // A named remote, not a bare URL: a partial (filtered) fetch records its
    // promisor settings under the remote's name, and the checkout needs them
    // to fetch the blobs it lacks. The config holding the credentialed URL is
    // removed with `.git` below, or with the temp directory on failure.
    await git(['remote', 'add', END_OF_OPTIONS, REMOTE, credentialed(req.cloneUrl)]);
    if (sparse) {
      await git(['sparse-checkout', 'set', '--cone', END_OF_OPTIONS, req.subpath]);
    }

    let arrived: string;
    // Only the refname fallback may bring back a different commit than the
    // one asked for: the ref moved after the lookup. By id, and for a pin by
    // any route, anything else is a failure.
    let mayDiffer = false;
    try {
      await git([
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        ...filter,
        END_OF_OPTIONS,
        REMOTE,
        req.commitSha,
      ]);
      arrived = await commitOf(git, 'FETCH_HEAD');
    } catch (err) {
      if (!UNADVERTISED_REFUSAL_RE.test(reasonOf(err))) throw err;
      if (req.refName === undefined) {
        arrived = await fetchPinnedFromAllRefs(git, req.commitSha, req.cloneUrl);
      } else {
        arrived = await fetchByRefName(git, req.refName, filter);
        mayDiffer = true;
      }
    }
    if (!mayDiffer && arrived !== req.commitSha) {
      throw new Error(`expected commit ${req.commitSha}, received ${arrived}`);
    }

    await git([
      '-c',
      'advice.detachedHead=false',
      'checkout',
      '--quiet',
      '--detach',
      END_OF_OPTIONS,
      arrived,
    ]);
    const head = await commitOf(git, 'HEAD');
    if (head !== arrived) {
      throw new Error(`checked out ${head}, expected ${arrived}`);
    }

    await rm(path.join(req.destDir, '.git'), { recursive: true, force: true });
    return arrived;
  } catch (err) {
    if (err instanceof GitCommitNotFoundError) throw err;
    throw new GitFetchError(req.cloneUrl, reasonOf(err));
  }
}

/** Run git in the fetch's directory. */
type GitRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * The fallback for a named ref: fetch the exact refname the lookup chose (never
 * a bare name, which git's own lookup would resolve tag-first) and return the
 * commit it points at now.
 */
async function fetchByRefName(git: GitRunner, refName: string, filter: string[]): Promise<string> {
  await git([
    'fetch',
    '--quiet',
    '--no-tags',
    '--depth=1',
    ...filter,
    END_OF_OPTIONS,
    REMOTE,
    refName,
  ]);
  return commitOf(git, 'FETCH_HEAD');
}

/**
 * The fallback for a pinned commit: a server that will not serve it by id
 * still serves every branch and tag, and the pin must be reachable from one of
 * them. Blob-filtered (and unshallow) to keep the cost to commits and trees.
 */
async function fetchPinnedFromAllRefs(
  git: GitRunner,
  commitSha: string,
  cloneUrl: string
): Promise<string> {
  await git([
    'fetch',
    '--quiet',
    '--no-tags',
    '--filter=blob:none',
    END_OF_OPTIONS,
    REMOTE,
    `+refs/heads/*:refs/remotes/${REMOTE}/*`,
    '+refs/tags/*:refs/tags/*',
  ]);
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

/**
 * The address to hand git: with the operator's GitHub token for a GitHub host,
 * unchanged otherwise. The token is only resolved when it could be used, so a
 * third-party host never costs a `gh auth token` call.
 */
function credentialed(cloneUrl: string): string {
  return isGitHubCredentialHost(cloneUrl) ? withGitHubToken(cloneUrl, resolveGitAuth()) : cloneUrl;
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
 * `error:` line, redacted, else the error's own message. Never the argv, which
 * may carry the credentialed URL.
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

/**
 * Run one git command. `cwd` is the fetch directory, or `undefined` for
 * `ls-remote`, which needs no repository.
 */
async function runGit(
  args: string[],
  cwd: string | undefined,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    // Confine git to safe transports so an author-controlled URL cannot reach
    // the `ext::`/`file::` helpers, and never prompt for a credential.
    env: hardenedGitEnv(),
    encoding: 'utf-8',
  });
}
