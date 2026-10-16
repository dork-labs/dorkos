/**
 * The headers census (DOR-2957, specs/everything-is-a-space C8): every route the space server
 * serves answers with exactly the security headers `headers.baseline.json` files it under, and
 * every route is filed. A browser obeys these headers, so a page that loses its content security
 * policy, or a file that could render as a page, is a change a reviewer sees. A deliberate change
 * updates the baseline in the same PR and says so in the PR description:
 *
 *   pnpm --filter @dorkos/community census:update
 */
import { readFile, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SECURITY_HEADER_GROUPS } from '../../headers/security-headers.js';
import {
  groupOfHeaders,
  headersProblems,
  readHeadersCensus,
  type HeadersBaseline,
} from './headers-census.js';

const BASELINE = new URL('./headers.baseline.json', import.meta.url);
const UPDATE = process.env.UPDATE_PROMISES === '1';

const NOTE =
  'The security headers each space server route answers with (DOR-2957), read by headers-census.test.ts. A deliberate change updates this file in the same PR and says so in the PR description: pnpm --filter @dorkos/community census:update';

const readBaseline = async () =>
  JSON.parse(await readFile(BASELINE, 'utf8')) as HeadersBaseline & { '//': string };

beforeEach(() => {
  // The census turns single sign-on on; its discovery must never leave this machine.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in the headers census')));
});
afterEach(() => vi.unstubAllGlobals());

describe('headers census', () => {
  it('answers every route with exactly its group of security headers', async () => {
    // Purpose: fails when a route answers without its pinned headers, with another group's, or
    // with none, and when a route is served that the baseline files under no group.
    const answers = await readHeadersCensus();
    // The census must have reached the app at all: an empty walk passes nothing.
    expect(answers.size).toBeGreaterThan(250);
    if (UPDATE) {
      const routes: Record<string, string> = {};
      for (const [route, answer] of answers)
        routes[route] = groupOfHeaders(answer.headers, SECURITY_HEADER_GROUPS) ?? 'none';
      await writeFile(
        BASELINE,
        `${JSON.stringify({ '//': NOTE, groups: SECURITY_HEADER_GROUPS, routes }, null, 2)}\n`
      );
      return;
    }
    expect(headersProblems(answers, await readBaseline())).toEqual([]);
  });

  it('pins the groups the server sends', async () => {
    // Purpose: fails when a header in a group changes, so a weaker policy is a reviewed edit.
    expect((await readBaseline()).groups).toEqual(SECURITY_HEADER_GROUPS);
  });

  it('files every page under the page policy and nothing else', async () => {
    // Purpose: fails if the strict page policy reaches a route that is not the page, or a page
    // answers without it.
    const { routes } = await readBaseline();
    const pages = Object.entries(routes)
      .filter(([, group]) => group === 'page')
      .map(([route]) => route);
    expect(pages.every((route) => !route.split(' ')[1].startsWith('/api/'))).toBe(true);
    for (const page of ['GET /', 'GET /c/:communityId/*', 'GET /:name', 'GET /pairing'])
      expect(routes[page], page).toBe('page');
    expect(routes['GET /api/v1/attachments/:id']).toBe('locked');
    expect(routes['ALL /assets/*']).toBe('locked');
  });

  it('notices a route with no group, and a route that drops a header', async () => {
    // Purpose: fails if the census cannot see an unfiled route or a missing header, which would
    // let the first test pass whatever the routes answer.
    const baseline = await readBaseline();
    const answers = await readHeadersCensus((app) => {
      app.get('/api/v1/headers-probe', (c) => c.json({}));
    });
    const page = answers.get('GET /pairing')!;
    const { 'content-security-policy': _dropped, ...withoutPolicy } = page.headers;
    answers.set('GET /pairing', { ...page, headers: withoutPolicy });
    const problems = headersProblems(answers, baseline);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^GET \/pairing should carry page, carries \{/u);
    expect(problems[1]).toBe('no header group: GET /api/v1/headers-probe (answers as locked)');
  });
});
