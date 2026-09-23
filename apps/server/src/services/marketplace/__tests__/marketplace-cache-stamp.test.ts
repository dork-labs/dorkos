/**
 * The last-use stamp is best-effort: a tree DorkOS can read but not stamp
 * (root-owned, or on a read-only disk) must still be served.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketplaceCache } from '../marketplace-cache.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, utimes: vi.fn(actual.utimes) };
});

const sha = (digit: string): string => digit.repeat(40);

describe('MarketplaceCache stamping', () => {
  let dorkHome: string;
  let cache: MarketplaceCache;

  beforeEach(async () => {
    dorkHome = await mkdtemp(join(tmpdir(), 'marketplace-cache-stamp-'));
    cache = new MarketplaceCache(dorkHome);
    await cache.materializePackage('flow', sha('a'), '', async (dir) => {
      await writeFile(join(dir, 'README.md'), 'tree\n');
      return sha('a');
    });
  });

  afterEach(async () => {
    vi.mocked(fsPromises.utimes).mockReset();
    await rm(dorkHome, { recursive: true, force: true });
  });

  it.each(['EPERM', 'EROFS', 'EACCES'])(
    'still serves an entry it cannot stamp (%s)',
    async (code) => {
      // Purpose: failing an install or an update check on a readable tree
      // because its folder time cannot be changed would be a new way to break.
      const refusal = Object.assign(new Error(`${code}: not permitted`), { code });
      vi.mocked(fsPromises.utimes).mockRejectedValue(refusal);

      const hit = await cache.getPackage('flow', sha('a'), '');
      expect(hit).not.toBeNull();
      expect(hit!.lastUsedAt).toBeInstanceOf(Date);

      const fetch = vi.fn();
      const served = await cache.materializePackage('flow', sha('a'), '', fetch);
      expect(served.commitSha).toBe(sha('a'));
      expect(fetch).not.toHaveBeenCalled();
    }
  );
});
