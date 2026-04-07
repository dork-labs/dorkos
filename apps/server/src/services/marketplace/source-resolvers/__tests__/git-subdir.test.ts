/**
 * Tests for the git-subdir source resolver.
 *
 * Mocks `child_process.spawn` to simulate every step of the canonical
 * 4-step sequence and the two fallback ladder paths. The integration test
 * (gated on `INTEGRATION=true`) performs a real sparse clone against a
 * small public GitHub repo so the canonical sequence is exercised against
 * a live git binary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock child_process before importing the module under test.
// Also mock fs/promises so the resolver's readdir/rm calls in the
// fallback ladder do not hit the real filesystem.
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  rm: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import { gitSubdirResolver } from '../git-subdir.js';
import type { FetcherDeps, FetchPackageOptions } from '../../package-fetcher.js';

/**
 * Minimal `ChildProcess` stand-in that immediately emits `close` with the
 * given exit code (and an optional stderr line for the failure heuristics).
 */
function makeFakeChild(code: number, stderr = ''): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess;
  const stderrEmitter = new EventEmitter();
  // @ts-expect-error — partial child_process surface
  emitter.stderr = stderrEmitter;
  // Schedule emit on next tick so listeners can attach first.
  setImmediate(() => {
    if (stderr) stderrEmitter.emit('data', Buffer.from(stderr));
    emitter.emit('close', code);
  });
  return emitter;
}

function buildDeps(): FetcherDeps & {
  cloneRepository: ReturnType<typeof vi.fn>;
  resolveCommitSha: ReturnType<typeof vi.fn>;
} {
  const cacheGetPackage = vi.fn().mockResolvedValue(null);
  const cachePutPackage = vi.fn().mockResolvedValue('/cache/qa-plugin@deadbeef');
  return {
    cache: {
      getPackage: cacheGetPackage,
      putPackage: cachePutPackage,
      readMarketplace: vi.fn(),
      writeMarketplace: vi.fn(),
    } as unknown as FetcherDeps['cache'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    cloneRepository: vi.fn(),
    resolveCommitSha: vi.fn().mockResolvedValue('deadbeef'),
  };
}

function buildOpts(overrides: Partial<FetchPackageOptions> = {}): FetchPackageOptions {
  return {
    packageName: 'qa-plugin',
    source: {
      source: 'git-subdir',
      url: 'https://github.com/foo/monorepo.git',
      path: 'plugins/qa',
    },
    ...overrides,
  };
}

describe('gitSubdirResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the canonical 4-step sparse-clone sequence on the happy path', async () => {
    // 4 successful spawns: clone, init, set, checkout.
    // Use mockImplementation so a fresh ChildProcess fixture is returned per
    // call (the setImmediate-scheduled emit can only fire once per emitter).
    vi.mocked(spawn).mockImplementation(() => makeFakeChild(0));

    const result = await gitSubdirResolver(
      {
        type: 'git-subdir',
        cloneUrl: 'https://github.com/foo/monorepo.git',
        subpath: 'plugins/qa',
      },
      buildOpts(),
      buildDeps()
    );

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(4);
    const calls = vi.mocked(spawn).mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(calls[0]).toContain('clone');
    expect(calls[0]).toContain('--filter=blob:none');
    expect(calls[0]).toContain('--no-checkout');
    expect(calls[0]).toContain('--depth=1');
    expect(calls[1]).toContain('sparse-checkout init');
    expect(calls[2]).toContain('sparse-checkout set');
    expect(calls[2]).toContain('plugins/qa');
    expect(calls[3]).toContain('checkout');

    expect(result.commitSha).toBe('deadbeef');
    expect(result.fromCache).toBe(false);
    expect(result.path).toBe('/cache/qa-plugin@deadbeef/plugins/qa');
  });

  it('short-circuits with cache hit before any spawn call', async () => {
    const deps = buildDeps();
    (deps.cache.getPackage as ReturnType<typeof vi.fn>).mockResolvedValue({
      packageName: 'qa-plugin',
      commitSha: 'deadbeef',
      path: '/cache/qa-plugin@deadbeef',
      cachedAt: new Date(),
    });

    const result = await gitSubdirResolver(
      {
        type: 'git-subdir',
        cloneUrl: 'https://github.com/foo/monorepo.git',
        subpath: 'plugins/qa',
      },
      buildOpts(),
      deps
    );

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.path).toBe('/cache/qa-plugin@deadbeef/plugins/qa');
  });

  it('falls back to shallow clone when --filter is unsupported', async () => {
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount += 1;
      // Step 1 (canonical clone) fails with the filter-unsupported stderr.
      // Steps 2-5 (fallback shallow clone + sparse-checkout sequence) all succeed.
      if (callCount === 1) {
        return makeFakeChild(
          128,
          'fatal: server does not support --filter=blob:none (uploadpack.allowFilter)'
        );
      }
      return makeFakeChild(0);
    });

    const deps = buildDeps();
    await gitSubdirResolver(
      {
        type: 'git-subdir',
        cloneUrl: 'https://github.com/foo/monorepo.git',
        subpath: 'plugins/qa',
      },
      buildOpts(),
      deps
    );

    // 1 failed canonical clone + 4 fallback steps = 5 spawn calls.
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(5);
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to shallow clone'),
      expect.any(Object)
    );
    // Second clone call should NOT include --filter.
    const fallbackClone = (vi.mocked(spawn).mock.calls[1]?.[1] as string[]).join(' ');
    expect(fallbackClone).not.toContain('--filter');
  });

  it('falls back to full clone + cleanup when sparse-checkout is unsupported', async () => {
    let callCount = 0;
    vi.mocked(spawn).mockImplementation(() => {
      callCount += 1;
      // First spawn (canonical clone) succeeds.
      // Second spawn (sparse-checkout init) fails with sparse-checkout-unknown stderr.
      // Subsequent fallback spawns succeed.
      if (callCount === 2) {
        return makeFakeChild(1, "git: 'sparse-checkout' is not a git command. See 'git --help'.");
      }
      return makeFakeChild(0);
    });
    vi.mocked(readdir).mockResolvedValue(['.git', 'plugins', 'docs', 'README.md'] as never);
    vi.mocked(rm).mockResolvedValue(undefined);

    const deps = buildDeps();
    await gitSubdirResolver(
      {
        type: 'git-subdir',
        cloneUrl: 'https://github.com/foo/monorepo.git',
        subpath: 'plugins/qa',
      },
      buildOpts(),
      deps
    );

    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('full clone + cleanup'),
      expect.any(Object)
    );
    // Cleanup should remove `docs` and `README.md` but keep `.git` and `plugins`.
    const removed = vi.mocked(rm).mock.calls.map((c) => c[0]);
    expect(removed.some((p) => String(p).endsWith('docs'))).toBe(true);
    expect(removed.some((p) => String(p).endsWith('README.md'))).toBe(true);
    expect(removed.some((p) => String(p).endsWith('.git'))).toBe(false);
    expect(removed.some((p) => String(p).endsWith('plugins'))).toBe(false);
  });

  it('rethrows unrelated errors as-is', async () => {
    vi.mocked(spawn).mockImplementation(() => makeFakeChild(128, 'fatal: repository not found'));

    await expect(
      gitSubdirResolver(
        {
          type: 'git-subdir',
          cloneUrl: 'https://github.com/foo/missing.git',
          subpath: 'plugins/qa',
        },
        buildOpts(),
        buildDeps()
      )
    ).rejects.toThrow(/repository not found/);
  });

  it('passes the SHA as the checkout target when sha is pinned', async () => {
    vi.mocked(spawn).mockImplementation(() => makeFakeChild(0));
    const sha = 'a'.repeat(40);
    const deps = buildDeps();
    (deps.resolveCommitSha as ReturnType<typeof vi.fn>).mockResolvedValue(sha);

    await gitSubdirResolver(
      {
        type: 'git-subdir',
        cloneUrl: 'https://github.com/foo/monorepo.git',
        subpath: 'plugins/qa',
        sha,
      },
      buildOpts(),
      deps
    );

    // The checkout step (4th spawn) should reference the SHA.
    const checkoutCall = (vi.mocked(spawn).mock.calls[3]?.[1] as string[]).join(' ');
    expect(checkoutCall).toBe(`checkout ${sha}`);
    expect(deps.resolveCommitSha).toHaveBeenCalledWith('https://github.com/foo/monorepo.git', sha);
  });
});

// Integration test gated on the INTEGRATION env flag.
//
// The live sparse-clone integration test against a real public monorepo
// lives in a separate test file (`git-subdir.integration.test.ts`) so that
// `vi.unmock()` calls don't hoist alongside the unit-test `vi.mock()` calls
// in this file (which would silently neutralise the mock).
describe.skip('gitSubdirResolver (integration placeholder)', () => {
  it('see git-subdir.integration.test.ts for the live network test', () => {
    expect(true).toBe(true);
  });
});
