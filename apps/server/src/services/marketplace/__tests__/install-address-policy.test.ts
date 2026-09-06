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
 * The LOCAL half of the same door lives here too (DOR-1825). An install address
 * has two local spellings — `./some/path` and `file:///some/path` — and the
 * question they have to answer together is the directory boundary, not the
 * transport allowlist. Only the first one answered it until DOR-1825.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isSafeGitUrl, type ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { PackageFetcher, type FetcherDeps } from '../package-fetcher.js';
import { gitSubdirResolver } from '../source-resolvers/git-subdir.js';
import { UNSUPPORTED_GIT_REMOTE_MESSAGE, UnsupportedSourceUrlError } from '../source-url-policy.js';
import type { MarketplaceCache } from '../marketplace-cache.js';
import type { TemplateDownloader } from '../../core/template-downloader.js';
import { BoundaryError, initBoundary } from '../../../lib/boundary.js';
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
 * runs a command; the rest are the neighbours DOR-1710's review probed, plus
 * the two cleartext transports — `http://` and `git://` — that authenticate
 * nobody and protect nothing, which is not a transport to execute code from.
 */
const REFUSED_ADDRESSES = [
  "ext::sh -c 'id > /tmp/dorkos-dor-1799'",
  'file::/tmp/not-a-repo',
  'fd::0/foo',
  '-upload-pack=touch /tmp/dorkos-dor-1799',
  '--upload-pack=touch /tmp/dorkos-dor-1799',
  'http://example.com/repo.git',
  'git://example.com/foo/bar.git',
];

/**
 * The one address the install door refuses that {@link isSafeGitUrl} allows.
 * Kept separate so the divergence is stated once, on purpose, instead of
 * quietly weakening the agreement check below.
 */
const NARROWED_BEYOND_SCHEMA = 'git://example.com/foo/bar.git';

/** The addresses people really install from, none of which may regress. */
const ALLOWED_ADDRESSES = [
  'https://github.com/foo/bar.git',
  'git@github.com:foo/bar.git',
  'ssh://git@example.com/foo/bar.git',
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
  let boundaryRoot: string;
  let outside: string;

  beforeEach(async () => {
    dorkHome = await mkdtemp(path.join(tmpdir(), 'dorkos-install-address-'));
    await mkdir(path.join(dorkHome, 'plugins'), { recursive: true });
    boundaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-in-boundary-')));
    outside = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-out-of-boundary-')));
    await initBoundary(boundaryRoot);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dorkHome, { recursive: true, force: true }).catch(() => undefined);
    await rm(boundaryRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
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

  it('gives one answer to a directory outside the boundary, whichever way it is spelled', async () => {
    // The alignment DOR-1825 is about. `./some/path` and `file:///some/path`
    // name the same directory and take different branches through the
    // resolver, so the only way the boundary means anything is if both branches
    // ask it. Asserted as a pair on purpose: split apart, either half reads as
    // a test of its own branch rather than of the agreement between them.
    const { installer } = buildInstallerForTests(dorkHome);

    await expect(installer.install({ name: outside })).rejects.toBeInstanceOf(BoundaryError);
    await expect(
      installer.install({ name: 'x', source: pathToFileURL(outside).href })
    ).rejects.toBeInstanceOf(BoundaryError);
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

  it('the fixture lists agree with `isSafeGitUrl`, except the one deliberate narrowing', () => {
    // Not a test of the guard — it never calls it. It is what keeps the two
    // lists above honest: every refused address is one the shared predicate
    // also refuses, so this file cannot drift into asserting a policy the rest
    // of the marketplace does not hold. `git://` is the single exception, and
    // naming it here is how the divergence stays a decision rather than a bug.
    for (const address of REFUSED_ADDRESSES) {
      if (address === NARROWED_BEYOND_SCHEMA) {
        expect(isSafeGitUrl(address), address).toBe(true);
        continue;
      }
      expect(isSafeGitUrl(address), address).toBe(false);
    }
    for (const address of ALLOWED_ADDRESSES) {
      expect(isSafeGitUrl(address), address).toBe(true);
    }
  });

  /**
   * The local half of the door (DOR-1825). A `file://` address is served from
   * disk rather than handed to `git`, so the transport allowlist has nothing to
   * say about it — the directory boundary does, exactly as it does for the
   * `./some/path` spelling of the same request.
   */
  describe('the file:// branch, which never reaches git', () => {
    let boundaryRoot: string;
    let outside: string;

    beforeEach(async () => {
      // Realpath'd because `initBoundary` canonicalizes its argument, and on
      // macOS `os.tmpdir()` is a symlink — an un-resolved root would compare
      // against a location neither side reaches.
      boundaryRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-in-boundary-')));
      outside = await realpath(await mkdtemp(path.join(tmpdir(), 'dorkos-out-of-boundary-')));
      await initBoundary(boundaryRoot);
    });

    afterEach(async () => {
      await rm(boundaryRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(outside, { recursive: true, force: true }).catch(() => undefined);
    });

    it('serves a file:// package inside the boundary from disk', async () => {
      const pkgDir = path.join(boundaryRoot, 'my-plugin');
      await mkdir(pkgDir, { recursive: true });

      const result = await fetcher.fetchFromGit({
        packageName: 'x',
        gitUrl: pathToFileURL(pkgDir).href,
      });

      expect(result.path).toBe(pkgDir);
      expect(result.commitSha).toBe('local');
      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('refuses a file:// package outside the boundary', async () => {
      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: pathToFileURL(outside).href })
      ).rejects.toBeInstanceOf(BoundaryError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('refuses a file:// path that climbs out of the boundary with `..`', async () => {
      // Hand-built rather than via `pathToFileURL`, which would have no `..` to
      // carry. `new URL` normalizes the segment away, so what the fetcher
      // actually converts is the escaped destination — which is the point: the
      // boundary is what refuses it, not the spelling.
      const climbing = `file://${boundaryRoot}/../${path.basename(outside)}`;

      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: climbing })
      ).rejects.toBeInstanceOf(BoundaryError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('refuses a file:// path that climbs out with a percent-encoded `..`', async () => {
      // `new URL` leaves `%2e%2e` alone where it would have normalized a bare
      // `..`; `fileURLToPath` decodes it afterwards. So the escape survives URL
      // parsing and arrives as a real `..` on the path — which is why the
      // boundary canonicalizes with `realpath` instead of judging the spelling.
      const encoded = `file://${boundaryRoot}/%2e%2e/${path.basename(outside)}`;

      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: encoded })
      ).rejects.toBeInstanceOf(BoundaryError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('refuses a file://localhost/… address, which drops its host and keeps the path', async () => {
      // The one host segment `fileURLToPath` accepts rather than rejecting, so
      // it is the one that still reaches the boundary check.
      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: `file://localhost${outside}` })
      ).rejects.toBeInstanceOf(BoundaryError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('refuses a file:// path whose symlink leads out of the boundary', async () => {
      const link = path.join(boundaryRoot, 'looks-local');
      await symlink(outside, link, 'dir');

      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: pathToFileURL(link).href })
      ).rejects.toBeInstanceOf(BoundaryError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });

    it('does not treat an upper-case FILE:// address as a local path', async () => {
      // `isFileUrl` is deliberately case-sensitive, so this address falls
      // through to the git door and is refused as an unsupported transport
      // rather than quietly bypassing the boundary check above.
      await expect(
        fetcher.fetchFromGit({ packageName: 'x', gitUrl: `FILE://${outside}` })
      ).rejects.toBeInstanceOf(UnsupportedSourceUrlError);

      expect(downloader.cloneRepository).not.toHaveBeenCalled();
    });
  });

  it('refuses through the legacy bare-gitUrl entry as well', async () => {
    await expect(
      fetcher.fetchFromGit({ packageName: 'x', gitUrl: 'ext::sh -c id' })
    ).rejects.toThrow(UNSUPPORTED_GIT_REMOTE_MESSAGE);
  });

  describe('the `resolveCommitSha` door on its own', () => {
    /**
     * The door a resolver reaches without passing through `fetchFromGit` —
     * `FetcherDeps.resolveCommitSha`, which is what `gitSubdirResolver` calls.
     * Exercised directly because every path that reaches it today is stopped
     * earlier by another guard, so without this the line could be deleted with
     * the whole suite still green.
     */
    function buildDeps(): FetcherDeps {
      return (fetcher as unknown as { buildFetcherDeps(): FetcherDeps }).buildFetcherDeps();
    }

    it('refuses a hostile address instead of degrading to a placeholder SHA', async () => {
      const { execFile } = await import('node:child_process');

      await expect(buildDeps().resolveCommitSha('ext::sh -c id', 'HEAD')).rejects.toBeInstanceOf(
        UnsupportedSourceUrlError
      );

      expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    });

    it('still resolves an allowed address through `git ls-remote`', async () => {
      const { execFile } = await import('node:child_process');

      // The mocked `ls-remote` returns empty stdout, so the method takes its
      // placeholder-SHA path. This half is what distinguishes "the guard fired"
      // from "the method is broken" — without it, a method that threw for
      // everything would pass the case above.
      await expect(
        buildDeps().resolveCommitSha('https://example.com/foo/bar.git', 'HEAD')
      ).resolves.toMatch(/^tmp-\d+$/);

      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    });
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
