/**
 * Template download service with git primary and giget fallback.
 *
 * Tries `git clone --depth 1` first for speed and auth support, then
 * falls back to giget (tarball download) with a 30-second timeout.
 * Parses clone progress from git stderr for real-time feedback.
 *
 * Two surfaces live here, and only one of them takes a person's address:
 *
 * - {@link downloadTemplate} — the workspace-template flow behind
 *   `POST /api/agents/create`. Its `source` is free-form, so it asks
 *   {@link isSupportedTemplateSource} before either strategy runs (DOR-1825).
 * - {@link cloneRepository} — the primitive the marketplace install pipeline
 *   injects. Its addresses are confined upstream by
 *   `services/marketplace/source-url-policy.ts`, whose accepted set is
 *   deliberately different (it clones from `ssh://`; this file cannot), so the
 *   two doors stay two doors rather than one shared predicate applied twice.
 *
 * @module services/core/template-downloader
 */
import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { isSafeGitUrl } from '@dorkos/marketplace';
import { logger } from '../../lib/logger.js';
import { hardenedGitEnv } from '../../lib/git-safety.js';
import { env } from '../../env.js';

/** Progress callback invoked during git clone. */
export type ProgressCallback = (percent: number, phase: string) => void;

/** Classifiable error types for template download failures. */
export type TemplateErrorCode =
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'AUTH_ERROR'
  | 'DISK_FULL'
  | 'DIRECTORY_EXISTS'
  | 'NETWORK_ERROR'
  | 'UNSUPPORTED_SOURCE'
  | 'UNKNOWN';

/** Error thrown when template download fails with a classified reason. */
export class TemplateDownloadError extends Error {
  constructor(
    message: string,
    public readonly code: TemplateErrorCode,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TemplateDownloadError';
  }
}

const GIGET_TIMEOUT_MS = 30_000;

/**
 * Wall-clock cap on a single `git clone`. Generous enough for large real
 * repositories, but bounded so a hung transport (or a credential prompt that
 * `GIT_TERMINAL_PROMPT=0` did not already prevent) cannot stall the install
 * pipeline indefinitely. Node kills the process with `SIGTERM` on expiry.
 */
const GIT_CLONE_TIMEOUT_MS = 120_000;

/**
 * Redact auth tokens from error messages to prevent credential leaks.
 *
 * Replaces `x-access-token:<token>@` patterns with `x-access-token:[REDACTED]@`
 * in git clone stderr output and error messages.
 *
 * @param message - Raw error message that may contain embedded tokens
 * @returns Sanitized message with tokens replaced
 */
export function redactAuthTokens(message: string): string {
  return message.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
}

/**
 * Resolve a shorthand source to a full git URL.
 *
 * Supports `github:org/repo`, `gitlab:org/repo`, `bitbucket:org/repo`,
 * and passes through URLs that already start with `https://` or `git@`.
 *
 * @param source - Template source (e.g. `github:org/repo`)
 * @returns Full git clone URL
 */
export function resolveGitUrl(source: string): string {
  const providers: Record<string, string> = {
    github: 'https://github.com',
    gitlab: 'https://gitlab.com',
    bitbucket: 'https://bitbucket.org',
  };

  for (const [prefix, base] of Object.entries(providers)) {
    if (source.startsWith(`${prefix}:`)) {
      const repo = source.slice(prefix.length + 1);
      return `${base}/${repo}.git`;
    }
  }

  // Already a full URL
  if (source.startsWith('https://') || source.startsWith('git@')) {
    return source;
  }

  // Default to GitHub
  return `https://github.com/${source}.git`;
}

/**
 * A repo path in the shorthand forms {@link resolveGitUrl} expands: `owner/repo`,
 * optionally with further segments for a subdirectory. The first character is
 * deliberately narrow — a leading `.` or `-` would be read as a relative path by
 * giget's git provider, or as a flag by `git`.
 */
const TEMPLATE_REPO_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+$/;

/** Matches the `github:` / `gitlab:` / `bitbucket:` shorthand prefix. */
const TEMPLATE_SHORTHAND_RE = /^(?:github|gitlab|bitbucket):(.+)$/;

/**
 * A branch, tag or SHA in a shorthand's `#ref` suffix.
 *
 * Narrow on purpose at both ends of the ref's journey. It becomes a path
 * segment in giget's provider URLs (`…/repos/<repo>/tarball/<ref>`), so `..` is
 * refused separately below; and it becomes the value of `--branch` in giget's
 * git provider, so a leading `-`, whitespace or a null byte is refused here.
 */
const TEMPLATE_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/**
 * What a person is told when the template address they gave is not one DorkOS
 * can download from. Names every form that works, because a refusal that does
 * not is a dead end.
 */
export const UNSUPPORTED_TEMPLATE_SOURCE_MESSAGE =
  "That template address isn't one DorkOS can download from. Use an https:// or git@host:path " +
  'address for a git repository, a github:, gitlab: or bitbucket: shorthand (add #branch to pin ' +
  'a version), or an owner/repo name.';

/** True when `value` is a repo path a shorthand or bare source may carry. */
function isTemplateRepoPath(value: string): boolean {
  return !value.includes('..') && TEMPLATE_REPO_PATH_RE.test(value);
}

/**
 * True when `source` is a template address {@link downloadTemplate} will act on.
 *
 * The template source is the one string in agent creation that nobody validated
 * on the way in: `POST /api/agents/create` declares it `z.string().optional()`,
 * and a person types it into the New Agent gallery, passes it to `dorkos agent
 * create --template`, or gets it from a marketplace agent listing whose own
 * `source` string becomes it. It then reached two git-cloning strategies
 * unchecked (DOR-1825). Same shape as the marketplace's own address policy in
 * `services/marketplace/source-url-policy.ts`, asked at the other git-cloning
 * surface so the two answers cannot drift.
 *
 * What this predicate does and does not buy is worth stating exactly, because
 * the two strategies see different strings. {@link execGitClone} only ever sees
 * {@link resolveGitUrl}'s output, which prefixes anything unrecognised with
 * `https://github.com/` and so already neutralises most of it. The giget
 * fallback receives the RAW source and dispatches on its scheme, which is where
 * this check earns its place: its git provider spawns `git clone` without the
 * `GIT_ALLOW_PROTOCOL` confinement {@link hardenedGitEnv} gives ours, so a
 * `foo+git::` address arrives there as a `foo::` transport, and a `git://` one
 * arrives as a LOCAL path (giget strips the scheme, and `//host/x` resolves
 * against the cwd). **It narrows the transport set, and that is all it does.**
 * It is not a fix for credential exposure: an `https://` address is accepted
 * here by design, and both download paths attach the operator's GitHub token to
 * whatever host it names — {@link execGitClone} by rewriting the URL, giget by
 * its `auth` option. That is tracked separately as DOR-1833 and is not
 * addressable by an allowlist that has to permit arbitrary `https://` hosts.
 *
 * The accepted set is NARROWER than {@link isSafeGitUrl} in two deliberate
 * ways: `ssh://` and `git://` are refused, and neither has ever been downloadable
 * here. `resolveGitUrl` passes through only `https://` and `git@host:path`, so
 * the primary strategy turns both into a `https://github.com/<the whole
 * string>.git` that cannot resolve — and the fallback saves neither, because
 * giget has no `ssh` provider (the address falls through to a registry lookup
 * that 404s) while its `git` provider reads `git://host/x` as that local path.
 * Accepting either would accept an address that then fails. The marketplace's
 * install door allows `ssh://` because it genuinely clones from it; this one
 * does not.
 *
 * @param source - The template address a person supplied.
 * @returns `true` when DorkOS will try to download from it.
 */
export function isSupportedTemplateSource(source: string): boolean {
  if (source.startsWith('https://') || source.startsWith('git@')) {
    return isSafeGitUrl(source);
  }

  const shorthand = TEMPLATE_SHORTHAND_RE.exec(source);
  if (!shorthand) {
    // A bare `owner/repo` carries no `#ref`: giget routes a bare source to its
    // template REGISTRY rather than to a provider, so `owner/repo#dev` has
    // never resolved to anything. Only the shorthands below ever honoured one.
    return isTemplateRepoPath(source);
  }

  const [repoPath, ref, ...extra] = shorthand[1].split('#');
  if (extra.length > 0) {
    return false;
  }
  if (ref !== undefined && !(TEMPLATE_REF_RE.test(ref) && !ref.includes('..'))) {
    return false;
  }
  return isTemplateRepoPath(repoPath);
}

/**
 * Refuse a template address DorkOS will not download from, logging the address
 * on the way out.
 *
 * The decision lives in {@link isSupportedTemplateSource}; the logging lives
 * here because the person-facing message deliberately omits the address, and
 * this warning is what answers "which one did it refuse?".
 *
 * @param source - The template address to check.
 * @throws {TemplateDownloadError} With code `UNSUPPORTED_SOURCE` when the
 *   address is not one {@link isSupportedTemplateSource} accepts.
 */
function assertSupportedTemplateSource(source: string): void {
  if (isSupportedTemplateSource(source)) {
    return;
  }
  logger.warn('Refused an unsupported template source', { source });
  throw new TemplateDownloadError(UNSUPPORTED_TEMPLATE_SOURCE_MESSAGE, 'UNSUPPORTED_SOURCE');
}

/**
 * Resolve git authentication token.
 *
 * Checks `GITHUB_TOKEN` env var first, then falls back to `gh auth token` CLI.
 * Returns undefined if neither is available.
 *
 * @returns Auth token or undefined
 */
export function resolveGitAuth(): string | undefined {
  if (env.GITHUB_TOKEN) {
    return env.GITHUB_TOKEN;
  }

  try {
    const token = execSync('gh auth token', { encoding: 'utf-8', timeout: 5000 }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Classify a giget or git error into a known error category.
 *
 * @param err - The thrown error object
 * @returns Classified error code
 */
export function classifyGigetError(err: unknown): TemplateErrorCode {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('timed out')) return 'TIMEOUT';
  if (lower.includes('404') || lower.includes('not found') || lower.includes('does not exist'))
    return 'NOT_FOUND';
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('authentication') ||
    lower.includes('permission denied')
  )
    return 'AUTH_ERROR';
  if (lower.includes('no space') || lower.includes('disk full') || lower.includes('enospc'))
    return 'DISK_FULL';
  if (lower.includes('already exists') || lower.includes('eexist')) return 'DIRECTORY_EXISTS';
  if (
    lower.includes('enotfound') ||
    lower.includes('enetunreach') ||
    lower.includes('econnrefused') ||
    lower.includes('network')
  )
    return 'NETWORK_ERROR';

  return 'UNKNOWN';
}

/**
 * Execute `git clone --depth 1 --single-branch` with progress parsing.
 *
 * Removes the `.git` directory after a successful clone. Injects auth
 * via the URL when a token is available.
 *
 * The clone runs with {@link hardenedGitEnv}: `GIT_ALLOW_PROTOCOL` confines the
 * author-supplied URL to safe transports (blocks the `ext::`/`file::` command
 * helpers, which fire at preview time before install consent), and
 * `GIT_TERMINAL_PROMPT=0` stops a private URL from hanging on a prompt. The URL
 * and target follow `--end-of-options`, so neither can be read as a flag. A
 * wall-clock {@link GIT_CLONE_TIMEOUT_MS} caps a stalled clone.
 *
 * @param url - Git clone URL
 * @param target - Target directory path
 * @param auth - Optional auth token to embed in URL
 * @param onProgress - Optional progress callback
 */
export async function execGitClone(
  url: string,
  target: string,
  auth?: string,
  onProgress?: ProgressCallback
): Promise<void> {
  const cloneUrl =
    auth && url.startsWith('https://')
      ? url.replace('https://', `https://x-access-token:${auth}@`)
      : url;

  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--progress',
        // Everything after this is a value, never a flag. The URL reaching here
        // is author- or operator-supplied, and one starting with `-` would
        // otherwise be offered to git as an option — the same fourth layer the
        // marketplace's other two git call sites already carry, added so the
        // claim "every helper passes the destination as one argv element after
        // `--end-of-options`" is true of the clone primitive too (DOR-1799).
        // Supported since git 2.24, below this repo's 2.25 floor.
        '--end-of-options',
        cloneUrl,
        target,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Confine git to safe transports so an author-controlled URL cannot
        // reach the `ext::`/`file::` helpers and run arbitrary commands.
        env: hardenedGitEnv(),
        timeout: GIT_CLONE_TIMEOUT_MS,
      }
    );

    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;

      if (!onProgress) return;

      // Parse progress lines: "Receiving objects:  42% (100/238)"
      const receivingMatch = text.match(/Receiving objects:\s+(\d+)%/);
      if (receivingMatch) {
        onProgress(parseInt(receivingMatch[1], 10), 'receiving');
        return;
      }

      const resolvingMatch = text.match(/Resolving deltas:\s+(\d+)%/);
      if (resolvingMatch) {
        onProgress(parseInt(resolvingMatch[1], 10), 'resolving');
      }
    });

    // Cast needed: multiple @types/node versions in the monorepo cause
    // ChildProcessByStdio to lose .on() overloads under pnpm strict hoisting
    const procEvents = proc as unknown as EventEmitter;
    procEvents.on('error', (err: Error) => reject(err));

    procEvents.on('close', async (code: number | null) => {
      if (code !== 0) {
        reject(new Error(`git clone exited with code ${code}: ${redactAuthTokens(stderr)}`));
        return;
      }

      // Remove .git directory after successful clone
      try {
        await rm(path.join(target, '.git'), { recursive: true, force: true });
      } catch (err) {
        logger.warn('Failed to remove .git directory after clone', { err });
      }

      resolve();
    });
  });
}

/**
 * Download a template from a git source with giget fallback.
 *
 * Tries `git clone --depth 1` first for speed and auth support. If git
 * fails, falls back to giget (tarball download) with a 30-second timeout.
 *
 * The address is checked before either strategy runs, not between them
 * (DOR-1825): the fallback fires precisely when the first strategy failed, so a
 * guard placed on the clone alone would hand every address it refused straight
 * to giget. See {@link isSupportedTemplateSource}.
 *
 * @param source - Template source (e.g. `github:org/repo`, full URL)
 * @param targetPath - Local directory to download into
 * @param onProgress - Optional progress callback for git clone
 * @throws {TemplateDownloadError} With code `UNSUPPORTED_SOURCE` when `source`
 *   is not an address DorkOS downloads templates from. Nothing is fetched, and
 *   no subprocess starts.
 */
export async function downloadTemplate(
  source: string,
  targetPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
  assertSupportedTemplateSource(source);

  const gitUrl = resolveGitUrl(source);
  const auth = resolveGitAuth();

  // Primary: git clone
  try {
    await execGitClone(gitUrl, targetPath, auth, onProgress);
    return;
  } catch (gitErr) {
    const redactedError =
      gitErr instanceof Error
        ? new Error(redactAuthTokens(gitErr.message))
        : redactAuthTokens(String(gitErr));
    logger.debug('Git clone failed, falling back to giget', { source, error: redactedError });
  }

  // Fallback: giget with timeout
  try {
    const { downloadTemplate: gigetDownload } = await import('giget');

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error('giget download timed out after 30s')),
        GIGET_TIMEOUT_MS
      );
    });

    try {
      await Promise.race([
        gigetDownload(source, { dir: targetPath, force: false, auth }),
        timeoutPromise,
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (gigetErr) {
    const code = classifyGigetError(gigetErr);
    throw new TemplateDownloadError(
      `Template download failed: ${gigetErr instanceof Error ? gigetErr.message : String(gigetErr)}`,
      code,
      gigetErr
    );
  }
}

/**
 * Generic git-clone primitive for callers that need to clone an arbitrary
 * repository into a specific directory without the template-shaped pre/post
 * processing of {@link downloadTemplate}. Used by the marketplace install
 * pipeline to fetch packages into the content-addressable cache.
 *
 * @param gitUrl - Fully-qualified git URL (no shorthand resolution)
 * @param destDir - Local directory to clone into (must not exist)
 * @param _ref - Optional ref/branch (currently unused — depth-1 single-branch clone always pulls the default branch)
 */
export async function cloneRepository(
  gitUrl: string,
  destDir: string,
  _ref?: string
): Promise<void> {
  const auth = resolveGitAuth();
  await execGitClone(gitUrl, destDir, auth);
}

/**
 * Dependency-injection surface for callers (e.g. the marketplace install
 * pipeline) that want to swap out the real git clone with a test double.
 * Mirrors only the `cloneRepository` primitive — `downloadTemplate` is not
 * part of this interface because the marketplace pipeline never invokes the
 * shorthand-template flow.
 */
export interface TemplateDownloader {
  cloneRepository(gitUrl: string, destDir: string, ref?: string): Promise<void>;
}

/**
 * Default `TemplateDownloader` binding backed by the real `cloneRepository`
 * function. Production callers (e.g. `apps/server/src/index.ts`) should pass
 * this when constructing the marketplace `PackageFetcher`; tests should pass
 * a `vi.fn()` stub instead.
 */
export const defaultTemplateDownloader: TemplateDownloader = {
  cloneRepository,
};
