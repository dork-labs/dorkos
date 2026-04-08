/**
 * Tests for the github source resolver. Mocks `deps.cloneRepository` and
 * asserts on the call shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { githubResolver } from '../github.js';
import type { FetcherDeps, FetchedPackage, FetchPackageOptions } from '../../package-fetcher.js';

function buildDeps(): FetcherDeps & {
  cloneRepository: ReturnType<typeof vi.fn>;
  resolveCommitSha: ReturnType<typeof vi.fn>;
} {
  return {
    cache: {} as FetcherDeps['cache'],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    cloneRepository: vi.fn().mockResolvedValue({
      path: '/cache/qa-plugin@deadbeef',
      commitSha: 'deadbeef',
      fromCache: false,
    } satisfies FetchedPackage),
    resolveCommitSha: vi.fn().mockResolvedValue('deadbeef'),
  };
}

function buildOpts(overrides: Partial<FetchPackageOptions> = {}): FetchPackageOptions {
  return {
    packageName: 'qa-plugin',
    source: { source: 'github', repo: 'dorkos/qa-plugin' },
    ...overrides,
  };
}

describe('githubResolver', () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it('clones the canonical https github URL', async () => {
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
      },
      buildOpts(),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledTimes(1);
    expect(deps.cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
        packageName: 'qa-plugin',
      })
    );
  });

  it('pins to sha when sha is provided', async () => {
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
        sha: 'a'.repeat(40),
      },
      buildOpts(),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'a'.repeat(40) })
    );
  });

  it('pins to ref when only ref is provided', async () => {
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
        ref: 'develop',
      },
      buildOpts(),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: 'develop' }));
  });

  it("defaults to 'main' when neither sha nor ref is provided", async () => {
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
      },
      buildOpts(),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: 'main' }));
  });

  it('prefers sha over ref when both are provided (pin precedence)', async () => {
    const sha = 'b'.repeat(40);
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
        ref: 'develop',
        sha,
      },
      buildOpts(),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: sha }));
  });

  it('forwards the force flag', async () => {
    await githubResolver(
      {
        type: 'github',
        repo: 'dorkos/qa-plugin',
        cloneUrl: 'https://github.com/dorkos/qa-plugin.git',
      },
      buildOpts({ force: true }),
      deps
    );

    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
});
