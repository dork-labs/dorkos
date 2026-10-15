/**
 * The route census (DOR-2793): every method and path the server answers.
 *
 * It was built to check the move from Express to Hono rather than trust it,
 * one route group at a time. With the move done it keeps one job: adding or
 * removing a route is a visible edit to the committed baseline, never an
 * accident. `__tests__/route-census.test.ts` boots the real server, reads this
 * census from it, and requires that it equals the baseline.
 *
 * ## What an entry is
 *
 * `METHOD /path`, with the method upper-cased (`ALL` for a route that takes
 * any method), as Hono records it. Middleware registered on a path (a gate in
 * front of one group) is an `ALL` entry too, because Hono records `use(path)`
 * and `all(path)` alike. The chain's own middleware, on every path, is left
 * out: it serves nothing on its own.
 *
 * ## What it cannot see
 *
 * - A lazily built router (`/api/ext/:id/*`) is one entry for everything
 *   behind it.
 * - It is the census of a TEST server (`__tests__/contract/harness.ts`): the
 *   `/api/test` control routes are in it, and the production-only client files
 *   are not, because they answer what no route claims (`http/unclaimed.ts`).
 *
 * @module http/route-census/census
 */
import type { Hono } from 'hono';

/** Where a test server serves its census. */
export const ROUTE_CENSUS_PATH = '/api/test/route-census';

/** The census of one running server, sorted. */
export interface RouteCensus {
  /** Every route the server answers. */
  readonly routes: readonly string[];
}

/**
 * The census of an app, without the chain's own middleware and the census
 * route itself.
 *
 * @param app - The server's Hono app.
 * @returns Every entry, sorted.
 */
export function routeCensus(app: Pick<Hono, 'routes'>): RouteCensus {
  const entries = new Set(app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`));
  entries.delete('ALL /*');
  entries.delete(`GET ${ROUTE_CENSUS_PATH}`);
  return { routes: [...entries].sort() };
}

/**
 * Serve the census at {@link ROUTE_CENSUS_PATH}. Only a test server does.
 *
 * @param app - The server's Hono app, which the census reads per request.
 */
export function serveRouteCensus<E extends object>(app: Hono<E>): void {
  app.get(ROUTE_CENSUS_PATH, (c) => c.json(routeCensus(app)));
}

/**
 * Every way a census differs from its baseline, in words a failing test can
 * print. Empty when they agree.
 *
 * @param actual - The census read from a running server.
 * @param baseline - The committed baseline.
 * @returns One line per problem.
 */
export function censusProblems(actual: RouteCensus, baseline: RouteCensus): string[] {
  const problems: string[] = [];
  const want = new Set(baseline.routes);
  const have = new Set(actual.routes);
  for (const entry of want) if (!have.has(entry)) problems.push(`no longer serves ${entry}`);
  for (const entry of have) {
    if (!want.has(entry)) problems.push(`now serves ${entry}, not in the baseline`);
  }
  return problems;
}
