/**
 * Template download service with git primary and giget fallback.
 *
 * Tries `git clone --depth 1` first for speed and auth support, then
 * falls back to giget (tarball download) with a 30-second timeout.
 * Parses clone progress from git stderr for real-time feedback.
 *
 * @module services/core/template-downloader
 */
import { spawn, execSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
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
      ['clone', '--depth', '1', '--single-branch', '--progress', cloneUrl, target],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
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
 * @param source - Template source (e.g. `github:org/repo`, full URL)
 * @param targetPath - Local directory to download into
 * @param onProgress - Optional progress callback for git clone
 */
export async function downloadTemplate(
  source: string,
  targetPath: string,
  onProgress?: ProgressCallback
): Promise<void> {
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
