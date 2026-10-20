/**
 * The space server's route census (specs/server-merge step 1, DOR-2875). It composes the app the
 * way `createSpaceServer` does (`createCommunityApp`, then `registerPages`) and reads every method and path
 * from Hono's own route table, never from a hand list. The pool is never connected: registering
 * routes reads no database, so the census runs in the ordinary unit suite.
 *
 * The census is in the pattern of the Hono move's (DOR-2793). It is composed with every setting
 * that registers a route switched on ({@link FULL_ENV}), so the baseline is the whole set.
 *
 * It pins the set of routes, not the order Hono matches them in. The one order that matters
 * today, the refusal of `/api/auth/reset-password/*` before Better Auth's catch-all, is guarded by
 * email-links.integration.test.ts (T8, T17).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { Pool } from 'pg';
import { createCommunityApp } from '../../app.js';
import { createCommunityAuth } from '../../auth.js';
import { COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE, parseConfig } from '../../config.js';
import { emailLinkComposers } from '../../email-links/composers.js';
import { ownerReplacementComposers } from '../../owner-replacement/notices.js';
import { registerPages } from '../../pages/register.js';
import { signInLinkComposers } from '../../sign-in/linked.js';

/** Settings for a server that is composed, never started. Its database is never reached. */
export const CENSUS_ENV = {
  COMMUNITY_DATABASE_URL: 'postgres://census@127.0.0.1:1/census',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: join(tmpdir(), 'community-route-census-blobs'),
} as const;

/** Every setting that registers Better Auth routes: all three providers and mail. */
const ALL_SIGN_IN_ENV = {
  ...CENSUS_ENV,
  COMMUNITY_GOOGLE_CLIENT_ID: 'google-client',
  COMMUNITY_GOOGLE_CLIENT_SECRET: 'google-secret',
  COMMUNITY_GITHUB_CLIENT_ID: 'github-client',
  COMMUNITY_GITHUB_CLIENT_SECRET: 'github-secret',
  COMMUNITY_OIDC_ISSUER_URL: 'https://issuer.example',
  COMMUNITY_OIDC_CLIENT_ID: 'oidc-client',
  COMMUNITY_OIDC_CLIENT_SECRET: 'oidc-secret',
  COMMUNITY_SMTP_URL: 'smtps://smtp.example.com',
  COMMUNITY_MAIL_FROM: 'spaces@example.com',
} as const;

/**
 * Every setting that turns a route or a sign-in option on: the providers and mail above, plus the
 * sign-up rules (each registers its confirmation route only when set) and an evidence store.
 */
export const FULL_ENV = {
  ...ALL_SIGN_IN_ENV,
  COMMUNITY_MINIMUM_AGE: '16',
  COMMUNITY_ALLOWED_COUNTRIES: 'US',
  COMMUNITY_EVIDENCE_DRIVER: 'filesystem',
  // Outside the temporary folder, as the setting requires. Nothing here creates or writes it.
  COMMUNITY_EVIDENCE_PATH: '/srv/community-route-census-evidence',
} as const;

/** The groups a route is filed under, so a reviewer sees which promise a change touches. */
export const CENSUS_GROUPS = [
  'health',
  'api',
  'community',
  'host',
  'page',
  'user-content',
  'test-only',
  'mounts',
] as const;

/** One group of the census. */
type CensusGroup = (typeof CENSUS_GROUPS)[number];

/** Every route, as `METHOD /path`, by group and sorted. */
export type RouteCensus = Record<CensusGroup, string[]>;

const HEALTH_PATHS = new Set(['/health', '/health/ready', '/metrics']);

/**
 * File one route. `ALL` entries are the middleware and catch-all mounts (`app.use`, `app.all`),
 * such as the Better Auth handler at `/api/auth/*`; Hono records both the same way.
 */
function groupOf(method: string, path: string): CensusGroup {
  if (method === 'ALL') return 'mounts';
  if (HEALTH_PATHS.has(path)) return 'health';
  if (path.startsWith('/api/v1/communities/:communityId/')) return 'community';
  if (path.startsWith('/api/v1/host/') || path === '/api/v1/host-links') return 'host';
  if (path.startsWith('/api/')) return 'api';
  // Signed download links (DOR-2957): the one route the user-content address answers.
  if (path.startsWith('/u/')) return 'user-content';
  return 'page';
}

/** A census app and the pool to end once it has been read. */
export interface CensusApp {
  app: Hono;
  pool: Pool;
}

/**
 * Compose the app as `createSpaceServer` does, with the mail composers it passes, against a database
 * it never reaches.
 *
 * @param testRuntime - Compose the test runtime's app, which adds the test-only routes.
 * @param distDir - The built page folder; the census reads routes only, so it need not exist.
 */
export function composeCensusApp(
  testRuntime: boolean,
  distDir = join(tmpdir(), 'community-route-census-dist')
): CensusApp {
  const config = parseConfig({
    ...FULL_ENV,
    ...(testRuntime
      ? {
          COMMUNITY_TEST_RUNTIME: 'true',
          COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT: COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE,
        }
      : {}),
  });
  const pool = new Pool({ connectionString: config.databaseUrl });
  const noticeComposers = {
    ...ownerReplacementComposers(config),
    ...signInLinkComposers(config),
    ...emailLinkComposers(config),
  };
  const app = createCommunityApp({ config, pool, noticeComposers });
  registerPages(app, { distDir });
  return { app, pool };
}

/** The distinct `METHOD /path` pairs an app registered. */
function routesOf(app: Hono): Set<string> {
  return new Set(app.routes.map((route) => `${route.method} ${route.path}`));
}

/**
 * Read the census from the composed app. Test-only routes are the ones a server with
 * `COMMUNITY_TEST_RUNTIME` serves and a production server does not.
 *
 * @param extend - Changes the production app before it is read, so a test can prove the census
 *   sees a change.
 */
export async function readRouteCensus(extend?: (app: Hono) => void): Promise<RouteCensus> {
  const production = composeCensusApp(false);
  const testing = composeCensusApp(true);
  try {
    extend?.(production.app);
    const served = routesOf(production.app);
    const census = Object.fromEntries(
      CENSUS_GROUPS.map((group) => [group, [] as string[]])
    ) as RouteCensus;
    for (const route of served) {
      const [method, path] = route.split(' ');
      census[groupOf(method, path)].push(route);
    }
    for (const route of routesOf(testing.app))
      if (!served.has(route)) census['test-only'].push(route);
    for (const group of CENSUS_GROUPS) census[group].sort();
    return census;
  } finally {
    await Promise.all([production.pool.end(), testing.pool.end()]);
  }
}

/** Every difference between a census and its baseline, one line each, for a readable failure. */
export function censusProblems(actual: RouteCensus, baseline: RouteCensus): string[] {
  const problems: string[] = [];
  const where = (census: RouteCensus) => {
    const map = new Map<string, CensusGroup>();
    for (const group of CENSUS_GROUPS)
      for (const route of census[group] ?? []) map.set(route, group);
    return map;
  };
  const have = where(actual);
  const want = where(baseline);
  for (const [route, group] of have) {
    const was = want.get(route);
    if (!was) problems.push(`added (${group}): ${route}`);
    else if (was !== group) problems.push(`moved from ${was} to ${group}: ${route}`);
  }
  for (const [route, group] of want)
    if (!have.has(route)) problems.push(`removed (${group}): ${route}`);
  return problems.sort();
}

/** A Better Auth endpoint as its `api` object exposes it. */
interface Endpoint {
  path?: string;
  options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } };
}

/** The app refuses these before Better Auth's handler (app.ts). */
const REFUSED_PREFIXES = ['/reset-password/'];

/**
 * The routes a Better Auth instance answers over HTTP: every endpoint with a path that is not
 * server-only, not in `disabledPaths`, and not under a prefix the app refuses before Better Auth
 * sees it. Paths are relative to the `/api/auth` mount.
 */
function betterAuthHttpRoutes(
  api: Record<string, unknown>,
  disabledPaths: readonly string[]
): string[] {
  const routes = new Set<string>();
  for (const value of Object.values(api)) {
    const endpoint = value as Endpoint;
    if (typeof endpoint.path !== 'string' || endpoint.options?.metadata?.SERVER_ONLY) continue;
    if (disabledPaths.includes(endpoint.path)) continue;
    if (REFUSED_PREFIXES.some((prefix) => endpoint.path!.startsWith(prefix))) continue;
    const methods = endpoint.options?.method ?? 'GET';
    for (const method of Array.isArray(methods) ? methods : [methods])
      routes.add(`${method} ${endpoint.path}`);
  }
  return [...routes].sort();
}

/**
 * Read the Better Auth routes a server with every provider and mail on answers.
 *
 * @param extend - Adds endpoints before they are read, so a test can prove an unreviewed one shows.
 */
export async function readBetterAuthRoutes(
  extend: Record<string, unknown> = {}
): Promise<string[]> {
  const config = parseConfig(ALL_SIGN_IN_ENV);
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const auth = createCommunityAuth(pool, config, { emailLinksOn: true });
    return betterAuthHttpRoutes(
      { ...(auth.api as unknown as Record<string, unknown>), ...extend },
      auth.options.disabledPaths ?? []
    );
  } finally {
    await pool.end();
  }
}

/**
 * The reviewed Better Auth routes and why each is on (`../better-auth-routes.allowlist.json`).
 * The `$comment` key is the file's own note.
 */
export function betterAuthAllowlist(): Record<string, string> {
  const file = JSON.parse(
    readFileSync(new URL('../better-auth-routes.allowlist.json', import.meta.url), 'utf8')
  ) as Record<string, string>;
  return Object.fromEntries(Object.entries(file).filter(([route]) => route !== '$comment'));
}
