/**
 * Which addresses the install pipeline will hand to `git` (DOR-1799).
 *
 * `name@<address>` is typed by an operator and turned into a source descriptor
 * by hand, so it never passes the `marketplace.json` schema that confines a
 * package author's clone URL to safe transports. Before this suite existed,
 * `x@ext::sh -c id` travelled from the resolver to `git ls-remote` untouched.
 *
 * Two levels are covered on purpose:
 *
 * - The whole pipeline, with the real resolver and the real fetcher, because
 *   the composition is what the ticket is about — each half looked fine alone.
 * - Each place an address actually becomes argv for `git`, because
 *   `PackageFetcher.fetchFromGit` is NOT the single choke point it reads like:
 *   `gitSubdirResolver` calls `resolveCommitSha` directly and spawns its own
 *   `git clone` through a three-step fallback ladder.
 *
 * `node:child_process` is mocked at module scope, so no test here can run a
 * hostile git command even if a guard regresses — the spies are the evidence
 * that the address stopped short of the subprocess boundary.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isSafeGitUrl, type ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { PackageFetcher, type FetcherDeps } from '../package-fetcher.js';
import { gitSubdirResolver } from '../source-resolvers/git-subdir.js';
import { UNSUPPORTED_GIT_REMOTE_MESSAGE, UnsupportedSourceUrlError } from '../source-url-policy.js';
import type { MarketplaceCache } from '../marketplace-cache.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import { buildInstallerForTests } from './installer-harness.js';

// The subprocess boundary. Mocked at module scope so the assertions below are
// "the address never reached git", not "the address reached git harmlessly".
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        (child as EventEmitter).emit('close', 0);
      });
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }),
    // Callback-style so `promisify(execFile)` wraps it. Empty stdout sends
    // `resolveCommitSha` down its placeholder-SHA path, which is the path an
    // allowed address is supposed to take here.
    execFile: vi
      .fn()
      .mockImplementation(
        (
          _cmd: string,
          _args: readonly string[],
          optionsOrCallback: unknown,
          maybeCallback?: unknown
        ) => {
          const callback =
            typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
          if (typeof callback === 'function') {
            setImmediate(() => {
              (callback as (err: unknown, out: { stdout: string; stderr: string }) => void)(null, {
                stdout: '',
                stderr: '',
              });
            });
          }
          return undefined as unknown as ReturnType<typeof import('node:child_process').execFile>;
        }
      ),
  };
});

/**
 * The shapes a hostile or malformed address arrives in. `ext::` is the one that
 * runs a command; the rest are the neighbours DOR-1710's review probed, kept
 * here so the two doors refuse the same set.
 */
const REFUSED_ADDRESSES = [
  "ext::sh -c 'id > /tmp/dorkos-dor-1799'",
  'file::/tmp/not-a-repo',
  'fd::0/foo',
  '-upload-pack=touch /tmp/dorkos-dor-1799',
  '--upload-pack=touch /tmp/dorkos-dor-1799',
  'http://example.com/repo.git',
];

/** The addresses people really install from, none of which may regress. */
const ALLOWED_ADDRESSES = [
  'https://github.com/foo/bar.git',
  'git@github.com:foo/bar.git',
  'ssh://git@example.com/foo/bar.git',
  'git://example.com/foo/bar.git',
];

/** Fake logger that records nothing but satisfies the constructor. */
function buildLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

/** Cache double whose `materializePackage` runs the clone callback. */
function buildCache(): MarketplaceCache {
  return {
    getPackage: vi.fn().mockResolvedValue(null),
    putPackage: vi
      .fn()
      .mockImplementation(async (name: string, sha: string) => `/tmp/${name}/${sha}`),
    materializePackage: vi
      .fn()
      .mockImplementation(
        async (name: string, sha: string, clone: (tempDir: string) => Promise<void>) => {
          await clone(`/tmp/.tmp-${name}-${sha}`);
          return `/tmp/${name}/${sha}`;
        }
      ),
    readMarketplace: vi.fn().mockResolvedValue(null),
    writeMarketplace: vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketplaceCache;
}

/** Downloader double — the `git clone` seam. */
function buildDownloader(): TemplateDownloader {
  return {
    cloneRepository: vi.fn().mockResolvedValue(undefined),
  } as unknown as TemplateDownloader;
}

describe('install addresses — the whole pipeline', () => {
  let dorkHome: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-install-address-'));
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
  });

  it('refuses a direct `name@ext::…` install before any git subprocess starts', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);
    const { execFile, spawn } = await import('node:child_process');

    await expect(
      installer.install({ name: 'x', source: "ext::sh -c 'id > /tmp/dorkos-dor-1799'" })
    ).rejects.toThrow(UNSUPPORTED_GIT_REMOTE_MESSAGE);

    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  it('refuses it at PREVIEW too, which runs before anyone consents to anything', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);
    const { execFile, spawn } = await import('node:child_process');

    await expect(
      installer.preview({ name: 'x', source: "ext::sh -c 'id > /tmp/dorkos-dor-1799'" })
    ).rejects.toBeInstanceOf(UnsupportedSourceUrlError);

    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(spies.templateClone).not.toHaveBeenCalled();
  });

  it('still clones an https:// address typed the same way', async () => {
    const { installer, spies } = buildInstallerForTests(dorkHome);
    spies.templateClone.mockResolvedValue(undefined);

    // The install fails later — the "clone" wrote nothing, so validation finds
    // no manifest. What this pins is that it got PAST the address check and
    // asked the downloader to clone the URL as typed.
    await installer.install({ name: 'x', source: 'https://example.com/foo/bar.git' }).catch(() => {
      /* validation failure downstream is expected and not what is under test */
    });

    expect(spies.templateClone).toHaveBeenCalledWith(
      'https://example.com/foo/bar.git',
      expect.any(String),
      'main'
    );
  });
});

describe('install addresses — the git seam in PackageFetcher', () => {
  let cache: MarketplaceCache;
  let downloader: TemplateDownloader;
  let fetcher: PackageFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = buildCache();
    downloader = buildDownloader();
    fetcher = new PackageFetcher(cache, downloader, buildLogger());
  });

  it.each(REFUSED_ADDRESSES)('refuses %s without running git', async (address) => {
    const { execFile, spawn } = await import('node:child_process');

    await expect(
      fetcher.fetchPackage({ packageName: 'x', source: { source: 'url', url: address } })
    ).rejects.toBeInstanceOf(UnsupportedSourceUrlError);

    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(downloader.cloneRepository).not.toHaveBeenCalled();
  });

  it.each(ALLOWED_ADDRESSES)('still clones %s', async (address) => {
    await fetcher.fetchPackage({ packageName: 'x', source: { source: 'url', url: address } });

    expect(vi.mocked(downloader.cloneRepository).mock.calls[0]?.[0]).toBe(address);
  });

  it('refuses the same set `isSafeGitUrl` refuses, and no other', () => {
    for (const address of REFUSED_ADDRESSES) {
      expect(isSafeGitUrl(address), address).toBe(false);
    }
    for (const address of ALLOWED_ADDRESSES) {
      expect(isSafeGitUrl(address), address).toBe(true);
    }
  });

  it('serves a file:// address from disk instead of refusing it', async () => {
    const localDir = await mkdtemp(path.join(tmpdir(), 'dorkos-local-package-'));
    try {
      const result = await fetcher.fetchFromGit({
        packageName: 'x',
        gitUrl: `file://${localDir}`,
      });

      expect(result.path).toBe(localDir);
      expect(result.commitSha).toBe('local');
      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    } finally {
      await rm(localDir, { recursive: true, force: true });
    }
  });

  it('refuses through the legacy bare-gitUrl entry as well', async () => {
    await expect(
      fetcher.fetchFromGit({ packageName: 'x', gitUrl: 'ext::sh -c id' })
    ).rejects.toThrow(UNSUPPORTED_GIT_REMOTE_MESSAGE);
  });
});

describe('install addresses — the git-subdir ladder', () => {
  /**
   * `gitSubdirResolver` spawns its own `git clone` and never passes through
   * `fetchFromGit`, so it is checked at its own entry rather than trusting the
   * order its two internal steps happen to run in.
   */
  it('refuses a hostile clone URL before its own spawn or SHA resolution', async () => {
    const { spawn } = await import('node:child_process');
    vi.clearAllMocks();

    const deps = {
      cache: buildCache(),
      logger: buildLogger(),
      cloneRepository: vi.fn(),
      resolveCommitSha: vi.fn().mockResolvedValue('deadbeef'),
    } as unknown as FetcherDeps;

    const resolved = {
      type: 'git-subdir',
      cloneUrl: 'ext::sh -c id',
      subpath: 'plugins/qa',
    } as Extract<ResolvedSourceDescriptor, { type: 'git-subdir' }>;

    await expect(gitSubdirResolver(resolved, { packageName: 'qa' }, deps)).rejects.toBeInstanceOf(
      UnsupportedSourceUrlError
    );

    expect(deps.resolveCommitSha).not.toHaveBeenCalled();
    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});
