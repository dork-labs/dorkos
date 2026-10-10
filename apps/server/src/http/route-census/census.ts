/**
 * The route census (DOR-2793): every method and path the server answers, and
 * which framework answers it.
 *
 * During the move from Express to Hono each route group leaves Express and
 * arrives in Hono in one PR. The census is how that is checked rather than
 * trusted: `__tests__/route-census.test.ts` boots the real server, reads this
 * census from it, and requires that the two sides never overlap and that each
 * equals the committed baseline. A move PR may only move entries from the
 * `express` side to the `hono` side; adding or removing a route is a baseline
 * edit a reviewer sees.
 *
 * ## What an entry is
 *
 * `METHOD /path`, with the method upper-cased (`ALL` for a route that takes
 * any method). A non-root `app.use` or `router.use` of something that is not a
 * router is recorded as `USE /path`: middleware, a mounted handler or a lazily
 * built router. Middleware mounted at the root of a router is left out; it runs
 * for everything and serves nothing on its own.
 *
 * ## What it cannot see
 *
 * - One `USE` entry can stand for several middlewares at the same path (the
 *   `/api` host guard and the `/api` 404 are both `USE /api`), and a lazily
 *   built router (`/api/ext/:id`) is one entry for everything behind it.
 * - A route given as a regular expression is recorded as its source text,
 *   which Hono cannot write the same way; its move needs a baseline edit.
 * - It is the census of a TEST server (`__tests__/contract/harness.ts`): the
 *   `/api/test` control routes are in it, and the production-only static app
 *   and SPA fallback are not. Those get their own contract when they move.
 * - Equal strings are not the only way two routes collide. Hono answers first,
 *   so a Hono `GET /a/:id` would swallow an Express `GET /a/catalog`.
 *   {@link shadowProblems} checks for that.
 *
 * @module http/route-census/census
 */
import { METHODS } from 'node:http';
import { Hono } from 'hono';

/** The tag `record-mount-paths.ts` puts on each Express layer: its mount path. */
export const MOUNT_PATH = Symbol.for('dorkos.route-census.mount-path');

/** The census of one running server, each side sorted. */
export interface RouteCensus {
  /** Routes the Hono front door serves itself. */
  readonly hono: readonly string[];
  /** Routes the Express app behind it serves. */
  readonly express: readonly string[];
}

/** The Hono routes that are the front door's own plumbing, not routes it serves. */
export const FRONT_DOOR_PLUMBING = ['ALL /*', 'GET /api/test/route-census'] as const;

/** What the census reads off an Express layer. */
interface Layer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
  [MOUNT_PATH]?: unknown;
}

/** Join a mount prefix and a path, with one slash between and none trailing. */
function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}/${path}`.replace(/\/+/g, '/');
  return joined.length > 1 ? joined.replace(/\/$/, '') : joined;
}

/** Each path a layer was given: a string, a pattern, or an array of either. */
function pathsOf(path: unknown): string[] {
  if (Array.isArray(path)) return path.flatMap(pathsOf);
  return [String(path)];
}

/** Every entry under one Express router stack. */
function walk(stack: readonly Layer[], prefix: string, into: Set<string>): void {
  for (const layer of stack) {
    if (layer.route) {
      const declared = Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]);
      // Express 5's `app.all` registers every method one by one; say so once.
      const methods = METHODS.every((m) => declared.includes(m.toLowerCase()))
        ? ['ALL']
        : declared.map((m) => (m === '_all' ? 'ALL' : m.toUpperCase()));
      for (const path of pathsOf(layer.route.path)) {
        for (const method of methods) into.add(`${method} ${joinPath(prefix, path)}`);
      }
      continue;
    }
    for (const mount of pathsOf(layer[MOUNT_PATH] ?? '/')) {
      const at = joinPath(prefix, mount);
      if (layer.handle?.stack) walk(layer.handle.stack, at, into);
      else if (mount !== '/') into.add(`USE ${at}`);
    }
  }
}

/**
 * The Express side of the census.
 *
 * @param app - The Express app, or anything with its router.
 * @returns Every entry, sorted, or `undefined` when the mount paths were not
 *   recorded (the server was started without `record-mount-paths.ts`).
 */
export function expressCensus(app: { router: { stack: readonly Layer[] } }): string[] | undefined {
  const stack = app.router.stack;
  const recorded = stack.some((layer) => layer[MOUNT_PATH] !== undefined);
  if (!recorded) return undefined;
  const entries = new Set<string>();
  walk(stack, '/', entries);
  return [...entries].sort();
}

/**
 * The Hono side of the census, without the front door's own plumbing.
 *
 * @param app - The front door's Hono app.
 * @returns Every entry, sorted.
 */
export function honoCensus(app: Pick<Hono, 'routes'>): string[] {
  const plumbing = new Set<string>(FRONT_DOOR_PLUMBING);
  const entries = new Set(app.routes.map((route) => `${route.method.toUpperCase()} ${route.path}`));
  return [...entries].filter((entry) => !plumbing.has(entry)).sort();
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
  const express = new Set(actual.express);
  for (const entry of actual.hono) {
    if (express.has(entry)) problems.push(`both frameworks serve ${entry}`);
  }
  for (const side of ['hono', 'express'] as const) {
    const want = new Set(baseline[side]);
    const have = new Set(actual[side]);
    for (const entry of want)
      if (!have.has(entry)) problems.push(`${side} no longer serves ${entry}`);
    for (const entry of have)
      if (!want.has(entry)) problems.push(`${side} now serves ${entry}, not in the baseline`);
  }
  return problems;
}

/** Split an entry into its method and path. */
function parseEntry(entry: string): { method: string; path: string } {
  const space = entry.indexOf(' ');
  return { method: entry.slice(0, space), path: entry.slice(space + 1) };
}

/**
 * Every Express entry a Hono route would catch first, since the front door
 * routes to Hono before it hands anything to Express.
 *
 * Each Express path is turned into one concrete request (a `:param` becomes a
 * sample segment, a `*splat` two) and offered to a router holding only the
 * Hono side. Anything it matches is a request that would no longer reach
 * Express. Regular-expression paths are skipped.
 *
 * @param census - The census of a running server.
 * @returns One line per shadowed Express entry.
 */
export async function shadowProblems(census: RouteCensus): Promise<string[]> {
  if (census.hono.length === 0) return [];
  const probe = new Hono();
  for (const entry of census.hono) {
    const { method, path } = parseEntry(entry);
    const answer = () => new Response(entry);
    if (method === 'ALL' || method === 'USE') {
      probe.all(path, answer);
      if (method === 'USE') probe.all(`${path === '/' ? '' : path}/*`, answer);
    } else {
      probe.on(method, path, answer);
    }
  }
  const problems: string[] = [];
  for (const entry of census.express) {
    const { method, path } = parseEntry(entry);
    if (!path.startsWith('/')) continue;
    const sample = path
      .replace(/:[A-Za-z0-9_]+/g, 'census-sample')
      .replace(/\*[A-Za-z0-9_]*/g, 'census/sample');
    const res = await probe.request(sample, {
      method: method === 'ALL' || method === 'USE' ? 'GET' : method,
    });
    if (res.status !== 404) problems.push(`hono's ${await res.text()} catches ${entry}`);
  }
  return problems;
}
