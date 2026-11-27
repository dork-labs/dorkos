/**
 * @vitest-environment node
 *
 * The marketplace lists a page at a time (DOR-4982): every page read in turn
 * gives the list in the order it answered whole before it paged, and a cursor
 * the list did not give, or gave another reader, is refused, never read as
 * page one.
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { useMarketplaceRoutes, writePackageManifest } from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

/** Every row of `path`, read `limit` at a time, and how many pages it took. */
async function readEveryPage(path: string, noun: string, limit: number) {
  const rows: Array<{ name: string }> = [];
  let pages = 0;
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const after = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
    const res = await h.get(`${path}${sep}limit=${limit}${after}`);
    expect(res.status).toBe(200);
    rows.push(...res.body[noun]);
    cursor = res.body.nextCursor;
    pages++;
  } while (cursor !== null);
  return { names: rows.map((row) => row.name), pages };
}

const listing = (name: string, packages: string[]): MarketplaceJson => ({
  name,
  owner: { name: 'Owner' },
  plugins: packages.map((pkg) => ({
    name: pkg,
    source: `https://example.com/${pkg}`,
    version: '1.0.0',
  })),
});

describe('the marketplace lists, a page at a time', () => {
  // Purpose: the app shows sources in the order the sources file keeps them,
  // not sorted; paging must not reorder them.
  it('keeps the sources in the order they were added, across pages', async () => {
    for (const name of ['zeta', 'alpha', 'mid']) {
      await h.post('/sources', { name, source: `https://example.com/${name}` });
    }
    const whole = await h.get('/sources');

    const paged = await readEveryPage('/sources', 'sources', 1);

    expect(paged.names).toEqual(whole.body.sources.map((s: { name: string }) => s.name));
    expect(paged.names.slice(-3)).toEqual(['zeta', 'alpha', 'mid']);
    expect(paged.pages).toBe(whole.body.sources.length);
  });

  // Purpose: browse is source by source, each listing in its own order; a
  // reader of every page gets that order, not a sort.
  it('keeps the packages source by source, in each listing’s order', async () => {
    await h.post('/sources', { name: 'mp-b', source: 'https://example.com/b' });
    await h.post('/sources', { name: 'mp-a', source: 'https://example.com/a' });
    const names: Record<string, string[]> = { 'mp-b': ['b-zed', 'b-ant'], 'mp-a': ['a-one'] };
    h.fetcher.fetchMarketplaceJson.mockImplementation(async (source: { name: string }) =>
      listing(source.name, names[source.name] ?? [])
    );
    const whole = await h.get('/packages');

    const paged = await readEveryPage('/packages', 'packages', 1);

    expect(paged.names).toEqual(whole.body.packages.map((p: { name: string }) => p.name));
    expect(paged.names.filter((n) => /^[ab]-/.test(n))).toEqual(['b-zed', 'b-ant', 'a-one']);
  });

  it('keeps the installs in scan order, across pages', async () => {
    for (const name of ['p-one', 'p-two', 'p-three']) {
      writePackageManifest(join(h.dorkHome, 'plugins', name), {
        manifest: 1,
        type: 'plugin',
        name,
        version: '1.0.0',
      });
    }
    const whole = await h.get('/installed');

    const paged = await readEveryPage('/installed', 'packages', 2);

    expect(whole.body.nextCursor).toBeNull();
    expect(paged.names).toEqual(whole.body.packages.map((p: { name: string }) => p.name));
    expect(paged.pages).toBe(2);
  });

  // Purpose: a made-up or another list's cursor is refused, never page one.
  it('refuses a cursor the list did not give', async () => {
    await h.post('/sources', { name: 'one', source: 'https://example.com/one' });
    await h.post('/sources', { name: 'two', source: 'https://example.com/two' });
    const first = await h.get('/sources?limit=1');
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const made = await h.get('/sources?cursor=not-a-cursor');
    const other = await h.get(`/packages?cursor=${encodeURIComponent(first.body.nextCursor)}`);

    expect(made.status).toBe(400);
    expect(other.status).toBe(400);
  });

  // Purpose: the installs read differently for an agent (no folders), so the
  // cursor is sealed to its reader: the person's cursor does not open for an agent.
  it('refuses an agent the cursor the person was given', async () => {
    for (const name of ['p-one', 'p-two']) {
      writePackageManifest(join(h.dorkHome, 'plugins', name), {
        manifest: 1,
        type: 'plugin',
        name,
        version: '1.0.0',
      });
    }
    const person = await h.get('/installed?limit=1');
    const cursor = encodeURIComponent(person.body.nextCursor);

    h.agentHeader = 'agent-token';
    const own = await h.get('/installed?limit=1');
    const agent = await h.get(`/installed?limit=1&cursor=${cursor}`);

    expect(own.status).toBe(200);
    expect(agent.status).toBe(400);
  });
});
