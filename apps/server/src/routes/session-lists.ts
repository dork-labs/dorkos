/**
 * The two chat lists under `/api/sessions`, a page at a time (DOR-4982):
 * `GET /` (one folder's chats, aggregated across runtimes, ADR-0310) and
 * `GET /recent` (every agent's chats, DOR-329). Both page latest activity
 * first, filter per reader before the page is cut, and seal the cursor to the
 * reader (`services/session/catalog/session-list-page.ts`).
 *
 * Both MUST be registered before the `/:id` routes in `sessions.ts`: `/:id`
 * matches `recent` too, and Hono answers from the first route registered.
 *
 * @module routes/session-lists
 */
import { createHash } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { ListSessionsQuerySchema, RecentSessionsQuerySchema } from '@dorkos/shared/schemas';
import type { RecentSessionsResponse, SessionListResponse } from '@dorkos/shared/types';
import { INVALID_CURSOR_DETAIL } from '@dorkos/shared/paging';
import { problem, sendProblem, validationProblem } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { boundaryRefusal } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { assertPageCursor } from '../lib/paging/keyset-page.js';
import { readerKey } from '../lib/paging/sealed-cursor.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  invalidCursor,
  isInvalidCursor,
} from '../services/core/capabilities/capability-definition.js';
import {
  aggregateSessionList,
  applySessionFleetOverlay,
  applySessionOriginOverlays,
  mergeRecentSessions,
  overlayStoredSettings,
  recentSessionsPage,
  sessionFleetOverlayDeps,
  sessionListPage,
  sessionOriginResolvers,
} from '../services/session/index.js';
import { readableSessions, readerOfRequest } from './audit-reader.js';
import { touchedSinceKeeper } from './session-touch-handler.js';
import type { SessionRouteDeps } from './sessions.js';

/** The refusal a cursor another list or reader got answers with, as on every paged route. */
function cursorRefusal(c: Context<ApiEnv>): Response {
  return problem(c, 'invalid_request', { detail: INVALID_CURSOR_DETAIL });
}

/** One folder's list, named by a digest so its cursor stays one fixed size. */
function folderListName(projectDir: string, runtime: string | undefined): string {
  const digest = createHash('sha256').update(`${projectDir}\0${runtime ?? ''}`);
  return `sessions:${digest.digest('base64url').slice(0, 22)}`;
}

/**
 * Mount `GET /` and `GET /recent` on the session routes.
 *
 * @param router - The `/api/sessions` route group, before its `/:id` routes.
 * @param deps - The session routes' dependencies.
 */
export function mountSessionListRoutes(router: Hono<ApiEnv>, deps: SessionRouteDeps): void {
  // GET /api/sessions - one folder's chats across every registered runtime
  // (ADR-0310), in the { sessions, nextCursor, warnings?, accountUsage? }
  // envelope: aggregation degrades per runtime, and the in-band warnings[] must
  // survive both transports (an HTTP header would be invisible to the Direct
  // in-process transport). See SessionListResponseSchema.
  router.get('/', async (c) => {
    const parsed = ListSessionsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) return validationProblem(c, parsed.error);
    const { cursor, limit, cwd, runtime: runtimeFilter } = parsed.data;
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return sendProblem(c, outside);
    if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
      return problem(c, 'invalid_request', { detail: `Unknown runtime: ${runtimeFilter}` });
    }
    const projectDir = cwd || DEFAULT_CWD;
    const facts = honoRequestFacts(c);
    const options = {
      list: folderListName(projectDir, runtimeFilter),
      query: { cursor, limit },
      sealedFor: readerKey(readerOfRequest(facts)),
      refuse: invalidCursor,
    };
    // A cursor this list did not give is refused before the runtimes are read.
    try {
      assertPageCursor(options.list, cursor, invalidCursor, options.sealedFor);
    } catch {
      return cursorRefusal(c);
    }

    const runtimes = runtimeFilter
      ? [runtimeRegistry.get(runtimeFilter)]
      : runtimeRegistry.listRuntimes();
    const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });
    // An agent lists agent work only, never a person's own chat (spec
    // `audit-trail` §3.4). Filtered before the page is cut, so the page is full.
    const { items: page, nextCursor } = sessionListPage(readableSessions(facts, sessions), options);
    // Overlay persisted settings (ADR-0260) through the ONE shared resolver that
    // `GET /:id` also uses, so the two endpoints cannot report different modes
    // for one session (DOR-463).
    overlayStoredSettings(page, runtimeRegistry);
    // Overlay the origins no transcript can carry — the room binding and the Pulse
    // run (session-origin-legibility, team-room-home §D2.3). The ordering rule
    // lives in `applySessionOriginOverlays`, which the global session-list stream
    // applies too, so a room turn reads the same way whichever one a client heard
    // it from (DOR-1141).
    applySessionOriginOverlays(page, sessionOriginResolvers(deps));
    // The fleet fields (spec claude-account-fleet D7): each session's account,
    // live status and work item, and the usage of the accounts on the page. One
    // pass over the page, from memory plus one limit query.
    const accountUsage = await applySessionFleetOverlay(page, sessionFleetOverlayDeps());
    return c.json({
      sessions: page,
      nextCursor,
      ...(warnings.length > 0 && { warnings }),
      ...(accountUsage && { accountUsage }),
    } satisfies SessionListResponse);
  });

  // GET /api/sessions/recent - the latest chats across ALL agents (DOR-329).
  // Resolves agent project paths server-side via the mesh registry, then fans
  // out (bounded concurrency, subtree cwd membership per DOR-203 + DOR-674,
  // ADR-0310 per-runtime degradation).
  router.get('/recent', async (c) => {
    const parsed = RecentSessionsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) return validationProblem(c, parsed.error);
    const { cursor, limit, touchedSince } = parsed.data;
    const facts = honoRequestFacts(c);
    const options = {
      list: 'sessions-recent',
      query: { cursor, limit },
      sealedFor: readerKey(readerOfRequest(facts)),
      refuse: invalidCursor,
    };
    try {
      assertPageCursor(options.list, cursor, invalidCursor, options.sealedFor);
    } catch {
      return cursorRefusal(c);
    }

    const agentPaths = deps.meshCore?.listWithPaths().map((a) => a.projectPath) ?? [];
    const { merged, agentActivity, warnings } = await mergeRecentSessions({
      runtimes: runtimeRegistry.listRuntimes(),
      agentPaths,
    });
    // An agent sees agent work only, never a person's own chat (spec
    // `audit-trail` §3.4), filtered before the page is cut.
    const readable = readableSessions(facts, merged);
    // Every chat you touched since the caller's day began comes on the first
    // page, however many agent-busy chats outrank it (spec `your-activity-first` D6).
    const kept = touchedSince
      ? touchedSinceKeeper(touchedSince, sessionOriginResolvers(deps).resolveTouches)(readable)
      : new Set<string>();
    let page;
    try {
      page = recentSessionsPage(readable, kept, options);
    } catch (error) {
      if (isInvalidCursor(error)) return cursorRefusal(c);
      throw error;
    }
    // Same persisted-settings overlay as the other two session reads — a recent
    // session is the same session, so it must not report a different mode.
    overlayStoredSettings(page.items, runtimeRegistry);
    // The same origin overlays the list endpoint applies, in the same order — a
    // room turn is an engine run under a thread the reader can already see, and
    // the binding table is the only place that knows.
    applySessionOriginOverlays(page.items, sessionOriginResolvers(deps));
    return c.json({
      sessions: page.items,
      nextCursor: page.nextCursor,
      agentActivity,
      warnings,
    } satisfies RecentSessionsResponse);
  });
}
