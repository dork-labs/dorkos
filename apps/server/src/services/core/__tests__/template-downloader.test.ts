import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  rm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('giget', () => ({
  downloadTemplate: vi.fn(),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../env.js', () => ({
  env: {} as Record<string, string | undefined>,
}));

import { spawn, execSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { downloadTemplate as gigetDownload } from 'giget';
import { env as mockEnv } from '../../../env.js';
import { isSafeGitUrl } from '@dorkos/marketplace';
import {
  resolveGitUrl,
  resolveGitAuth,
  classifyGigetError,
  execGitClone,
  downloadTemplate,
  isSupportedTemplateSource,
  redactAuthTokens,
  TemplateDownloadError,
  UNSUPPORTED_TEMPLATE_SOURCE_MESSAGE,
} from '../template-downloader.js';

/** Create a mock child process with emitters for stdout, stderr, and process events. */
function createMockProcess(): ChildProcess & { _emit: (event: string, data?: unknown) => void } {
  const proc = new EventEmitter() as ChildProcess & {
    _emit: (event: string, data?: unknown) => void;
  };
  const stdoutEmitter = new EventEmitter() as Readable;
  const stderrEmitter = new EventEmitter() as Readable;
  proc.stdout = stdoutEmitter;
  proc.stderr = stderrEmitter;
  proc.stdin = null;
  proc._emit = (event: string, data?: unknown) => proc.emit(event, data);
  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete mockEnv.GITHUB_TOKEN;
  // Default: gh CLI not available (most tests don't need auth)
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error('gh not found');
  });
});

describe('redactAuthTokens', () => {
  it('redacts x-access-token from HTTPS URLs', () => {
    const raw =
      'fatal: could not read from https://x-access-token:ghp_abc123@github.com/org/repo.git';
    expect(redactAuthTokens(raw)).toBe(
      'fatal: could not read from https://x-access-token:[REDACTED]@github.com/org/repo.git'
    );
  });

  it('redacts multiple tokens in the same message', () => {
    const raw = 'tried https://x-access-token:tok1@a.com then https://x-access-token:tok2@b.com';
    expect(redactAuthTokens(raw)).toBe(
      'tried https://x-access-token:[REDACTED]@a.com then https://x-access-token:[REDACTED]@b.com'
    );
  });

  it('returns the message unchanged when no token is present', () => {
    const raw = 'fatal: repository not found';
    expect(redactAuthTokens(raw)).toBe(raw);
  });

  it('handles empty string', () => {
    expect(redactAuthTokens('')).toBe('');
  });
});

describe('resolveGitUrl', () => {
  it('converts github: shorthand to full URL', () => {
    expect(resolveGitUrl('github:org/repo')).toBe('https://github.com/org/repo.git');
  });

  it('converts gitlab: shorthand to full URL', () => {
    expect(resolveGitUrl('gitlab:org/repo')).toBe('https://gitlab.com/org/repo.git');
  });

  it('converts bitbucket: shorthand to full URL', () => {
    expect(resolveGitUrl('bitbucket:org/repo')).toBe('https://bitbucket.org/org/repo.git');
  });

  it('passes through https:// URLs unchanged', () => {
    const url = 'https://github.com/org/repo.git';
    expect(resolveGitUrl(url)).toBe(url);
  });

  it('passes through git@ URLs unchanged', () => {
    const url = 'git@github.com:org/repo.git';
    expect(resolveGitUrl(url)).toBe(url);
  });

  it('defaults bare org/repo to GitHub', () => {
    expect(resolveGitUrl('org/repo')).toBe('https://github.com/org/repo.git');
  });
});

/**
 * Which addresses a workspace template may be downloaded from (DOR-1825).
 *
 * The template source is a free-form string on `POST /api/agents/create` — a
 * person types it into the New Agent gallery's template field, passes it to
 * `dorkos agent create --template`, or picks a marketplace agent listing whose
 * `source` string becomes it. `downloadTemplate` handed it to two git-cloning
 * strategies without ever asking what it was.
 *
 * The second strategy is why this matters more than the first. `execGitClone`
 * only ever sees `resolveGitUrl`'s output, which prefixes anything unrecognised
 * with `https://github.com/`; the giget fallback receives the RAW string,
 * dispatches on its scheme, and its git provider spawns `git clone -- <uri>`
 * with none of the `GIT_ALLOW_PROTOCOL` confinement `hardenedGitEnv` gives the
 * first strategy — while its http provider sends `resolveGitAuth()`'s GitHub
 * token to whatever host the address names.
 */
describe('template sources — which addresses may be downloaded from', () => {
  /**
   * The shapes a hostile or dead address arrives in. `ext+git::` is the one
   * that actually reaches an unconfined `git clone` (giget strips the `+git`
   * suffix and hands `ext::sh -c id` to git); the rest are the neighbours
   * DOR-1710's review probed, plus the transports this door has never been able
   * to clone from.
   */
  const REFUSED_SOURCES = [
    "ext::sh -c 'id > /tmp/dorkos-dor-1825'",
    "ext+git::sh -c 'id > /tmp/dorkos-dor-1825'",
    'file::/tmp/not-a-repo',
    'file:///etc',
    'fd::0/foo',
    '-upload-pack=touch /tmp/dorkos-dor-1825',
    '--upload-pack=touch /tmp/dorkos-dor-1825',
    'http://example.com/repo.git',
    'git://example.com/foo/bar.git',
    'ssh://git@example.com/foo/bar.git',
    'npm:some-package',
    './relative/path',
    '../climbing/out',
    'org/../../etc/passwd',
    // scp-style addresses that LOOK like the allowed `git@host:path` form and
    // are not. Present so the `isSafeGitUrl` call in the predicate is doing
    // work: without them every full-address case here is refused by the
    // `https://`/`git@` prefix test alone, and stubbing the shared predicate to
    // `true` would leave this suite green.
    'git@-oProxyCommand=id:x/y',
    'git@evil.example.com/no-colon',
    // A `#ref` is honoured on a shorthand (below), but only there and only when
    // it is a plausible ref.
    'github:org/repo#-oProxyCommand=id',
    'github:org/repo#../../etc',
    'github:org/repo#with space',
    'github:org/repo#',
    'github:org/repo#a#b',
    'org/repo#dev',
  ];

  /**
   * The two addresses this door refuses that {@link isSafeGitUrl} allows. Kept
   * separate so the divergence is a decision rather than a quiet weakening of
   * the agreement check below: `resolveGitUrl` passes through only `https://`
   * and `git@host:path`, so an `ssh://` or `git://` template has never been
   * cloneable here — accepting the string would accept an address that then
   * fails, and hand the giget fallback a scheme to dispatch on.
   */
  const NARROWED_BEYOND_SHARED_PREDICATE = [
    'ssh://git@example.com/foo/bar.git',
    'git://example.com/foo/bar.git',
  ];

  /** The templates people really install from, none of which may regress. */
  const ALLOWED_SOURCES = [
    'github:org/repo',
    'gitlab:org/repo',
    'bitbucket:org/repo',
    // The subpath shorthand `resolvePackageSource` builds for a marketplace
    // agent listing that lives inside its registry repo.
    'github:dork-labs/marketplace/plugins/qa-agent',
    'org/repo',
    'dorkos-templates/nextjs',
    'https://github.com/org/repo.git',
    'git@github.com:org/repo.git',
    // Pinning a template to a version. No first-party surface emits one, but a
    // person typing it is a legitimate want and giget's shorthand providers
    // have always honoured it — so the guard must not be what takes it away.
    'github:org/repo#dev',
    'gitlab:org/repo#v2.1.0',
    'github:org/repo#a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    'https://github.com/org/repo.git#dev',
  ];

  it.each(REFUSED_SOURCES)('refuses %s without cloning or fetching anything', async (source) => {
    await expect(downloadTemplate(source, '/tmp/target')).rejects.toMatchObject({
      code: 'UNSUPPORTED_SOURCE',
      message: UNSUPPORTED_TEMPLATE_SOURCE_MESSAGE,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(gigetDownload).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_SOURCES)('still clones %s', async (source) => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = downloadTemplate(source, '/tmp/target');
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(gigetDownload).not.toHaveBeenCalled();
  });

  it('agrees with `isSafeGitUrl` on every full address, except the two deliberate narrowings', () => {
    // Not a test of the guard — it never calls `downloadTemplate`. It is what
    // keeps the two lists above honest, so this file cannot drift into
    // asserting a transport policy the marketplace half of the repo does not
    // hold. Only full addresses are compared: the shared predicate has nothing
    // to say about `github:org/repo` or a bare `org/repo`, which are shorthands
    // `resolveGitUrl` expands rather than transports.
    for (const source of REFUSED_SOURCES) {
      if (NARROWED_BEYOND_SHARED_PREDICATE.includes(source)) {
        expect(isSafeGitUrl(source), source).toBe(true);
        continue;
      }
      expect(isSafeGitUrl(source), source).toBe(false);
    }
    for (const source of ALLOWED_SOURCES.filter(
      (s) => s.startsWith('https://') || s.startsWith('git@')
    )) {
      expect(isSafeGitUrl(source), source).toBe(true);
    }
  });

  it('answers the same question as the predicate it exports', () => {
    // The predicate is exported for callers that want to ask before they act
    // (the create-agent route could, one day). Pinned against the same fixture
    // lists so the two can never disagree.
    for (const source of REFUSED_SOURCES) {
      expect(isSupportedTemplateSource(source), source).toBe(false);
    }
    for (const source of ALLOWED_SOURCES) {
      expect(isSupportedTemplateSource(source), source).toBe(true);
    }
  });
});

describe('resolveGitAuth', () => {
  afterEach(() => {
    delete mockEnv.GITHUB_TOKEN;
  });

  it('returns GITHUB_TOKEN env var when set', () => {
    mockEnv.GITHUB_TOKEN = 'ghp_test123';
    expect(resolveGitAuth()).toBe('ghp_test123');
  });

  it('falls back to gh auth token CLI', () => {
    vi.mocked(execSync).mockReturnValue('gho_cli_token\n');
    expect(resolveGitAuth()).toBe('gho_cli_token');
  });

  it('returns undefined when gh CLI fails', () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('gh not found');
    });
    expect(resolveGitAuth()).toBeUndefined();
  });

  it('returns undefined when gh CLI returns empty string', () => {
    vi.mocked(execSync).mockReturnValue('\n');
    expect(resolveGitAuth()).toBeUndefined();
  });

  it('prefers GITHUB_TOKEN over gh CLI', () => {
    mockEnv.GITHUB_TOKEN = 'ghp_env_token';
    vi.mocked(execSync).mockReturnValue('gho_cli_token\n');
    expect(resolveGitAuth()).toBe('ghp_env_token');
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe('classifyGigetError', () => {
  it('classifies timeout errors', () => {
    expect(classifyGigetError(new Error('Operation timed out'))).toBe('TIMEOUT');
    expect(classifyGigetError(new Error('request timeout'))).toBe('TIMEOUT');
  });

  it('classifies not found errors', () => {
    expect(classifyGigetError(new Error('404 Not Found'))).toBe('NOT_FOUND');
    expect(classifyGigetError(new Error('Repository does not exist'))).toBe('NOT_FOUND');
  });

  it('classifies auth errors', () => {
    expect(classifyGigetError(new Error('401 Unauthorized'))).toBe('AUTH_ERROR');
    expect(classifyGigetError(new Error('403 Forbidden'))).toBe('AUTH_ERROR');
    expect(classifyGigetError(new Error('Authentication failed'))).toBe('AUTH_ERROR');
    expect(classifyGigetError(new Error('Permission denied'))).toBe('AUTH_ERROR');
  });

  it('classifies disk full errors', () => {
    expect(classifyGigetError(new Error('ENOSPC: no space left on device'))).toBe('DISK_FULL');
    expect(classifyGigetError(new Error('No space left'))).toBe('DISK_FULL');
  });

  it('classifies directory exists errors', () => {
    expect(classifyGigetError(new Error('EEXIST: file already exists'))).toBe('DIRECTORY_EXISTS');
    expect(classifyGigetError(new Error('Directory already exists'))).toBe('DIRECTORY_EXISTS');
  });

  it('classifies network errors', () => {
    expect(classifyGigetError(new Error('ENOTFOUND github.com'))).toBe('NETWORK_ERROR');
    expect(classifyGigetError(new Error('ECONNREFUSED'))).toBe('NETWORK_ERROR');
    expect(classifyGigetError(new Error('ENETUNREACH'))).toBe('NETWORK_ERROR');
    expect(classifyGigetError(new Error('network error'))).toBe('NETWORK_ERROR');
  });

  it('returns UNKNOWN for unrecognized errors', () => {
    expect(classifyGigetError(new Error('something weird happened'))).toBe('UNKNOWN');
  });

  it('handles non-Error values', () => {
    expect(classifyGigetError('string error')).toBe('UNKNOWN');
    expect(classifyGigetError(42)).toBe('UNKNOWN');
  });
});

describe('execGitClone', () => {
  it('spawns git clone with correct args', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');

    // Simulate successful clone
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--single-branch',
        '--progress',
        // The URL and target are values, never flags (DOR-1799).
        '--end-of-options',
        'https://github.com/org/repo.git',
        '/tmp/target',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('runs the clone with the hardened git env and a timeout', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');
    mockProc._emit('close', 0);
    await promise;

    const opts = vi.mocked(spawn).mock.calls[0][2] as {
      env?: NodeJS.ProcessEnv;
      timeout?: number;
    };
    // GIT_ALLOW_PROTOCOL confines the author URL to safe transports (blocks ext::).
    expect(opts.env?.GIT_ALLOW_PROTOCOL).toBe('https:ssh:git');
    // GIT_TERMINAL_PROMPT=0 stops a private URL from hanging on a prompt.
    expect(opts.env?.GIT_TERMINAL_PROMPT).toBe('0');
    // A wall-clock cap bounds a stalled clone.
    expect(opts.timeout).toBeGreaterThan(0);
  });

  it('removes .git directory after successful clone', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');
    mockProc._emit('close', 0);
    await promise;

    expect(rm).toHaveBeenCalledWith('/tmp/target/.git', { recursive: true, force: true });
  });

  it('injects auth token into URL', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target', 'ghp_token');
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['https://x-access-token:ghp_token@github.com/org/repo.git']),
      expect.any(Object)
    );
  });

  it('does not inject auth for non-https URLs', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('git@github.com:org/repo.git', '/tmp/target', 'ghp_token');
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['git@github.com:org/repo.git']),
      expect.any(Object)
    );
  });

  it('rejects on non-zero exit code', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');

    mockProc.stderr!.emit('data', Buffer.from('fatal: repository not found'));
    mockProc._emit('close', 128);

    await expect(promise).rejects.toThrow('git clone exited with code 128');
  });

  it('redacts auth tokens from error messages on failure', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone(
      'https://github.com/org/repo.git',
      '/tmp/target',
      'ghp_secret_token'
    );

    mockProc.stderr!.emit(
      'data',
      Buffer.from(
        'fatal: could not read from https://x-access-token:ghp_secret_token@github.com/org/repo.git'
      )
    );
    mockProc._emit('close', 128);

    await expect(promise).rejects.toThrow('[REDACTED]');
    await expect(promise).rejects.not.toThrow('ghp_secret_token');
  });

  it('rejects on spawn error', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');
    mockProc._emit('error', new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('spawn ENOENT');
  });

  it('parses receiving objects progress from stderr', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const progressCalls: Array<{ percent: number; phase: string }> = [];
    const onProgress = (percent: number, phase: string) => {
      progressCalls.push({ percent, phase });
    };

    const promise = execGitClone(
      'https://github.com/org/repo.git',
      '/tmp/target',
      undefined,
      onProgress
    );

    mockProc.stderr!.emit('data', Buffer.from('Receiving objects:  42% (100/238)'));
    mockProc.stderr!.emit('data', Buffer.from('Receiving objects: 100% (238/238)'));
    mockProc.stderr!.emit('data', Buffer.from('Resolving deltas:  75% (30/40)'));
    mockProc._emit('close', 0);

    await promise;

    expect(progressCalls).toEqual([
      { percent: 42, phase: 'receiving' },
      { percent: 100, phase: 'receiving' },
      { percent: 75, phase: 'resolving' },
    ]);
  });

  it('skips progress parsing when no callback provided', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');

    // Should not throw when emitting stderr data without callback
    mockProc.stderr!.emit('data', Buffer.from('Receiving objects:  42% (100/238)'));
    mockProc._emit('close', 0);

    await promise;
  });
});

describe('downloadTemplate', () => {
  it('uses git clone as primary strategy', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = downloadTemplate('github:org/repo', '/tmp/target');
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalled();
    expect(gigetDownload).not.toHaveBeenCalled();
  });

  it('falls back to giget when git clone fails', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    vi.mocked(gigetDownload).mockResolvedValue({
      dir: '/tmp/target',
      source: 'github:org/repo',
      name: 'repo',
      tar: '',
    });

    const promise = downloadTemplate('github:org/repo', '/tmp/target');

    // Simulate git clone failure
    mockProc._emit('close', 128);

    await promise;

    expect(gigetDownload).toHaveBeenCalledWith('github:org/repo', {
      dir: '/tmp/target',
      force: false,
      auth: undefined,
    });
  });

  it('throws TemplateDownloadError when both strategies fail', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    vi.mocked(gigetDownload).mockRejectedValue(new Error('404 Not Found'));

    const promise = downloadTemplate('github:org/repo', '/tmp/target');
    mockProc._emit('close', 128);

    await expect(promise).rejects.toThrow(TemplateDownloadError);
    await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('enforces 30s timeout on giget fallback', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    // giget takes longer than the timeout — simulate with a delayed resolve
    vi.mocked(gigetDownload).mockImplementation(
      () =>
        new Promise((resolve) => {
          // This resolve will never fire because we mock setTimeout to fire immediately
          setTimeout(
            () => resolve({ dir: '/tmp/target', source: 'x', name: 'x', tar: '' }),
            60_000
          );
        })
    );

    // Capture the timeout duration passed to setTimeout for the giget timeout
    const originalSetTimeout = globalThis.setTimeout;
    let capturedTimeoutMs: number | undefined;
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
        if (ms === 30_000) {
          capturedTimeoutMs = ms;
          // Fire the timeout callback immediately to trigger the timeout error
          if (typeof fn === 'function') (fn as () => void)();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return originalSetTimeout(fn as (...a: unknown[]) => void, ms, ...args);
      });

    const promise = downloadTemplate('github:org/repo', '/tmp/target');

    // Trigger git clone failure to enter giget fallback
    mockProc._emit('close', 128);

    await expect(promise).rejects.toThrow(TemplateDownloadError);
    await expect(promise).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(capturedTimeoutMs).toBe(30_000);

    setTimeoutSpy.mockRestore();
  });

  it('passes auth to giget fallback', async () => {
    mockEnv.GITHUB_TOKEN = 'ghp_test_token';

    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    vi.mocked(gigetDownload).mockResolvedValue({
      dir: '/tmp/target',
      source: 'github:org/repo',
      name: 'repo',
      tar: '',
    });

    const promise = downloadTemplate('github:org/repo', '/tmp/target');
    mockProc._emit('close', 128);
    await promise;

    expect(gigetDownload).toHaveBeenCalledWith(
      'github:org/repo',
      expect.objectContaining({ auth: 'ghp_test_token' })
    );
  });

  it('forwards progress callback to git clone', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const progressCalls: Array<{ percent: number; phase: string }> = [];
    const onProgress = (percent: number, phase: string) => {
      progressCalls.push({ percent, phase });
    };

    const promise = downloadTemplate('github:org/repo', '/tmp/target', onProgress);

    mockProc.stderr!.emit('data', Buffer.from('Receiving objects:  50% (5/10)'));
    mockProc._emit('close', 0);

    await promise;

    expect(progressCalls).toEqual([{ percent: 50, phase: 'receiving' }]);
  });
});
