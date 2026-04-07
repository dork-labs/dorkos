/**
 * Tests for the relative-path source resolver.
 *
 * Mocks `node:fs/promises.access` to simulate present and missing
 * directories — no real disk I/O.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { relativePathResolver, RELATIVE_PATH_SENTINEL_SHA } from '../relative-path.js';
import { PackageNotFoundError } from '../../errors.js';
import type { FetchPackageOptions } from '../../package-fetcher.js';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
}));

import { access } from 'node:fs/promises';

const mockedAccess = vi.mocked(access);

function buildOpts(overrides: Partial<FetchPackageOptions> = {}): FetchPackageOptions {
  return {
    packageName: 'qa-plugin',
    source: { source: 'github', repo: 'dorkos/qa-plugin' },
    ...overrides,
  };
}

describe('relativePathResolver', () => {
  beforeEach(() => {
    mockedAccess.mockReset();
  });

  it('returns the joined path when the directory exists', async () => {
    mockedAccess.mockResolvedValue(undefined);
    const result = await relativePathResolver(
      {
        type: 'relative-path',
        path: 'plugins/qa',
        marketplaceRoot: '/cache/marketplaces/dorkos-community',
      },
      buildOpts()
    );

    expect(result.path).toBe('/cache/marketplaces/dorkos-community/plugins/qa');
    expect(result.commitSha).toBe(RELATIVE_PATH_SENTINEL_SHA);
    expect(result.fromCache).toBe(true);
    expect(mockedAccess).toHaveBeenCalledWith('/cache/marketplaces/dorkos-community/plugins/qa');
  });

  it('throws PackageNotFoundError when the directory does not exist', async () => {
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(
      relativePathResolver(
        {
          type: 'relative-path',
          path: 'plugins/missing',
          marketplaceRoot: '/cache/marketplaces/dorkos-community',
        },
        buildOpts()
      )
    ).rejects.toBeInstanceOf(PackageNotFoundError);
  });

  it('error message includes both the relative path and the marketplace root', async () => {
    mockedAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(
      relativePathResolver(
        {
          type: 'relative-path',
          path: 'plugins/missing',
          marketplaceRoot: '/cache/marketplaces/dorkos-community',
        },
        buildOpts()
      )
    ).rejects.toThrow(/plugins\/missing/);
  });

  it('returns commitSha: "relative-path" sentinel and fromCache: true', async () => {
    mockedAccess.mockResolvedValue(undefined);
    const result = await relativePathResolver(
      {
        type: 'relative-path',
        path: 'plugins/qa',
        marketplaceRoot: '/root',
      },
      buildOpts()
    );

    expect(result.commitSha).toBe('relative-path');
    expect(result.fromCache).toBe(true);
  });
});
