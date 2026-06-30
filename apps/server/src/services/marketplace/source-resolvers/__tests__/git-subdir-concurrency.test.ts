/**
 * Concurrency + error-surfacing regression for the git-subdir resolver.
 *
 * This is the regression suite for the failing `flow` github-subdir install:
 * the DorkOS UI fires a *preview* and an *install* for the same package, so
 * two `git clone` processes targeted the identical cache directory and
 * collided on git's template-copy step (git exit 128). The empty staged dir
 * then made `validatePackage` throw a misleading "manifest missing" error.
 *
 * Unlike the sibling `git-subdir.test.ts`, this file does NOT mock
 * `node:fs/promises`: it drives the resolver through a *real*
 * {@link MarketplaceCache} so the clone-to-temp-then-atomic-rename and the
 * in-flight de-dup are exercised end to end. Only `node:child_process.spawn`
 * is faked, so the "clone" is a controllable stand-in for the git binary.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import { gitSubdirResolver } from '../git-subdir.js';
import { MarketplaceCache } from '../../marketplace-cache.js';
import type { FetcherDeps, FetchPackageOptions } from '../../package-fetcher.js';

const CLONE_URL = 'https://github.com/dork-labs/marketplace.git';
const SUBPATH = 'plugins/flow';

const RESOLVED_DESCRIPTOR = {
  type: 'git-subdir' as const,
  cloneUrl: CLONE_URL,
  subpath: SUBPATH,
};

/** A fake `git` child process that emits `close` with `code` on the next tick. */
function makeFakeChild(
  code: number,
  stderr = '',
  onSpawn?: () => Promise<void> | void
): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stderrEmitter = new EventEmitter();
  // @ts-expect-error — partial child_process surface
  emitter.stderr = stderrEmitter;
  setImmediate(() => {
    void (async () => {
      await onSpawn?.();
      if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
      emitter.emit('close', code);
    })();
  });
  return emitter;
}

describe('gitSubdirResolver: concurrency + error surfacing (real cache)', () => {
  let dorkHome: string;
  let cache: MarketplaceCache;

  beforeEach(async () => {
    vi.clearAllMocks();
    dorkHome = await mkdtemp(join(tmpdir(), 'git-subdir-concurrency-'));
    cache = new MarketplaceCache(dorkHome);
  });

  afterEach(async () => {
    await rm(dorkHome, { recursive: true, force: true });
  });

  function buildDeps(): FetcherDeps {
    return {
      cache,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      cloneRepository: vi.fn(),
      resolveCommitSha: vi.fn().mockResolvedValue('deadbeef'),
    };
  }

  function buildOpts(): FetchPackageOptions {
    return {
      packageName: 'flow',
      source: { source: 'git-subdir', url: CLONE_URL, path: SUBPATH },
    };
  }

  it('two concurrent fetches of the same package both succeed and clone exactly once', async () => {
    let cloneCount = 0;
    // Successful clone seeds a marker into its temp target so the materialized
    // package is non-empty; every follow-up sparse-checkout command succeeds.
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: readonly string[]) => {
      if (args[0] !== 'clone') return makeFakeChild(0);
      cloneCount += 1;
      const target = args[args.length - 1] as string;
      return makeFakeChild(0, '', async () => {
        await writeFile(join(target, '.dork-manifest.json'), '{}\n');
      });
    }) as unknown as typeof spawn);

    const [a, b] = await Promise.all([
      gitSubdirResolver(RESOLVED_DESCRIPTOR, buildOpts(), buildDeps()),
      gitSubdirResolver(RESOLVED_DESCRIPTOR, buildOpts(), buildDeps()),
    ]);

    const expectedPath = join(cache.cacheRoot, 'packages', 'flow@deadbeef', SUBPATH);
    expect(a.path).toBe(expectedPath);
    expect(b.path).toBe(expectedPath);
    expect(a.commitSha).toBe('deadbeef');
    // Only one clone may run; the second fetch awaits the in-flight result.
    expect(cloneCount).toBe(1);
  });

  it('surfaces the real clone failure (git stderr + exit 128), not a validation error', async () => {
    vi.mocked(spawn).mockImplementation((() =>
      makeFakeChild(
        128,
        "fatal: cannot copy '/opt/homebrew/opt/git/share/git-core/templates/info/exclude' to '.git/info/exclude': File exists"
      )) as unknown as typeof spawn);

    await expect(gitSubdirResolver(RESOLVED_DESCRIPTOR, buildOpts(), buildDeps())).rejects.toThrow(
      /cannot copy .*File exists/
    );

    // The failed clone left no valid package behind, so a subsequent fetch is
    // free to retry rather than reading an empty dir as a "manifest missing".
    expect(await cache.getPackage('flow', 'deadbeef')).toBeNull();
  });
});
