/**
 * Session collection reads registered before parameterized session routes.
 * @module routes/session-list-routes
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import {
  ListSessionsQuerySchema,
  RecentSessionsQuerySchema,
  SessionDailyCountsQuerySchema,
} from '@dorkos/shared/schemas';
import type { SessionListResponse } from '@dorkos/shared/types';
import type { ApiEnv } from '../http/api-chain.js';
import type { SessionRouteDeps } from './sessions.js';
import { readQuery } from '../http/request-query.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { boundaryRefusal, errorBody } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { projectsOfFolders } from '../services/projects/project-registry.js';
import { askEntitlement, type AskSubject } from '../services/session/asks/ask-entitlement.js';
import {
  aggregateSessionList,
  listRecentSessions,
  listPendingInteractionsAcrossSessions,
  countSessionsPerDay,
  applySessionOriginOverlays,
  applySessionFleetOverlay,
  sessionFleetOverlayDeps,
  sessionOriginResolvers,
  overlayStoredSettings,
} from '../services/session/index.js';
import { readableSessions } from './session-read-guard.js';
import { touchedSinceKeeper } from './session-touch-handler.js';

const vaultRoot = DEFAULT_CWD;

/**
 * Register the original four collection reads in their original order before `/:id` handlers.
 * @param router - The constructed session router with its original session read guard installed.
 * @param deps - The same installation-owned dependencies retained by the session router.
 */
export function installSessionListRoutes(router: Hono<ApiEnv>, deps: SessionRouteDeps): void {
  // GET /api/sessions - List sessions aggregated across all registered runtimes
  // (ADR-0310). Responds with the { sessions, warnings?, accountUsage? } envelope rather than a
  // bare array: aggregation degrades gracefully per runtime, and the in-band
  // warnings[] must survive both transports (an HTTP header would be invisible
  // to the Direct in-process transport). See SessionListResponseSchema.
  router.get('/', async (c) => {
    const parsed = ListSessionsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    const { limit, cwd, runtime: runtimeFilter } = parsed.data;
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return c.json(outside, 403);
    if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
      return c.json(errorBody(`Unknown runtime: ${runtimeFilter}`, 'UNKNOWN_RUNTIME'), 400);
    }

    const projectDir = cwd || vaultRoot;
    const runtimes = runtimeFilter
      ? [runtimeRegistry.get(runtimeFilter)]
      : runtimeRegistry.listRuntimes();
    const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });

    // An agent lists agent work only, never a person's own chat (spec
    // `audit-trail` §3.4). Filtered before the page is cut, so the page is full.
    const page = readableSessions(honoRequestFacts(c), sessions).slice(0, limit);
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
      ...(warnings.length > 0 && { warnings }),
      ...(accountUsage && { accountUsage }),
    } satisfies SessionListResponse);
  });

  // GET /api/sessions/recent - Most-recent sessions across ALL agents (DOR-329).
  // MUST be registered before the `/:id` routes below: `/:id` matches `recent` too,
  // and Hono answers from the first route registered. Resolves agent project paths server-side via the
  // mesh registry, then fans out via listRecentSessions (bounded concurrency,
  // subtree cwd membership per DOR-203 + DOR-674, ADR-0310 per-runtime
  // degradation).
  router.get('/recent', async (c) => {
    const parsed = RecentSessionsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    const { limit, touchedSince } = parsed.data;

    const meshCore = deps.meshCore;
    const agentPaths = meshCore ? meshCore.listWithPaths().map((a) => a.projectPath) : [];
    const runtimes = runtimeRegistry.listRuntimes();

    const { sessions, agentActivity, warnings } = await listRecentSessions({
      runtimes,
      agentPaths,
      limit,
      // Every chat you touched since the caller's day began stays, however many
      // agent-busy chats outrank it by `updatedAt` (spec `your-activity-first` D6).
      ...(touchedSince && {
        keepBeyondLimit: touchedSinceKeeper(
          touchedSince,
          sessionOriginResolvers(deps).resolveTouches
        ),
      }),
    });
    // An agent sees agent work only, never a person's own chat (spec
    // `audit-trail` §3.4).
    const readable = readableSessions(honoRequestFacts(c), sessions);
    // Same persisted-settings overlay as the other two session reads — a recent
    // session is the same session, so it must not report a different mode.
    overlayStoredSettings(readable, runtimeRegistry);
    // The same origin overlays the list endpoint applies, in the same order — a
    // room turn is an engine run under a thread the reader can already see, and
    // the binding table is the only place that knows.
    applySessionOriginOverlays(readable, sessionOriginResolvers(deps));
    return c.json({ sessions: readable, agentActivity, warnings });
  });

  // GET /api/sessions/daily-counts - Sessions started per day across ALL agents
  // (DOR-1039). Same registration rule as `/recent` above: it MUST precede the
  // `/:id` routes, which would otherwise answer `daily-counts` as an `:id`. Backs the
  // Activity tab's week line, which sits above a machine-wide feed and so must
  // count at that same machine-wide SCOPE rather than one project's sessions.
  router.get('/daily-counts', async (c) => {
    const parsed = SessionDailyCountsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    const { days } = parsed.data;

    const meshCore = deps.meshCore;
    const agentPaths = meshCore ? meshCore.listWithPaths().map((a) => a.projectPath) : [];

    const { dailyCounts, warnings } = await countSessionsPerDay({
      runtimes: runtimeRegistry.listRuntimes(),
      agentPaths,
      days,
    });
    return c.json({ days, dailyCounts, warnings });
  });

  // GET /api/sessions/pending-interactions — every prompt anywhere on this
  // machine that is waiting on a person (spec `unified-conversation` §3.3).
  //
  // MUST be registered before the `/:id` routes below, which would otherwise answer
  // `pending-interactions` as an `:id` — the same trap `/recent` and
  // `/daily-counts` document, and the reason this route is not `/:id/…`-shaped.
  //
  // The live stream carries transitions (`interaction_pending` /
  // `interaction_resolved`), which is complete for a window that was open when
  // each fired and empty for one that was not. This is what a window reads on
  // mount so an Ask raised a minute ago shows up as fast as one raised now.
  //
  // AUTHORITY: `sessionGate`, and then `askEntitlement` per row. Reading that
  // something needs a person is still not deciding it, and the header pill must
  // count for a cockpit that has not yet proven itself for a decision — a caller
  // holding one of the person's API keys sees every Ask here and still cannot
  // answer one. What changed (DOR-1356) is that a caller which is not a person AT
  // ALL gets nothing: an agent presenting `X-DorkOS-Agent` could otherwise list
  // every pending shell command in every project on the machine. Deciding runs
  // `requirePersonToAnswer` below, which `asks/ask-entitlement.ts` is bound to by
  // a conformance test.
  //
  // An unentitled caller gets `200` with an empty array, never `403`. That is the
  // rooms domain's own rule — "not a member answers exactly as no such room" — so
  // the response never tells a machine that Asks exist.
  router.get('/pending-interactions', async (c) => {
    const bindings = deps.roomSessionBindings;
    const principal = readCallerPrincipal(honoRequestFacts(c));
    const rows = listPendingInteractionsAcrossSessions();
    // Each row's project (spec `flow-multiproject` §6.2), resolved once per
    // distinct folder; cached by the registry, so a warm server runs no git.
    const projects = await projectsOfFolders(rows.map((row) => row.cwd));
    const interactions = rows.flatMap((row) => {
      const binding = bindings?.bindingForSession(row.sessionId);
      // No `approvers`: nothing on a chat platform reaches this route, so a
      // `bridged` principal is unreachable here. See `AskSubject.approvers`.
      const subject: AskSubject = {
        sessionId: row.sessionId,
        ...(binding ? { roomId: binding.roomId } : {}),
      };
      if (askEntitlement(principal, subject) === 'none') return [];
      return [
        {
          sessionId: row.sessionId,
          cwd: row.cwd,
          interaction: row.interaction,
          ...(binding ? { roomId: binding.roomId, roomAuthorId: binding.authorId } : {}),
          project: projects.get(row.cwd) ?? null,
        },
      ];
    });
    // `warnings` is present in the schema and empty here. It exists because this
    // is the natural home for a future runtime that cannot answer the question,
    // and adding the field later would be a breaking response change.
    return c.json({ interactions });
  });
}
