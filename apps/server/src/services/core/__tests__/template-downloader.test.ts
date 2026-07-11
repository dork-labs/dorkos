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
import {
  resolveGitUrl,
  resolveGitAuth,
  classifyGigetError,
  execGitClone,
  downloadTemplate,
  redactAuthTokens,
  TemplateDownloadError,
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
