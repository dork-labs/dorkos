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
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { COMMUNITY_API_V1_ROUTES } from '@dorkos/shared/community-wire';
import {
  CENSUS_GROUPS,
  FULL_ENV,
  betterAuthAllowlist,
  censusProblems,
  readBetterAuthRoutes,
  readRouteCensus,
  type RouteCensus,
} from './route-census.js';

const BASELINE = new URL('./route-census.baseline.json', import.meta.url);
const SRC = new URL('../../', import.meta.url);

/**
 * Every registrar that adds its routes only under a setting, and the setting. The census turns
 * each on, so its routes are in the baseline; a new one fails the guard below until it is added
 * here and to `FULL_ENV`.
 */
const SETTING_GATED_REGISTRARS: Record<string, string> = {
  registerMinimumAgeRoutes: 'COMMUNITY_MINIMUM_AGE',
  registerAllowedCountryRoutes: 'COMMUNITY_ALLOWED_COUNTRIES',
  // Read with COMMUNITY_TEST_RUNTIME on, as the census's test-only group.
  registerCommunityTestControlRoutes: 'COMMUNITY_TEST_RUNTIME',
};

/** Non-test server source, relative to `src/`. */
function serverSources(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (name) =>
      /\.ts$/u.test(name) &&
      !/(^|\/)__tests__\//u.test(name) &&
      !name.endsWith('.test.ts') &&
      !name.startsWith('browser/')
  );
}

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

describe('what the census composes', () => {
  it('turns on every setting a registrar waits for', () => {
    // Purpose: fails when a registrar starts adding its routes only under a setting the census
    // does not turn on, so those routes would be missing from the baseline unseen.
    const gated = new Set<string>();
    for (const file of serverSources()) {
      const text = readFileSync(new URL(file, SRC), 'utf8');
      // A registrar that returns early, before registering anything.
      for (const [body, name] of text.matchAll(/^export function (register\w+)\([\s\S]*?^\}$/gmu))
        if (/^ {2}(?:if \([^\n]*\) )?return\b/mu.test(body)) gated.add(name);
      // A registrar called only under a condition.
      for (const [, name] of text.matchAll(/\bif \([^\n]*\) *(register\w+)\(/gu)) gated.add(name);
    }
    expect([...gated].sort()).toEqual(Object.keys(SETTING_GATED_REGISTRARS).sort());
    for (const setting of Object.values(SETTING_GATED_REGISTRARS))
      if (setting !== 'COMMUNITY_TEST_RUNTIME') expect(FULL_ENV).toHaveProperty(setting);
  });

  it.each(['main.ts', 'startup/space-server.ts'])('%s adds no routes of its own', (file) => {
    // Purpose: the census composes the app as createSpaceServer does without running it, so a
    // route added there or in the entry would be unseen. Fails if either routes anything outside
    // `registerPages`.
    const source = readFileSync(new URL(file, SRC), 'utf8');
    expect(
      source.match(
        /\bapp\.(?:get|post|put|patch|delete|options|head|all|use|on|route|basePath|mount)\(/gu
      )
    ).toBeNull();
    expect(source.match(/\bregister\w+\(app\b/gu)).toEqual(
      file === 'main.ts' ? null : ['registerPages(app']
    );
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
