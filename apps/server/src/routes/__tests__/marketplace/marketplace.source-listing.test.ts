/**
 * @vitest-environment node
 *
 * A source's listing through the real `PackageFetcher`: what `GET /sources`
 * says about each source's last fetch (DOR-2324), and what add and refresh do
 * with a listing that loaded, failed or is cached under an old name (DOR-2304).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useMarketplaceRoutes } from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

const listing = (names: string[], owner = 'Owner') => ({
  name: 'mine',
  owner: { name: owner },
  plugins: names.map((name) => ({ name, source: `./plugins/${name}` })),
});

/** Every network fetch answers with `make()`. */
const serve = (make: () => Response) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => make())
  );

/** Every network fetch is refused, as by a server that is down. */
const refuseConnections = () =>
  serve(() => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
    });
  });

const notFound = () => new Response('nope', { status: 404, statusText: 'Not Found' });

const addMine = (source = 'https://github.com/me/mine', extra: object = {}) =>
  h.post('/sources', { name: 'mine', source, ...extra });

beforeEach(() => {
  h.useRealFetcher();
});

describe('GET /sources reports each source last fetch (DOR-2324)', () => {
  // Whether a source's packages loaded is a fact about the server, so it
  // survives a reload and every window reads the same answer.
  const lastFetchOf = async (name: string) => {
    const res = await h.get('/sources');
    expect(res.status).toBe(200);
    return res.body.sources.find((s: { name: string }) => s.name === name)?.lastFetch;
  };

  it('says a source was never fetched', async () => {
    await h.sourceManager.add({ name: 'quiet', source: 'https://github.com/me/quiet' });
    expect(await lastFetchOf('quiet')).toEqual({ state: 'never' });
  });

  it('reports a listing the add fetched, with its package count', async () => {
    serve(() => new Response(JSON.stringify(listing(['a', 'b']))));
    await addMine();

    expect(await lastFetchOf('mine')).toEqual({
      state: 'fetched',
      checkedAt: expect.any(String),
      packageCount: 2,
    });
  });

  it('reports a listing that never loaded, with the reason', async () => {
    serve(notFound);
    await addMine();

    expect(await lastFetchOf('mine')).toEqual({
      state: 'failed',
      checkedAt: expect.any(String),
      reason: "there's no marketplace listing at that address",
    });
  });

  it('reports an older copy still shown after a failed refresh, and when that copy is from', async () => {
    serve(() => new Response(JSON.stringify(listing(['a', 'b', 'c']))));
    await addMine();
    const copyFetchedAt = (await h.cache.readMarketplace('mine'))!.fetchedAt.toISOString();
    refuseConnections();

    await h.post('/sources/mine/refresh');

    expect(await lastFetchOf('mine')).toEqual({
      state: 'stale',
      checkedAt: expect.any(String),
      reason: 'the server at that address refused the connection',
      copyFetchedAt,
      packageCount: 3,
    });
  });

  it('picks up a failure from browsing, not just from add and refresh', async () => {
    serve(() => new Response(JSON.stringify(listing(['a']))));
    await addMine();
    serve(() => new Response('down', { status: 503, statusText: 'Service Unavailable' }));

    await h.get('/packages');

    expect(await lastFetchOf('mine')).toMatchObject({
      state: 'stale',
      reason: 'the marketplace server answered with an error (503 Service Unavailable)',
    });
  });

  it('treats a listing cached before these records existed as fetched', async () => {
    // An install upgraded to this version has listings on disk and no records.
    await h.sourceManager.add({ name: 'old', source: 'https://github.com/me/old' });
    await h.cache.writeMarketplace('old', listing(['a']));

    expect(await lastFetchOf('old')).toEqual({
      state: 'fetched',
      checkedAt: (await h.cache.readMarketplace('old'))!.fetchedAt.toISOString(),
      packageCount: 1,
    });
  });
});

describe('add and refresh with the real fetcher (DOR-2304)', () => {
  it('reads a file:// source from disk and caches it, so an install can resolve at once', async () => {
    const root = join(h.dorkHome, 'local-mp');
    mkdirSync(join(root, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(root, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'local-mp',
        owner: { name: 'Me' },
        plugins: [{ name: 'sample-plugin', source: './packages/sample-plugin' }],
      })
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await h.post('/sources', { name: 'local-mp', source: `file://${root}` });

    expect(res.status).toBe(201);
    expect(res.body.listing).toEqual({ fetched: true, packageCount: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    const cached = await h.cache.readMarketplace('local-mp');
    expect(cached?.json.plugins.map((p) => p.name)).toEqual(['sample-plugin']);
  });

  it("never reports an old source's cached listing as the new one's", async () => {
    // Listings are cached by NAME: a cache a removed source left behind must
    // not pass for the new source's listing.
    await h.cache.writeMarketplace('mine', listing(['old-a', 'old-b', 'old-c'], 'Old owner'));
    serve(notFound);

    const res = await addMine('https://github.com/new/other');

    expect(res.status).toBe(201);
    expect(res.body.listing).toEqual({
      fetched: false,
      reason: "there's no marketplace listing at that address",
    });
    expect(await h.cache.readMarketplace('mine')).toBeNull();
  });

  it('forgets an old listing under the name even when the new source is added turned off', async () => {
    await h.cache.writeMarketplace('mine', listing(['old-a'], 'Old owner'));

    const res = await addMine('https://github.com/new/other', { enabled: false });

    expect(res.status).toBe(201);
    expect(res.body.listing.fetched).toBe(false);
    expect(await h.cache.readMarketplace('mine')).toBeNull();
  });

  it('refresh says plainly when it could only show the last copy', async () => {
    // A Refresh that quietly answered with the cached copy read as success
    // while the server was down.
    serve(() => new Response(JSON.stringify(listing(['a', 'b']))));
    await addMine();
    const cachedAt = (await h.cache.readMarketplace('mine'))!.fetchedAt.toISOString();
    refuseConnections();

    const res = await h.post('/sources/mine/refresh');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stale: true,
      reason: 'the server at that address refused the connection',
      fetchedAt: cachedAt,
    });
    expect(res.body.marketplace.plugins).toHaveLength(2);
  });

  it('refresh answers 502 with the reason when there is no copy to fall back on', async () => {
    serve(notFound);
    await h.post('/sources', { name: 'gone', source: 'https://github.com/me/gone' });

    const res = await h.post('/sources/gone/refresh');

    expect(res.status).toBe(502);
    expect(res.body.detail).toBe(
      "Couldn't fetch that source's listing, and none is saved. Try again."
    );
  });
});
