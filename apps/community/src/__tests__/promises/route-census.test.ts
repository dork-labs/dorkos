/**
 * The route census (specs/server-merge step 1, DOR-2875): the space server's routes must equal
 * `route-census.baseline.json`, and the Better Auth routes it answers must equal the reviewed
 * `../better-auth-routes.allowlist.json` (specs/spaces-email T17, DOR-2710). Installed apps,
 * operators and the host API's callers depend on these, so adding, removing or moving a route is
 * an edit a reviewer sees. A deliberate change updates the baseline in the same PR and says so in
 * the PR description:
 *
 *   pnpm --filter @dorkos/community census:update
 */
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { COMMUNITY_API_V1_ROUTES } from '@dorkos/shared/community-wire';
import {
  CENSUS_GROUPS,
  betterAuthAllowlist,
  censusProblems,
  readBetterAuthRoutes,
  readRouteCensus,
  type RouteCensus,
} from './route-census.js';

const BASELINE = new URL('./route-census.baseline.json', import.meta.url);

const UPDATE = process.env.UPDATE_PROMISES === '1';

const NOTE =
  'The space server route census (DOR-2875), read from the composed app by route-census.test.ts. A deliberate change updates this file in the same PR and says so in the PR description: pnpm --filter @dorkos/community census:update';

describe('route census', () => {
  it('serves exactly the baseline routes', async () => {
    // Purpose: fails when any route is added, removed, or changes method, path or group.
    const actual = await readRouteCensus();
    // The census must have found the app at all: an empty walk passes nothing.
    expect(actual.community.length).toBeGreaterThan(50);
    if (UPDATE) {
      await writeFile(BASELINE, `${JSON.stringify({ '//': NOTE, ...actual }, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as RouteCensus;
    expect(censusProblems(actual, baseline)).toEqual([]);
  });

  it('notices a route added, removed or changed', async () => {
    // Purpose: fails if the census cannot see a change, which would let the test above pass
    // whatever the app registers.
    const baseline = await readRouteCensus();
    const changed = await readRouteCensus((app) => {
      app.get('/api/v1/census-probe', (c) => c.text(''));
      app.post('/health', (c) => c.text(''));
    });
    expect(censusProblems(changed, baseline)).toEqual([
      'added (api): GET /api/v1/census-probe',
      'added (health): POST /health',
    ]);
    expect(censusProblems(baseline, changed)).toEqual([
      'removed (api): GET /api/v1/census-probe',
      'removed (health): POST /health',
    ]);
  });

  it('serves every path of the shared route table', async () => {
    // Purpose: fails if a path the shared wire (and so the DorkOS app) names stops being served.
    // A parameter's name is not part of the path a caller sends.
    const shape = (path: string) => path.replaceAll(/:[A-Za-z]+/gu, ':param');
    const census = await readRouteCensus();
    const paths = new Set(
      CENSUS_GROUPS.flatMap((group) => census[group]).map((route) => shape(route.split(' ')[1]))
    );
    for (const path of Object.values(COMMUNITY_API_V1_ROUTES))
      expect(paths, path).toContain(shape(path));
  });
});

describe('Better Auth routes', () => {
  it('answers only reviewed routes over HTTP (T17)', async () => {
    // Purpose: fails when a route outside the reviewed allowlist becomes reachable, such as one a
    // Better Auth upgrade adds, or a switched-off path coming back on, or a reviewed one goes.
    expect(await readBetterAuthRoutes()).toEqual(Object.keys(betterAuthAllowlist()).sort());
  });

  it('notices a route nobody reviewed', async () => {
    // Purpose: fails if the census cannot see a new route, which would make the test above pass
    // whatever Better Auth registers.
    const routes = await readBetterAuthRoutes({
      sneaky: { path: '/magic-link/verify', options: { method: 'GET' } },
    });
    const allowlist = betterAuthAllowlist();
    expect(routes.filter((route) => !(route in allowlist))).toEqual(['GET /magic-link/verify']);
  });
});
