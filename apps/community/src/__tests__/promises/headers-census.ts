/**
 * The space server's headers census (DOR-2957, specs/everything-is-a-space C8: "response headers
 * pinned per route"). It composes the app as the route census does, sends one request to every
 * route the route census lists, every reviewed Better Auth route and the built assets, and files
 * each answer under the security header group its headers match exactly.
 *
 * The database is never reached: a route that needs it answers a refusal or `503`, which must
 * carry the same headers as its answer would. A successful file, export or icon download is a
 * database case, pinned by its own integration test against the same groups.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { SECURITY_HEADER_GROUPS } from '../../headers/security-headers.js';
import { betterAuthAllowlist, composeCensusApp } from './route-census.js';

/** A security header group's name, as `headers.baseline.json` files a route. */
export type HeaderGroup = keyof typeof SECURITY_HEADER_GROUPS;

/** What `headers.baseline.json` holds: each group's exact headers, and each route's group. */
export interface HeadersBaseline {
  groups: Record<HeaderGroup, Record<string, string>>;
  routes: Record<string, HeaderGroup>;
}

const SPACE = '7d1f4a2e-5b3c-4d6e-8f90-a1b2c3d4e5f6';

/** A concrete path for a route pattern: ids become a UUID, a short name a valid one. */
function concretePath(pattern: string): string {
  return pattern
    .replace(/^\/:name(?=\/|$)/u, '/acme-space')
    .replaceAll(/:[A-Za-z]+/gu, SPACE)
    .replaceAll('*', 'probe');
}

/** Every header one response carries, by lower-case name. */
function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => (headers[name] = value));
  return headers;
}

/**
 * The group whose headers a response carries exactly, or `null` when it matches none. Every
 * header any of `groups` names is compared, so a header missing from the response, or one only
 * another group sets, rules a group out.
 */
export function groupOfHeaders(
  headers: Record<string, string>,
  groups: Record<string, Record<string, string>>
): string | null {
  const names = new Set(Object.values(groups).flatMap((group) => Object.keys(group)));
  for (const [name, group] of Object.entries(groups))
    if ([...names].every((header) => (headers[header] ?? null) === (group[header] ?? null)))
      return name;
  return null;
}

/**
 * The pinned security header group a real response carries, by `headers.baseline.json`: how an
 * integration test pins a download the census cannot reach without a database.
 */
export function headerGroupOf(response: Response): string | null {
  const { groups } = JSON.parse(
    readFileSync(new URL('./headers.baseline.json', import.meta.url), 'utf8')
  ) as HeadersBaseline;
  return groupOfHeaders(headersOf(response), groups);
}

/** One route's answer: its status and every header it carried. */
export interface RouteAnswer {
  status: number;
  headers: Record<string, string>;
}

/**
 * Send one request to every route and read the tracked headers of each answer.
 *
 * @param extend - Changes the app before it is read, so a test can prove the census sees a change.
 */
export async function readHeadersCensus(
  extend?: (app: Hono) => void
): Promise<Map<string, RouteAnswer>> {
  const distDir = await mkdtemp(join(tmpdir(), 'community-headers-census-'));
  await mkdir(join(distDir, 'assets'));
  await writeFile(join(distDir, 'index.html'), '<!doctype html><title>space page</title>');
  await writeFile(join(distDir, 'assets', 'app.js'), 'console.log("space page");');
  const { app, pool } = composeCensusApp(false, distDir);
  try {
    extend?.(app);
    const routes = new Set<string>();
    for (const { method, path } of app.routes)
      if (method !== 'ALL' || path === '/assets/*') routes.add(`${method} ${path}`);
    for (const route of Object.keys(betterAuthAllowlist())) {
      const [method, path] = route.split(' ');
      routes.add(`${method} /api/auth${path}`);
    }
    const answers = new Map<string, RouteAnswer>();
    for (const route of [...routes].sort()) {
      const [method, pattern] = route.split(' ');
      const request = concretePath(pattern === '/assets/*' ? '/assets/app.js' : pattern);
      const response = await app.request(request, {
        method: method === 'ALL' ? 'GET' : method,
        ...(['GET', 'HEAD', 'ALL'].includes(method)
          ? {}
          : { body: '{}', headers: { 'content-type': 'application/json' } }),
      });
      // A live stream never ends; its headers are the answer.
      await response.body?.cancel();
      answers.set(route, { status: response.status, headers: headersOf(response) });
    }
    return answers;
  } finally {
    await pool.end();
    await rm(distDir, { recursive: true, force: true });
  }
}

/**
 * Every difference between what the routes answered and the baseline, one line each: a route
 * with no group in the baseline, a route answering with headers other than its group's, and a
 * baseline route no longer served.
 */
export function headersProblems(
  answers: Map<string, RouteAnswer>,
  baseline: HeadersBaseline
): string[] {
  const problems: string[] = [];
  for (const [route, answer] of answers) {
    const want = baseline.routes[route];
    const got = groupOfHeaders(answer.headers, baseline.groups);
    if (!want) problems.push(`no header group: ${route} (answers as ${got ?? 'no group'})`);
    else if (got !== want)
      problems.push(
        `${route} should carry ${want}, carries ${got ?? JSON.stringify(answer.headers)}`
      );
  }
  for (const route of Object.keys(baseline.routes))
    if (!answers.has(route)) problems.push(`no longer served: ${route}`);
  return problems.sort();
}
