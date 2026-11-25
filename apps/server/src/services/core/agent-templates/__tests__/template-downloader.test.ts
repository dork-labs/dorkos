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

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../env.js', () => ({
  env: {} as Record<string, string | undefined>,
}));

import { spawn, execSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { downloadTemplate as gigetDownload } from 'giget';
import { env as mockEnv } from '../../../../env.js';
import {
  resolveGitUrl,
  resolveGitAuth,
  classifyGigetError,
  execGitClone,
  downloadTemplate,
  isGitHubCredentialHost,
  gitHubAuthConfig,
  withGitHubToken,
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

describe('resolveGitUrl', () => {
  it.each([
    ['github:org/repo', 'https://github.com/org/repo.git'],
    ['bitbucket:org/repo', 'https://bitbucket.org/org/repo.git'],
    ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
    ['org/repo', 'https://github.com/org/repo.git'],
  ])('resolves %s to %s', (source, expected) => {
    expect(resolveGitUrl(source)).toBe(expected);
  });
});

/**
 * Which addresses a workspace template may be downloaded from (DOR-1825).
 * The giget fallback receives the RAW source and its git provider clones it
 * with none of `hardenedGitEnv`'s confinement, so the door refuses first.
 */
describe('template sources — which addresses may be downloaded from', () => {
  /** `ext+git::` actually reached an unconfined `git clone` via giget. */
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
    // are not, so the shared `isSafeGitUrl` check is doing work.
    'git@-oProxyCommand=id:x/y',
    'git@evil.example.com/no-colon',
    // A `#ref` is honoured only on a shorthand, and only a plausible one.
    'github:org/repo#-oProxyCommand=id',
    'github:org/repo#../../etc',
    'github:org/repo#with space',
    'github:org/repo#',
    'github:org/repo#a#b',
    'org/repo#dev',
  ];

  /** The templates people really install from, none of which may regress. */
  const ALLOWED_SOURCES = [
    'github:org/repo',
    'gitlab:org/repo',
    // The subpath shorthand a marketplace agent listing becomes.
    'github:dork-labs/marketplace/plugins/qa-agent',
    'org/repo',
    'https://github.com/org/repo.git',
    'git@github.com:org/repo.git',
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
});

describe('resolveGitAuth', () => {
  afterEach(() => {
    delete mockEnv.GITHUB_TOKEN;
  });

  it('falls back to gh auth token CLI', () => {
    vi.mocked(execSync).mockReturnValue('gho_cli_token\n');
    expect(resolveGitAuth()).toBe('gho_cli_token');
  });

  it('prefers GITHUB_TOKEN over gh CLI', () => {
    mockEnv.GITHUB_TOKEN = 'ghp_env_token';
    vi.mocked(execSync).mockReturnValue('gho_cli_token\n');
    expect(resolveGitAuth()).toBe('ghp_env_token');
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe('classifyGigetError', () => {
  it.each([
    ['Operation timed out', 'TIMEOUT'],
    ['404 Not Found', 'NOT_FOUND'],
    ['403 Forbidden', 'AUTH_ERROR'],
    ['ENOTFOUND github.com', 'NETWORK_ERROR'],
    ['something weird happened', 'UNKNOWN'],
  ])('classifies "%s" as %s', (message, code) => {
    expect(classifyGigetError(new Error(message))).toBe(code);
  });
});

/**
 * Where the operator's GitHub token is allowed to travel (DOR-1833): only to
 * the host it belongs to. `execGitClone` decides by EXACT host (never a
 * substring: `github.com.evil.com` contains it). The giget path cannot decide
 * by host at all, since giget fetches a tarball URL the REMOTE names, so only
 * the `github:` shorthand keeps the token.
 */
describe('the GitHub token only ever goes to GitHub', () => {
  /** The clone URL `execGitClone` handed to `git` — argv is `[…, url, target]`. */
  function spawnedCloneUrl(): string {
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    return args[args.length - 2];
  }

  /** Run one clone to completion and return the URL git was given. */
  async function cloneUrlFor(url: string, auth?: string): Promise<string> {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);
    const promise = execGitClone(url, '/tmp/target', auth);
    mockProc._emit('close', 0);
    await promise;
    return spawnedCloneUrl();
  }

  describe('isGitHubCredentialHost — the comparison itself', () => {
    it.each([
      ['https://github.com/org/repo.git', true],
      ['https://GITHUB.COM/org/repo.git', true],
      ['https://gist.github.com/abc123.git', true],
      ['https://www.github.com/org/repo.git', true],
      // Bypass shapes: each contains `github.com`, none IS github.com.
      ['https://github.com.evil.com/org/repo.git', false],
      ['https://notgithub.com/org/repo.git', false],
      ['https://evil.com/github.com/repo.git', false],
      ['https://github.com@evil.com/org/repo.git', false],
      ['https://evil.com/?x=https://github.com/', false],
      // Right host, wrong everything else.
      ['https://github.com:8443/org/repo.git', false],
      ['http://github.com/org/repo.git', false],
      ['https://someone:secret@github.com/org/repo.git', false],
      // Not an https address, or not an address at all.
      ['git@github.com:org/repo.git', false],
      ['ssh://git@github.com/org/repo.git', false],
      ['github:org/repo', false],
      ['not a url', false],
      ['', false],
    ])('%s → %s', (url, expected) => {
      expect(isGitHubCredentialHost(url)).toBe(expected);
    });
  });

  describe('execGitClone — the URL rewrite', () => {
    it('attaches the token to a github.com clone', async () => {
      expect(await cloneUrlFor('https://github.com/org/repo.git', 'ghp_token')).toBe(
        'https://x-access-token:ghp_token@github.com/org/repo.git'
      );
    });

    it('sends no credential to a third-party host', async () => {
      expect(await cloneUrlFor('https://evil.example.com/org/repo.git', 'ghp_token')).toBe(
        'https://evil.example.com/org/repo.git'
      );
      expect(JSON.stringify(vi.mocked(spawn).mock.calls[0])).not.toContain('ghp_token');
    });

    it('sends no credential to a host that merely ends in github.com', async () => {
      expect(await cloneUrlFor('https://github.com.evil.com/org/repo.git', 'ghp_token')).toBe(
        'https://github.com.evil.com/org/repo.git'
      );
    });
  });

  describe('withGitHubToken — the rewrite execGitClone and old git share', () => {
    // The marketplace fetch calls this directly on git older than 2.31, so
    // the gate is pinned here on its own.
    it.each([
      ['https://github.com/org/repo.git', 'https://x-access-token:ghp_t@github.com/org/repo.git'],
      ['https://github.com.evil.com/org/repo.git', 'https://github.com.evil.com/org/repo.git'],
      ['HTTPS://github.com/org/repo.git', 'HTTPS://github.com/org/repo.git'],
      ['git@github.com:org/repo.git', 'git@github.com:org/repo.git'],
    ])('%s → %s', (url, expected) => {
      expect(withGitHubToken(url, 'ghp_t')).toBe(expected);
    });

    it('sends nothing when there is no token', () => {
      expect(withGitHubToken('https://github.com/org/repo.git', undefined)).toBe(
        'https://github.com/org/repo.git'
      );
    });
  });

  describe('gitHubAuthConfig — the header the marketplace fetch sends', () => {
    // The marketplace fetch hands this to git through its environment, so the
    // host gate is pinned here on its own.
    it('scopes a Basic x-access-token header to a GitHub origin', () => {
      expect(gitHubAuthConfig('https://github.com/org/repo.git', 'ghp_t')).toEqual({
        key: 'http.https://github.com/.extraHeader',
        value: `Authorization: Basic ${Buffer.from('x-access-token:ghp_t').toString('base64')}`,
      });
      expect(gitHubAuthConfig('https://www.github.com/o/r.git', 'ghp_t')?.key).toBe(
        'http.https://www.github.com/.extraHeader'
      );
    });

    it.each(['https://github.com.evil.com/org/repo.git', 'git@github.com:org/repo.git'])(
      'sends nothing to %s',
      (url) => {
        expect(gitHubAuthConfig(url, 'ghp_t')).toBeUndefined();
      }
    );

    it('sends nothing when there is no token', () => {
      expect(gitHubAuthConfig('https://github.com/org/repo.git', undefined)).toBeUndefined();
    });
  });

  describe('giget fallback — the auth option', () => {
    /** Fail the clone so the fallback runs, and report giget's `auth` argument. */
    async function gigetAuthFor(source: string): Promise<string | undefined> {
      // Cleared per call so a test may ask about more than one source and still
      // read the answer for the one it just asked about.
      vi.mocked(gigetDownload).mockClear();
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);
      vi.mocked(gigetDownload).mockResolvedValue({
        dir: '/tmp/target',
        source,
        name: 'repo',
        tar: '',
      });

      const promise = downloadTemplate(source, '/tmp/target');
      mockProc._emit('close', 128);
      await promise;

      const opts = vi.mocked(gigetDownload).mock.calls[0][1] as { auth?: string };
      return opts.auth;
    }

    beforeEach(() => {
      mockEnv.GITHUB_TOKEN = 'ghp_giget';
    });

    it('passes the token for the github: shorthand', async () => {
      expect(await gigetAuthFor('github:org/repo')).toBe('ghp_giget');
    });

    it.each([
      // Really github.com, but giget reads the REMOTE's JSON and fetches whatever
      // host its `tar` field names, so no https address is safe here.
      'https://github.com/attacker/repo/raw/main/template.json',
      'https://github.com/org/repo.git',
      'gitlab:org/repo',
      // A bare source goes to giget's registry, whose JSON names any host.
      'org/repo',
    ])('withholds the token from %s', async (source) => {
      expect(await gigetAuthFor(source)).toBeUndefined();
    });
  });
});

describe('execGitClone', () => {
  it('spawns a hardened, bounded git clone and removes its .git directory', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc);

    const promise = execGitClone('https://github.com/org/repo.git', '/tmp/target');
    mockProc._emit('close', 0);
    await promise;

    expect(spawn).toHaveBeenCalledWith(
      'git',
      [
        // Git before 2.31 ignores the environment copy of the hardening (DOR-2326).
        '-c',
        'safe.bareRepository=explicit',
        '-c',
        'core.fsmonitor=',
        '-c',
        `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
        '-c',
        'submodule.recurse=false',
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
    expect(rm).toHaveBeenCalledWith('/tmp/target/.git', { recursive: true, force: true });
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
});

describe('downloadTemplate', () => {
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
});
