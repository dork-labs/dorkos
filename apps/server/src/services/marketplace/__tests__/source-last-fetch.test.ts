/**
 * The per-source record of the last listing fetch (DOR-2324), end to end with
 * the real cache and fetcher: what is written, what wins when two fetches race,
 * and what GET /sources is told.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { MarketplaceCache } from '../marketplace-cache.js';
import { PackageFetcher } from '../package-fetcher.js';
import type { GitTreeSource } from '../lib/git/git-tree.js';
import { describeLastFetch } from '../source-listing.js';
import type { MarketplaceSource } from '../types.js';

const listing = (count: number): MarketplaceJson =>
  ({
    name: 'm',
    owner: { name: 'Owner' },
    plugins: Array.from({ length: count }, (_, i) => ({ name: `p${i}`, source: `./p${i}` })),
  }) as MarketplaceJson;

const SOURCE: MarketplaceSource = {
  name: 'm',
  source: 'https://github.com/o/m',
  enabled: true,
  addedAt: '2026-09-24T00:00:00.000Z',
};

let home: string;
let cache: MarketplaceCache;
let fetcher: PackageFetcher;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'last-fetch-'));
  cache = new MarketplaceCache(home);
  fetcher = new PackageFetcher(cache, {} as GitTreeSource, noopLogger);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('the last-fetch record', () => {
  it('keeps the newer success when an older, slower failure lands after it', async () => {
    // Purpose: records land in finishing order, not starting order. A slow
    // attempt that started first and failed must not overwrite the answer of
    // one that started later and worked.
    let call = 0;
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (call++ === 0) {
          await slowGate;
          return new Response('busy', { status: 503, statusText: 'Busy' });
        }
        return new Response(JSON.stringify(listing(2)));
      })
    );

    const slow = fetcher.fetchMarketplaceJson(SOURCE).catch(() => 'failed');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fetcher.fetchMarketplaceJson(SOURCE);
    releaseSlow();
    await slow;

    expect(await describeLastFetch(cache, 'm')).toEqual({
      state: 'fetched',
      checkedAt: expect.any(String),
      packageCount: 2,
    });
  });

  it('reads a failure as fetched when a copy newer than that attempt is on disk', async () => {
    // Purpose: the other half of the race. A success that started earlier but
    // wrote its copy after the failed attempt began is the listing now shown.
    await cache.writeFetchStatus('m', {
      startedAt: '2000-01-01T00:00:00.000Z',
      checkedAt: '2000-01-01T00:00:01.000Z',
      ok: false,
      reason: 'down',
    });
    await cache.writeMarketplace('m', listing(4));

    expect(await describeLastFetch(cache, 'm')).toMatchObject({
      state: 'fetched',
      packageCount: 4,
    });
  });

  it('stores the package count, so reporting does not re-read the listing', async () => {
    // Purpose: GET /sources runs per source on every page load; parsing each
    // cached listing to count it was the expensive part.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing(3))))
    );
    await fetcher.fetchMarketplaceJson(SOURCE);
    const read = vi.spyOn(cache, 'readMarketplace');

    expect(await describeLastFetch(cache, 'm')).toMatchObject({
      state: 'fetched',
      packageCount: 3,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('carries the count of the copy still listed into a failure record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing(3))))
    );
    await fetcher.fetchMarketplaceJson(SOURCE);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x', { status: 500, statusText: 'Oops' }))
    );
    await fetcher.fetchMarketplaceJson(SOURCE);
    const read = vi.spyOn(cache, 'readMarketplace');

    expect(await describeLastFetch(cache, 'm')).toMatchObject({
      state: 'stale',
      packageCount: 3,
      reason: 'the marketplace server answered with an error (500 Oops)',
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('writes the record atomically, leaving no temporary files behind', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(listing(1))))
    );
    await Promise.all([1, 2, 3].map(() => fetcher.fetchMarketplaceJson(SOURCE)));

    const files = await readdir(join(cache.cacheRoot, 'marketplaces', 'm'));
    expect(files.sort()).toEqual(['.last-check.json', '.last-fetched', 'marketplace.json']);
    expect(await cache.readFetchStatus('m')).toMatchObject({ ok: true, packageCount: 1 });
  });
});
