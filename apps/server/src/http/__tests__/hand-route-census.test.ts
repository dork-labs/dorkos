/**
 * Every served `/api` route is one of three things (ADR 261123-170830): a
 * capability the generic mount serves, a hand route on the permanent allowlist
 * (`http/hand-routes/allowlist.ts`), or a hand route still waiting to move, on
 * the pending list (`http/hand-routes/pending.json`). The pending list may only
 * shrink: a new route is a capability or an allowlisted shape, never pending.
 *
 * It reads the committed route census, which `route-census.test.ts` proves
 * equals what the real server serves, so it needs no server of its own.
 * Hono records middleware as `ALL` too, so the census cannot tell a gate from
 * a handler there: every `ALL` entry must be allowlisted or named in
 * {@link KNOWN_ALL}, which says what each one is, so a new `.all()` handler
 * cannot slip past unclassified. The `/api/test` control routes are left out
 * because only a test server mounts them.
 *
 * After moving routes onto capabilities or deleting them, drop their entries:
 *
 *   UPDATE_HAND_ROUTE_PENDING=1 pnpm vitest run apps/server/src/http/__tests__/hand-route-census.test.ts
 *
 * which only removes entries, and lower {@link PENDING_CEILING} to the new count.
 *
 * @vitest-environment node
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { HAND_ROUTE_ALLOWLIST } from '../hand-routes/allowlist.js';
import { honoPath, mountedCapabilities, routeKey } from '../../routes/capability-http.js';
import type { RouteCensus } from '../route-census/census.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CENSUS = path.join(HERE, 'route-census.baseline.json');
const PENDING = path.join(HERE, '..', 'hand-routes', 'pending.json');

/**
 * How many routes may still wait to move. It may only fall: lower it in every
 * change that shrinks the pending list. A route added to the pending list fails
 * here, and a PR that raises this number needs the API lead's OK first.
 */
const PENDING_CEILING = 550;

/**
 * The census's `ALL` entries that are neither allowlisted nor capabilities, each
 * with what it is. Add one only for middleware (a gate that calls `next`); a
 * new `.all()` handler is a capability or an allowlisted shape instead.
 */
// Every entry comes from a `use(...)` call (a gate or a body reader that calls
// `next`) but three kinds of `.all()` handler: the two `/api/ext` routers, and
// the catch-all 404s of canvas docs and feedback. The other `.all()` handlers
// (`/api/auth/*`, `/api/docs`, the media route) are allowlisted.
const KNOWN_ALL: Readonly<Record<string, string>> = {
  'ALL /api/admin/*': 'middleware (`use`) in front of the group',
  'ALL /api/browser-viewers/*': 'middleware (`use`) in front of the group',
  'ALL /api/canvas/docs/*': "the group's catch-all 404 (`all('*')`), plus its body rule",
  'ALL /api/cloud/communities/*': 'middleware (`use`) in front of the group',
  'ALL /api/communities/*': "middleware: the remote spaces' experiment gate",
  'ALL /api/community-connections/*': "middleware: the space connections' experiment gate",
  'ALL /api/connectors/*': 'middleware (`use`) in front of the group',
  'ALL /api/connectors/connections/:connectionId/events':
    'middleware (`use`) in front of the group',
  'ALL /api/connectors/connections/:connectionId/events/*':
    'middleware (`use`) in front of the group',
  'ALL /api/connectors/providers/*': 'middleware (`use`) in front of the group',
  'ALL /api/devices/*': 'middleware (`use`) in front of the group',
  'ALL /api/ext/:id': "an app's own server routes, which the app declares and serves",
  'ALL /api/ext/:id/*': "an app's own server routes, which the app declares and serves",
  'ALL /api/feedback/*': "the group's catch-all 404 (`all('*')`), plus its body rule",
  'ALL /api/hub/computers/*': 'middleware (`use`) in front of the group',
  'ALL /api/local-browser/*': 'middleware (`use`) in front of the group',
  'ALL /api/owner-factors/*': 'middleware (`use`) in front of the group',
  'ALL /api/person-session/*': 'middleware (`use`) in front of the group',
  'ALL /api/runtimes/claude-code/signins/*': 'middleware (`use`) in front of the group',
  'ALL /api/session-locations/*': 'middleware (`use`) in front of the group',
  'ALL /api/sessions/:id/*': 'middleware (`use`) in front of the group',
  'ALL /api/sign-in-landings/*': 'middleware (`use`) in front of the group',
  'ALL /api/step-up/*': 'middleware (`use`) in front of the group',
  'ALL /api/tasks': 'middleware: asks for the person before a task write',
  'ALL /api/tasks/*': 'middleware: asks for the person before a task write',
};

interface PendingFile {
  readonly $comment: string;
  readonly routes: readonly string[];
}

const census = (JSON.parse(readFileSync(CENSUS, 'utf8')) as RouteCensus).routes;
const pendingFile = JSON.parse(readFileSync(PENDING, 'utf8')) as PendingFile;
const pending = pendingFile.routes;

/** The `/api` routes this census classifies: everything but test-only routes and known `ALL` entries. */
const served = census.filter((entry) => {
  const route = entry.split(' ')[1]!;
  return route.startsWith('/api/') && !route.startsWith('/api/test/') && !(entry in KNOWN_ALL);
});

const capabilityShapes = new Set(
  mountedCapabilities().map((capability) => {
    const http = capability.surfaces.http!;
    return routeKey(http.method, honoPath(http.path));
  })
);
const allowlisted = new Set(HAND_ROUTE_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`));

/** Whether the mount serves this census entry. */
function isCapability(entry: string): boolean {
  const [method, route] = entry.split(' ') as [string, string];
  return capabilityShapes.has(routeKey(method, route));
}

describe('hand route census', () => {
  it('classifies every served /api route as a capability, allowlisted or pending', () => {
    // An empty census classifies nothing and passes nothing.
    expect(served.length).toBeGreaterThan(100);
    const waiting = new Set(pending);
    const unclassified = served.filter(
      (entry) => !isCapability(entry) && !allowlisted.has(entry) && !waiting.has(entry)
    );
    expect(
      unclassified,
      'Serve a new route as a capability `http` surface, or allowlist its shape with a reason.'
    ).toEqual([]);
  });

  it('keeps the pending list sorted, unique and only routes still served by hand', () => {
    if (process.env.UPDATE_HAND_ROUTE_PENDING === '1') {
      const still = new Set(
        served.filter((entry) => !isCapability(entry) && !allowlisted.has(entry))
      );
      const routes = pending.filter((entry) => still.has(entry));
      writeFileSync(PENDING, `${JSON.stringify({ ...pendingFile, routes }, null, 2)}\n`);
      return;
    }
    expect(pending).toEqual([...new Set(pending)].sort());
    const servedSet = new Set(served);
    expect(
      pending.filter((entry) => !servedSet.has(entry)),
      'no longer served'
    ).toEqual([]);
    expect(pending.filter(isCapability), 'now a capability').toEqual([]);
    expect(
      pending.filter((entry) => allowlisted.has(entry)),
      'now allowlisted'
    ).toEqual([]);
  });

  it('names only ALL entries the census still has', () => {
    const censusSet = new Set(census);
    expect(Object.keys(KNOWN_ALL).filter((entry) => !censusSet.has(entry))).toEqual([]);
    expect(Object.keys(KNOWN_ALL).filter((entry) => allowlisted.has(entry))).toEqual([]);
  });

  it('only shrinks the pending list', () => {
    expect(pending.length).toBeLessThanOrEqual(PENDING_CEILING);
  });

  it('allowlists only served routes, each once, with a reason', () => {
    const censusSet = new Set(census);
    const entries = HAND_ROUTE_ALLOWLIST.map((entry) => `${entry.method} ${entry.path}`);
    expect(
      entries.filter((entry) => !censusSet.has(entry)),
      'no longer served'
    ).toEqual([]);
    expect(entries).toEqual([...new Set(entries)]);
    expect(entries.filter(isCapability), 'now a capability').toEqual([]);
    for (const entry of HAND_ROUTE_ALLOWLIST) expect(entry.reason.trim()).not.toBe('');
  });
});
