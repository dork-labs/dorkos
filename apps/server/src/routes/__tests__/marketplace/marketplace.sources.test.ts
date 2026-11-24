/**
 * @vitest-environment node
 *
 * The package source routes: add, remove, refresh, the `?name=` forms, and the
 * operator-only bar on adding and removing (DOR-502).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SAMPLE_MARKETPLACE_JSON,
  listSourceNames,
  useMarketplaceRoutes,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

describe('POST /sources', () => {
  it('adds a new source and returns 201 with the created entry', async () => {
    const res = await h.post('/sources', {
      name: 'my-custom',
      source: 'https://github.com/me/marketplace',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'my-custom',
      source: 'https://github.com/me/marketplace',
      enabled: true,
      addedAt: expect.any(String),
    });
  });

  it('returns 409 for a duplicate name, and fetches nothing for it', async () => {
    // Purpose: a refused add must not refetch (and so overwrite the cache of)
    // the source that already holds that name.
    await h.post('/sources', { name: 'dup', source: 'https://example.com/one' });
    h.fetcher.fetchMarketplaceJson.mockClear();

    const res = await h.post('/sources', { name: 'dup', source: 'https://example.com/two' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect(h.fetcher.fetchMarketplaceJson).not.toHaveBeenCalled();
  });

  it('returns 400 for invalid body', async () => {
    const res = await h.post('/sources', { name: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it('returns 400 and says what to use instead for an address git would run, fetching nothing (DOR-1710)', async () => {
    const res = await h.post('/sources', {
      name: 'hostile',
      source: "ext::sh -c 'id > /tmp/pwned'",
    });

    expect(res.status).toBe(400);
    // The person reading it learns which addresses do work.
    expect(res.body.error).toMatch(/isn't one DorkOS can fetch a marketplace from/);
    expect(res.body.error).toMatch(/https:\/\//);
    expect(h.fetcher.fetchMarketplaceJson).not.toHaveBeenCalled();
    expect(await listSourceNames(h)).not.toContain('hostile');
  });

  it('refuses a name that could not be a cache key, in plain words, and saves nothing', async () => {
    // Purpose: the name keys the listing cache, and `x/..` named the cache
    // root, so removing that source would have deleted every listing.
    const res = await h.post('/sources', { name: 'x/..', source: 'https://example.com/m' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/letters, numbers, dots, dashes and underscores/);
    expect(h.fetcher.fetchMarketplaceJson).not.toHaveBeenCalled();
    expect(await listSourceNames(h)).not.toContain('x/..');
  });
});

describe('POST /sources fetches the new source listing (DOR-2304)', () => {
  it('fetches the listing once, through the refresh path, and says how many packages it names', async () => {
    // Purpose: without this fetch the first install from a new source fails
    // with "no cached document" until someone runs a refresh by hand.
    h.fetcher.fetchMarketplaceJson.mockResolvedValueOnce({
      ...SAMPLE_MARKETPLACE_JSON,
      plugins: [
        ...SAMPLE_MARKETPLACE_JSON.plugins,
        { name: 'second-plugin', source: 'https://github.com/dorkos/second-plugin' },
      ],
    });

    const res = await h.post('/sources', { name: 'fresh', source: 'https://example.com/fresh' });

    expect(res.status).toBe(201);
    expect(res.body.listing).toEqual({ fetched: true, packageCount: 2 });
    expect(h.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    expect(h.fetcher.fetchMarketplaceJson.mock.calls[0][0]).toMatchObject({
      name: 'fresh',
      source: 'https://example.com/fresh',
      enabled: true,
    });
    // "fetched" must mean fetched now, never an old copy served from disk.
    expect(h.fetcher.fetchMarketplaceJson.mock.calls[0][1]).toEqual({ staleFallback: false });
  });

  it('does not fetch a source added turned off, and says so', async () => {
    const res = await h.post('/sources', {
      name: 'parked',
      source: 'https://example.com/parked',
      enabled: false,
    });

    expect(res.status).toBe(201);
    expect(res.body.enabled).toBe(false);
    expect(res.body.listing).toEqual({
      fetched: false,
      reason: "it was added turned off, so DorkOS didn't fetch its listing",
    });
    expect(h.fetcher.fetchMarketplaceJson).not.toHaveBeenCalled();
  });

  it('keeps the source when the fetch fails, and says why the listing is not there yet', async () => {
    // Purpose: a server that is down right now must not cost the operator the add.
    h.fetcher.fetchMarketplaceJson.mockRejectedValueOnce(
      new Error("there's no marketplace listing at that address")
    );

    const res = await h.post('/sources', {
      name: 'offline',
      source: 'https://example.com/offline',
    });

    expect(res.status).toBe(201);
    expect(res.body.listing).toEqual({
      fetched: false,
      reason: "there's no marketplace listing at that address",
    });
    expect(await listSourceNames(h)).toContain('offline');
  });
});

describe('DELETE /sources/:name', () => {
  it('removes the source and forgets its listing, so a new source by that name starts clean (DOR-2304)', async () => {
    // Purpose: listings are cached by name; one that outlives its source
    // would be listed and installed from as if the next source published it.
    await h.post('/sources', { name: 'removable', source: 'https://example.com/r' });
    const listing = {
      name: 'cached',
      owner: { name: 'Owner' },
      plugins: [{ name: 'a', source: './plugins/a' }],
    };
    await h.cache.writeMarketplace('removable', listing);
    await h.cache.writeMarketplace('bystander', listing);
    h.updateFlow.clearMemos.mockClear();

    const res = await h.del('/sources/removable');

    expect(res.status).toBe(204);
    expect(await listSourceNames(h)).not.toContain('removable');
    expect(await h.cache.readMarketplace('removable')).toBeNull();
    expect(await h.cache.readMarketplace('bystander')).not.toBeNull();
    // The update check remembers each source's listing for a minute too.
    expect(h.updateFlow.clearMemos).toHaveBeenCalledTimes(1);
  });
});

describe('POST /sources/:name/refresh', () => {
  it('fetches the source fresh, returns its listing, and clears the update check memos', async () => {
    await h.post('/sources', { name: 'refreshable', source: 'https://example.com/refresh' });
    // The add fetched the listing once already (DOR-2304); count the refresh alone.
    h.fetcher.fetchMarketplaceJson.mockClear();
    h.updateFlow.clearMemos.mockClear();

    const res = await h.post('/sources/refreshable/refresh');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      marketplace: SAMPLE_MARKETPLACE_JSON,
      fetchedAt: expect.any(String),
      stale: false,
    });
    expect(h.fetcher.fetchMarketplaceJson).toHaveBeenCalledTimes(1);
    // A refresh is "check now": it never quietly answers with the old copy.
    expect(h.fetcher.fetchMarketplaceJson.mock.calls[0][1]).toEqual({ staleFallback: false });
    expect(h.fetcher.fetchMarketplaceJson.mock.calls[0][0]).toMatchObject({
      name: 'refreshable',
      source: 'https://example.com/refresh',
    });
    // "I just pushed; check again" is answered fresh.
    expect(h.updateFlow.clearMemos).toHaveBeenCalledTimes(1);
  });

  it('returns 404 when the source does not exist', async () => {
    const res = await h.post('/sources/missing/refresh');
    expect(res.status).toBe(404);
  });
});

// The app sends the name in the query string (DOR-4212): a name saved by an
// older DorkOS may hold a `/`, and Remote Access refuses an encoded `/` in a
// URL path. The path form stays for the CLI and every name made today.
describe('the ?name= forms', () => {
  const LEGACY = 'acme/plugins';

  /** A source saved before names were checked, written the way it sits on disk. */
  async function seedLegacySource(): Promise<void> {
    await h.sourceManager.list();
    const file = join(h.dorkHome, 'marketplaces.json');
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.sources.push({ ...json.sources[0], name: LEGACY, source: 'https://example.com/legacy' });
    writeFileSync(file, JSON.stringify(json));
  }

  it('DELETE /sources?name= removes a legacy name holding a / and its listing', async () => {
    await seedLegacySource();
    await h.cache.writeMarketplace(LEGACY, {
      name: 'cached',
      owner: { name: 'Owner' },
      plugins: [{ name: 'a', source: './plugins/a' }],
    });

    const res = await h.del(`/sources?name=${encodeURIComponent(LEGACY)}`);

    expect(res.status).toBe(204);
    expect(await h.sourceManager.get(LEGACY)).toBeNull();
    expect(await h.cache.readMarketplace(LEGACY)).toBeNull();
  });

  it('POST /sources/refresh?name= refreshes a legacy name holding a /', async () => {
    await seedLegacySource();

    const res = await h.post(`/sources/refresh?name=${encodeURIComponent(LEGACY)}`);

    expect(res.status).toBe(200);
    expect(h.fetcher.fetchMarketplaceJson.mock.calls[0][0].name).toBe(LEGACY);
  });

  it('a name that was never a source removes nothing, not even a cache folder', async () => {
    // Purpose: `.` names the folder that holds every listing.
    await h.cache.writeMarketplace('bystander', {
      name: 'kept',
      owner: { name: 'Owner' },
      plugins: [],
    });

    const res = await h.del('/sources?name=.');

    expect(res.status).toBe(204);
    expect(await h.cache.readMarketplace('bystander')).not.toBeNull();
  });

  it.each([
    ['DELETE', '/sources'],
    ['DELETE', '/sources?name='],
    ['POST', '/sources/refresh'],
    ['POST', '/sources/refresh?name=a&name=b'],
  ])('%s %s with no single name is a 400', async (method, target) => {
    const res = method === 'DELETE' ? await h.del(target) : await h.post(target);
    expect(res.status).toBe(400);
  });

  it('DELETE /sources?name= refuses an agent, as the path form does', async () => {
    await h.post('/sources', { name: 'removable', source: 'https://example.com/r' });
    h.agentHeader = 'agent-token';

    const res = await h.del('/sources?name=removable');

    expect(res.status).toBe(403);
    expect(await h.sourceManager.get('removable')).not.toBeNull();
  });
});

describe('the operator-only bar on the source routes (DOR-502)', () => {
  it('refuses an AGENT that tries to add a source, and adds nothing', async () => {
    // A source decides which feed `install` may fetch code from, and the
    // install gate never asks where a package came from.
    h.agentHeader = 'agent-token';

    const res = await h.post('/sources', {
      name: 'attacker',
      source: 'https://attacker.example/marketplace',
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_marketplace_source');
    expect(res.body.error).toBe('Only the person running DorkOS can add a package source');
    // Legible to a model: it must learn to ask the person, not to retry.
    expect(res.body.message).toContain('Marketplace sources page');
    expect(res.body.message).toContain('Retrying will not help');
    expect(await listSourceNames(h)).not.toContain('attacker');
  });

  it('refuses an AGENT that tries to remove a source, and the source survives', async () => {
    await h.post('/sources', { name: 'keeper', source: 'https://example.com/keeper' });

    h.agentHeader = 'agent-token';
    const res = await h.del('/sources/keeper');

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_marketplace_source');
    expect(res.body.error).toBe('Only the person running DorkOS can remove a package source');
    expect(res.body.message).toContain('Marketplace sources page');
    expect(await listSourceNames(h)).toContain('keeper');
  });

  it('refuses an agent BEFORE validating the body, so the schema cannot be probed', async () => {
    h.agentHeader = 'agent-token';

    const res = await h.post('/sources', { name: '' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_marketplace_source');
    expect(res.body.details).toBeUndefined();
  });

  it('lets the person in the app add and then remove a source', async () => {
    // The other half: inverting the guard would otherwise still look green.
    expect(
      (await h.post('/sources', { name: 'mine', source: 'https://example.com/mine' })).status
    ).toBe(201);
    expect(await listSourceNames(h)).toContain('mine');

    expect((await h.del('/sources/mine')).status).toBe(204);
    expect(await listSourceNames(h)).not.toContain('mine');
  });

  it('leaves reading, refreshing, and listing open to an agent', async () => {
    await h.post('/sources', { name: 'readable', source: 'https://example.com/readable' });

    h.agentHeader = 'agent-token';
    expect((await h.get('/sources')).status).toBe(200);
    expect((await h.post('/sources/readable/refresh')).status).toBe(200);
  });
});
