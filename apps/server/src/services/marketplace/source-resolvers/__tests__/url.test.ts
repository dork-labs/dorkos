/**
 * Tests for the generic URL source resolver. Mocks `deps.cloneRepository`
 * and asserts on the call shape across the three supported URL flavors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { urlResolver } from '../url.js';
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
    source: { source: 'url', url: 'https://example.com/foo.git' },
    ...overrides,
  };
}

describe('urlResolver', () => {
  let deps: ReturnType<typeof buildDeps>;

  beforeEach(() => {
    deps = buildDeps();
  });

  it('passes through https URLs with .git suffix', async () => {
    await urlResolver({ type: 'url', url: 'https://example.com/foo.git' }, buildOpts(), deps);
    expect(deps.cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        cloneUrl: 'https://example.com/foo.git',
        ref: 'main',
      })
    );
  });

  it('passes through git@ ssh URLs', async () => {
    await urlResolver({ type: 'url', url: 'git@gitlab.com:owner/repo.git' }, buildOpts(), deps);
    expect(deps.cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({ cloneUrl: 'git@gitlab.com:owner/repo.git' })
    );
  });

  it('passes through Azure DevOps URLs without a .git suffix', async () => {
    await urlResolver(
      { type: 'url', url: 'https://dev.azure.com/org/project/_git/repo' },
      buildOpts(),
      deps
    );
    expect(deps.cloneRepository).toHaveBeenCalledWith(
      expect.objectContaining({
        cloneUrl: 'https://dev.azure.com/org/project/_git/repo',
      })
    );
  });

  it('pin precedence: sha > ref > main', async () => {
    const sha = 'a'.repeat(40);
    await urlResolver(
      { type: 'url', url: 'https://example.com/foo.git', ref: 'develop', sha },
      buildOpts(),
      deps
    );
    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: sha }));

    deps.cloneRepository.mockClear();
    await urlResolver(
      { type: 'url', url: 'https://example.com/foo.git', ref: 'develop' },
      buildOpts(),
      deps
    );
    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: 'develop' }));

    deps.cloneRepository.mockClear();
    await urlResolver({ type: 'url', url: 'https://example.com/foo.git' }, buildOpts(), deps);
    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ ref: 'main' }));
  });

  it('forwards force flag', async () => {
    await urlResolver(
      { type: 'url', url: 'https://example.com/foo.git' },
      buildOpts({ force: true }),
      deps
    );
    expect(deps.cloneRepository).toHaveBeenCalledWith(expect.objectContaining({ force: true }));
  });
});
