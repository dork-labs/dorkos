/**
 * The session routes, `/api/sessions` (ADR-0310 for listing, ADR-0264 for the
 * trigger-only message route and the durable stream): the list and its reads,
 * one session's reads and settings, the 202 message trigger and its queue,
 * answering prompts (`session-answers.ts`), the session canvas, continuing on
 * another account, the DevTools sinks, turn images, stopping, and the
 * per-session event stream. The larger handlers live in the `session-*.ts`
 * files beside this one.
 *
 * Every path under `/:id` runs {@link guardSessionParam} first, registered once
 * ahead of every route so a route added later is covered without naming it: an
 * agent gets 404 for a session it may not read, a person's own chat (spec
 * `audit-trail` §3.4).
 *
 * @module routes/sessions
 */
import { Hono } from 'hono';
import type { Db } from '@dorkos/db';
import { mountSessionSettingsPatch } from './session-settings-patch.js';
import { mountSessionSendMessage } from './session-send-message.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { openedChatToolWarnings } from '../services/session/launch/session-tool-warnings.js';
import {
  ForkSessionRequestSchema,
  ListSessionsQuerySchema,
  RecentSessionsQuerySchema,
  SessionDailyCountsQuerySchema,
} from '@dorkos/shared/schemas';
import type { InterruptReceipt, SessionListResponse } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { getChatMessageService } from '../services/session/chat-messages/chat-message-current.js';
import type { ChatActivityResponse } from '@dorkos/shared/chat-messages';
import { stampHistory } from '../services/session/chat-messages/chat-message-stamps.js';
import * as historyWindow from '../services/session/chat-messages/screen/history-window.js';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import { honoRequestFacts } from '../http/request-facts.js';
import { forkPlace } from './session-launcher.js';
import { invalidSessionId, ownerRefusalReply, sessionNotFound } from './session-route-replies.js';
import { recordChatFork } from '../services/work-graph/index.js';
import { recordStopReceipt, recordStopRequest } from '../services/runs/index.js';
import { readQuery } from '../http/request-query.js';
import { boundaryRefusal, parseSessionId } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logError, logger } from '../lib/logger.js';
import { askForPersonBeforeChat } from '../http/person-session-refusal.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { askEntitlement, type AskSubject } from '../services/session/asks/ask-entitlement.js';
import type { RoomBindingsPort, SessionOriginResolvers } from '../services/session/index.js';
import {
  aggregateSessionList,
  listRecentSessions,
  listPendingInteractionsAcrossSessions,
  countSessionsPerDay,
  clearQueuedMessages,
  applySessionOriginOverlays,
  applySessionFleetOverlay,
  sessionFleetOverlayDeps,
  sessionOriginResolvers,
  overlayStoredSettings,
  resolveSessionCwdOrDefault,
  resolveSessionCwdOrNull,
  peekProjector,
} from '../services/session/index.js';
import { accountUsageForSession } from '../services/session/fleet/session-account.js';
import { projectsOfFolders } from '../services/projects/project-registry.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import { createSessionAnswerRoutes } from './session-answers.js';
import { sessionUiActionHandler } from './session-ui-action-handler.js';
import { registerSessionQueueRoutes } from './session-queue-handler.js';
import { sessionEventsHandler } from './session-events-handler.js';
import { guardSessionParam, readableSessions } from './session-read-guard.js';
import { mountWindowSignalRoutes, touchedSinceKeeper } from './session-touch-handler.js';
import { sessionCommandIntentHandler } from './session-command-intent-handler.js';
import { sessionDevtoolsActionHandler, sessionDevtoolsIngestHandler } from './session-devtools.js';
import { createSessionCanvasRoutes, type SessionCanvasDeps } from './session-canvas.js';
import { sessionDevtoolsRecordingHandler } from './session-recording.js';
import { sessionAttachmentHandler } from './session-attachments-handler.js';
import { sessionMcpAppResourceHandler } from './session-mcp-app-resource-handler.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import {
  cancelContinueHandler,
  continueOptionsHandler,
  continueSessionHandler,
  limitHistoryHandler,
  waitForResetHandler,
} from './session-continue.js';
import type { RoomSessionPlacePort } from '../services/workspace/room-session-place.js';
// A control request that outlived its bound is not a claude-code-only idea, but
// claude-code is the only runtime with one today, so the class still lives with
// its clock. A second runtime growing one is the signal to move it somewhere
// runtime-neutral rather than to import a second class here.
import { ControlRequestTimeoutError } from '../services/runtimes/claude-code/sessions/bounded-control.js';

/**
 * What the session routes read from the running server, handed over once by
 * `index.ts` at boot. The router keeps this object and reads the fields it needs
 * for each request.
 *
 * The origin overlays (session-origin-legibility, team-room-home §D2.3) are
 * narrow batched lookups, each its own read rather than a widening of any bag:
 * a session list asks the rooms domain whether an id is a room's turn and
 * Tasks whether it is a scheduled run, without importing either store. One
 * left unset is a safe no-op.
 */
export interface SessionRouteDeps extends SessionOriginResolvers, SessionCanvasDeps {
  /** The database that owns the mounted saved-folder allocation routes. */
  personBirthDb?: Db;
  /**
   * The agent registry: the project paths `/recent` and `/daily-counts` fan
   * out over (DOR-329), and what a message's launch and a handoff read.
   */
  meshCore?: MeshCore;
  /**
   * Which room an Ask came from, for `/pending-interactions`. A port, so this
   * router asks a room question without importing a room type.
   */
  roomSessionBindings?: RoomBindingsPort;
  /** Where a room conversation runs, for a message that starts a turn in one (DOR-1624). */
  roomSessionPlace?: RoomSessionPlacePort;
}

const vaultRoot = DEFAULT_CWD;

/** What Switch now says to a caller that is not the owner. */
const SWITCH_NOW = {
  personOnly: 'Only you can switch now, from the DorkOS app.',
  action: 'switch a chat now',
};

/**
 * Build the session routes.
 *
 * @param deps - See {@link SessionRouteDeps}. A test that builds the server
 *   bare passes none.
 * @param personBirthDb - The database shared with the mounted session location routes.
 * @returns The routes, for `http/hono-api.ts` to mount at `/api/sessions`.
 */
export function createSessionRoutes(deps: SessionRouteDeps = {}, personBirthDb?: Db): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // The read guard, once, in front of every path under `/:id`: the routes below,
  // the answer routes and the canvas group mounted here, and any route added
  // later. Registered first, so it runs first. In Hono `/:id/*` matches `/:id`
  // itself too, so this one line runs it exactly once per request. A static path
  // such as `/recent` reaches it as an id that does not parse, which it passes.
  router.use('/:id/*', guardSessionParam);

  // GET /api/sessions - List sessions aggregated across all registered runtimes
  // (ADR-0310). Responds with the { sessions, warnings?, accountUsage? } envelope rather than a
  // bare array: aggregation degrades gracefully per runtime, and the in-band
  // warnings[] must survive both transports (an HTTP header would be invisible
  // to the Direct in-process transport). See SessionListResponseSchema.
  router.get('/', async (c) => {
    const parsed = ListSessionsQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error);
    }
    const { limit, cwd, runtime: runtimeFilter } = parsed.data;
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return sendProblem(c, outside);
    if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
      return problem(c, 'invalid_request', { detail: `Unknown runtime: ${runtimeFilter}` });
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
      return validationProblem(c, parsed.error);
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
      return validationProblem(c, parsed.error);
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
  // AUTHORITY: the session gate, and then `askEntitlement` per row. Reading that
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

  // GET /api/sessions/:id/runtime-type and GET /api/sessions/:id/settings are
  // capabilities the mount serves (`services/session/reads/session-read-capabilities.ts`,
  // DOR-4978), each with the read guard folded in.

  // GET /api/sessions/:id - Get session details
  // Like `/:id/messages`, no `?cwd=` is required for a session the server can
  // already place (DOR-1444): a window that opened the session URL without `&dir=`
  // used to read the default project directory, which finds nothing — and, on a
  // server whose default sits outside the configured boundary, threw rather than
  // answering. Both now resolve through the same ladder.
  router.get('/:id', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const cwdParam = (readQuery(c).cwd as string) || undefined;

    // Translate client-facing session ID to backend-internal session ID
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    const projectDir = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
    if (!projectDir) return sessionNotFound(c);
    // A directory the caller never named is judged here — otherwise omitting
    // `?cwd=` would read a session that naming the same directory is refused for.
    const outside = await boundaryRefusal(projectDir, { allowDorkHome: true });
    if (outside) return sendProblem(c, outside);
    const session = await runtime.getSession(projectDir, internalSessionId);
    if (!session) return sessionNotFound(c);
    await runtimeRegistry.rememberNativeSession?.(
      session,
      readCallerPrincipal(honoRequestFacts(c))
    );
    // Adapters tag `runtime` themselves (task 1.1); backstop sloppy ones so
    // the required field always reaches the wire.
    //
    // It stays a backstop, and this route does NOT get PATCH's `runtimeUnbound`
    // bit (DOR-1693, decided with it). The runtime asked here is the one that
    // just produced the session, so `runtime` names the store the transcript was
    // actually read out of — a fact about this read, and the route makes no claim
    // about who will own the session after its first turn. PATCH is different
    // because its answer can contradict a `runtime` the same request just sent.
    // And the field would have to live on `SessionSchema` to reach here, which
    // would put a per-read provenance bit on the shape the list endpoint and the
    // client's caches carry around, where it would go stale on binding.
    if (!session.runtime) session.runtime = runtime.type;
    // Overlay persisted settings (ADR-0260) so the toolbar reflects the operator's
    // chosen mode/model/etc., not just what the transcript recorded. Same shared
    // resolver (and therefore the same single key) as the list endpoint above —
    // including when this route is reached by a retired id, since the resolver
    // keys off the session it actually resolved, not the id asked for.
    overlayStoredSettings([session], runtimeRegistry);
    applySessionOriginOverlays([session], sessionOriginResolvers(deps));
    // The same fleet fields the list carries, so a session reads the same either
    // way (spec claude-account-fleet D7). It runs FIRST: the usage block below
    // spreads onto the status it sets, and both merge rather than replace.
    // The accounts' usage is the list envelope's, so it is not returned here.
    await applySessionFleetOverlay([session], sessionFleetOverlayDeps());
    // The account's cached usage, so a single-session read shows it before any
    // turn (spec `claude-account-fleet` §6 U). A live projector's stamp is the
    // one its snapshot carries; otherwise it is read from the store here. This
    // read never creates a projector or a settings row.
    const live = peekProjector(sessionId)?.getStatus();
    const accountUsage =
      live?.accountUsage ??
      (await accountUsageForSession(getAccountUsageStore(), runtime, sessionId, projectDir));
    // A runtime with no usage ledger (test-mode) has nothing to add here.
    if (accountUsage) {
      session.status = {
        ...(session.status ?? { lifecycle: live?.lifecycle ?? 'idle', limit: live?.limit ?? null }),
        accountUsage,
      };
    }
    // A session the fleet overlay could not name (no transcript and no folder it
    // matched) still has an account once its usage resolved one.
    if (session.accountId === undefined && session.status?.accountUsage?.accountId) {
      session.accountId = session.status.accountUsage.accountId;
    }
    return c.json({
      ...session,
      ...(await openedChatToolWarnings(runtime, projectDir, sessionId)),
    });
  });

  // GET /api/sessions/:id/tasks - Get task state from SDK transcript
  router.get('/:id/tasks', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const cwdParam = (readQuery(c).cwd as string) || undefined;

    // Translate client-facing session ID to backend-internal session ID
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

    // Lenient rather than 404-capable: a task read that cannot place the session
    // already answers "no tasks" honestly, and the live binding is what makes the
    // no-`&dir=` window read the right transcript (DOR-1444).
    const cwd = await resolveSessionCwdOrDefault(runtime, sessionId, cwdParam);
    // A directory the caller never named is judged here — otherwise omitting
    // `?cwd=` would read a session that naming the same directory is refused for.
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return sendProblem(c, outside);

    const etag = await runtime.getSessionETag(cwd, internalSessionId);
    if (etag) {
      c.header('ETag', etag);
      if (c.req.header('if-none-match') === etag) {
        return c.body(null, 304);
      }
    }

    try {
      const tasks = await runtime.getSessionTasks(cwd, internalSessionId);
      return c.json({ tasks });
    } catch {
      return sessionNotFound(c);
    }
  });

  // GET /api/sessions/:id/messages - Get message history from SDK transcript.
  // No `?cwd=` is required for a session the server can already place — see
  // resolveSessionCwdOrNull. A session it genuinely cannot place answers 404 rather
  // than an empty list, so "no messages yet" and "wrong/missing cwd" are never
  // the same response (DOR-1322).
  router.get('/:id/messages', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const cwdParam = (readQuery(c).cwd as string) || undefined;

    // Translate client-facing session ID to backend-internal session ID
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

    const cwd = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
    if (!cwd) {
      return sessionNotFound(c, "Couldn't place this chat. Pass ?cwd= with its project folder.");
    }
    // A directory the caller never named is judged here — otherwise omitting
    // `?cwd=` would read a session that naming the same directory is refused for.
    // DOR-1322 shipped without this and the gap was live until DOR-1444.
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return sendProblem(c, outside);

    const etag = await runtime.getSessionETag(cwd, internalSessionId);
    // Only a whole read answers by ETag: the tag names the whole transcript.
    if (etag && !historyWindow.isPartialHistoryQuery(readQuery(c))) {
      c.header('ETag', etag);
      if (c.req.header('if-none-match') === etag) {
        return c.body(null, 304);
      }
    }

    const messages = await runtime.getMessageHistory(cwd, internalSessionId);
    // The ONE runtime-agnostic suppression seam for the auto-first-turn kickoff
    // (M4): whatever the runtime stored, the synthetic "introduce yourself"
    // record never leaves the server as a user message. Role-scoped (user only),
    // first-user-record-scoped, exact-envelope-shaped — see @dorkos/shared/kickoff.
    // A message another chat sent carries its sender, stamped here from the
    // server's own record of the send (spec `spin-off-chats` §2), never read
    // from the text.
    // With `?since=` and that message found, only it and what follows go back
    // (DOR-2890): the end-of-turn refresh keeps everything before it. With
    // `?before=`, the page older than a message; with `?newest=1`, the newest
    // window (DOR-2889).
    const ids = [...new Set([sessionId, internalSessionId])];
    const stamp: historyWindow.StampHistory = (slice) => stampHistory(ids, slice);
    const read = historyWindow.answerHistory(filterKickoffHistory(messages), readQuery(c), stamp);
    return read ? c.json(read) : problem(c, 'not_found', { detail: 'No message has that id.' });
  });

  mountSessionSettingsPatch(router, deps, personBirthDb);

  // POST /api/sessions/:id/fork - Fork a session
  router.post('/:id/fork', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const parsed = ForkSessionRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return validationProblem(c, parsed.error);
    }

    // A fork runs where it is put, so only where its caller may run one (DOR-3644).
    const { cwd, refused } = await forkPlace(c, deps.meshCore, sessionId);
    if (refused) return sendProblem(c, refused);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    try {
      const forked = await runtime.forkSession(cwd, internalSessionId, parsed.data);
      if (!forked) return sessionNotFound(c, 'Nothing was forked.');
      recordChatFork(internalSessionId, forked.id);
      return c.json(forked, 201);
    } catch {
      return problem(c, 'internal_error', { detail: 'The fork failed. Try again.' });
    }
  });

  // POST /api/sessions/:id/reload-plugins - Reload plugins from disk
  router.post('/:id/reload-plugins', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    if (!runtime.reloadPlugins) {
      return problem(c, 'not_supported', { detail: 'This chat’s program can’t reload plugins.' });
    }

    try {
      const result = await runtime.reloadPlugins(sessionId);
      if (!result) {
        return problem(c, 'conflict', { detail: 'Send a message first, then reload plugins.' });
      }
      return c.json(result);
    } catch (err) {
      // Told apart from a plain failure because the two are different facts, and
      // the difference is the whole of what the caller can do next (DOR-1301). A
      // reload the agent never confirmed may still have happened — it was written
      // to a process that stopped answering, not refused — so the honest answer is
      // "no confirmation", not "failed".
      if (err instanceof ControlRequestTimeoutError) {
        return problem(c, 'temporarily_unavailable', {
          detail:
            "The agent didn't confirm the reload. It may still apply, so check before retrying.",
          status: 504,
        });
      }
      return problem(c, 'internal_error', { detail: 'Plugin reload failed.' });
    }
  });

  mountSessionSendMessage(router, deps, personBirthDb);

  // POST /api/sessions/:id/opened — the chat page is showing this chat (spec
  // `your-activity-first` D3) — and POST /api/sessions/:id/stream-health — a
  // window that missed a turn says so, for the server log. Both mounted by
  // `session-touch-handler.ts`.
  mountWindowSignalRoutes(router);

  // GET /api/sessions/:id/chat-messages - What this chat sent other chats, and
  // when another chat stopped it (spec `spin-off-chats` §6): the Sent cards and
  // the "Stopped by" lines. Re-read on every `chat_activity` stream nudge.
  router.get('/:id/chat-messages', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);
    const service = getChatMessageService();
    if (!service) {
      const empty: ChatActivityResponse = { sent: [], stops: [] };
      return c.json(empty);
    }
    // An id no runtime knows has sent nothing and been stopped by nobody.
    const canonical = await runtimeRegistry
      .resolveForSession(sessionId)
      .then((runtime) => runtime.getInternalSessionId(sessionId) ?? sessionId)
      .catch(() => sessionId);
    const body: ChatActivityResponse = await service.activityOf(canonical);
    return c.json(body);
  });

  // GET|PATCH|DELETE|POST /api/sessions/:id/queue — the messages waiting on a session.
  // Handlers live in `session-queue-handler.ts` so this file stays under the size
  // rule. The queue is per SESSION: any window may edit or remove any message on
  // it, whichever window typed it. See the handler's module doc.
  registerSessionQueueRoutes(router, deps.meshCore);

  // POST /api/sessions/:id/{approve,deny,batch-approve,batch-deny,submit-answers,
  // submit-elicitation} — answering a prompt (`session-answers.ts`). The answer
  // guard runs first on all six, after the read guard.
  router.route('/', createSessionAnswerRoutes());

  // POST /api/sessions/:id/ui-action — Generative-UI widget interactivity channel
  // (spec gen-ui-tier1 §3). The handler lives in `session-ui-action-handler.ts`
  // so this route file stays under the file-size rule, mirroring `/:id/events`.
  // Semantics: fresh turn via the dispatcher, 202, turn streams over /events. A
  // session still PRODUCING a turn answers 409 `session_locked` here — unlike
  // /messages, which now queues: a widget action is answered by the turn it was
  // clicked in, so running it against whatever a later turn leaves behind is not
  // the same action. A click after that turn ENDED is accepted, even while the
  // runtime finishes closing the stream (DOR-1239). See the handler's module doc.
  // A click is a chat message too, so it asks for the owner's step-up exactly as `/messages`
  // does (DOR-5071): without it, an unproven click into a Direct chat ran at the stranger's
  // bound with no step-up offered.
  router.post('/:id/ui-action', askForPersonBeforeChat(), sessionUiActionHandler);

  // POST /api/sessions/:id/command-intents/:intent — Runtime-fulfilled command
  // intent (currently `compact`), DOR-109. The handler lives in
  // `session-command-intent-handler.ts` to keep this file under the size rule.
  // Semantics: capability-gated (unsupported runtime → honest 422, adapter never
  // called), else drives runtime.executeCommandIntent through the durable
  // projector (trigger-only, 202; delivery over /events, e.g. compact_boundary);
  // busy → 409 SESSION_LOCKED — see the handler's module doc.
  router.post('/:id/command-intents/:intent', sessionCommandIntentHandler);

  // /api/sessions/:id/canvas — this session's own canvas (spec
  // `canvas-agent-seat` §1.6). Five thin handlers over the one writer, in their own
  // file for the same reason the devtools sink is: this one stays under the size
  // rule. A person is the gate; an agent is refused `PEOPLE_ONLY` and reaches its
  // own canvas through `control_ui` and `read_canvas_document` instead.
  router.route('/:id/canvas', createSessionCanvasRoutes(deps));

  // Out of usage: continue on another account or model, or wait for the reset
  // (spec claude-account-fleet D9). Handlers in `session-continue.ts`.
  router.get('/:id/continue-options', continueOptionsHandler);
  router.post('/:id/continue', continueSessionHandler(deps));
  router.post('/:id/continue/cancel', cancelContinueHandler);
  router.post('/:id/wait', waitForResetHandler);
  // How past limits ended, for the transcript (spec claude-account-ui §7.1).
  router.get('/:id/limit-history', limitHistoryHandler);

  // POST /api/sessions/:id/devtools/ingest — DevTools bridge capture sink (DOR-213).
  // Session-gated (credentialed same-origin client call), Zod-validated, batch-capped.
  // The handler lives in `session-devtools.ts` to keep this file under the size rule.
  router.post('/:id/devtools/ingest', sessionDevtoolsIngestHandler);

  // POST /api/sessions/:id/devtools/action — the result of one driving round trip
  // (spec `canvas-agent-seat` §2.1): what the click did, what the page says now.
  // Same posture as the ingest sink above; the handler lives beside it.
  router.post('/:id/devtools/action', sessionDevtoolsActionHandler);

  // POST /api/sessions/:id/devtools/recording — a finished browser recording, as
  // two file parts: the GIF and its last frame (spec `canvas-agent-seat` §3.4).
  // Multipart rather than JSON because the GIF is megabytes of binary, and the
  // destination is the server's own, never one this request names.
  router.post('/:id/devtools/recording', sessionDevtoolsRecordingHandler);

  /**
   * GET /:id/attachments/:file — an image this session's turn produced.
   *
   * The handler lives in `session-attachments-handler.ts`, same reason as above.
   * `:file` is `<attachmentId>.<ext>`, exactly the URL the attachment store
   * answered — the message part carries that URL verbatim rather than rebuilding
   * it, which is what keeps the store a real seam.
   */
  router.get('/:id/attachments/:file', sessionAttachmentHandler);

  // POST /api/sessions/:id/mcp-app/resource — Read a ui:// MCP App resource
  // (SEP-1865) for client rendering. The handler lives in
  // `session-mcp-app-resource-handler.ts`; config stays server-side (ADR
  // 260708-141143). See the handler's module doc.
  router.post('/:id/mcp-app/resource', sessionMcpAppResourceHandler);

  // POST /api/sessions/:id/tasks/:taskId/stop - Stop a running background task
  router.post('/:id/tasks/:taskId/stop', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    // The route matches only a non-empty segment, so `taskId` is always set.
    const taskId = c.req.param('taskId');

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    try {
      const receipt = await runtime.stopTask(sessionId, taskId);
      // Only `not-running` is an error status, and only that one: it is the
      // ending that says there was no such task. `unconfirmed` and `failed` are
      // 200s carrying the receipt — the request WAS made against a real task and
      // the surface has to be able to say "stop requested" about it, which a 409
      // saying "already stopped" would flatly contradict (spec
      // `runtime-interrupt-receipts` §2).
      if (receipt.outcome === 'not-running') {
        if (runtime.hasSession(sessionId)) {
          return problem(c, 'task_not_running', { detail: 'That task already stopped.' });
        }
        return sessionNotFound(c);
      }
      return c.json({ receipt, taskId });
    } catch (_err) {
      return problem(c, 'internal_error', { detail: 'The task couldn’t be stopped. Try again.' });
    }
  });

  // POST /api/sessions/:id/process/switch - Switch now: run a message held for the
  // agent's background work, ending that work (spec `warm-process-lifecycle` D2a,
  // DOR-2065). Takes no body. `switched: false` means there was no running agent
  // to switch, which is a normal answer: the held message is already on its way.
  router.post('/:id/process/switch', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);
    // It ends an agent's running work on a person's say-so: the owner's call,
    // never an agent's (spec `warm-process-lifecycle`, "Switch now is owner-only").
    const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), SWITCH_NOW);
    if (refusal) return ownerRefusalReply(c, refusal);
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    return c.json({ switched: runtime.switchWhenReady?.(sessionId) === true });
  });

  // POST /api/sessions/:id/interrupt - Interrupt the active query
  router.post('/:id/interrupt', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return invalidSessionId(c);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // Stop means stop everything queued (spec `persistent-session-runtime` §3.5,
    // D4). The DorkOS queue is emptied FIRST — synchronously, with no await
    // between it and the interrupt — so the turn ending here cannot let the pump
    // release the head of the queue on its way out. The removed messages ride
    // back on the response: nothing a person typed is destroyed by a Stop, it
    // returns to their composer. That promise holds on EVERY outcome, `failed`
    // included.
    const cancelledQueued = clearQueuedMessages(sessionId);
    // The request is on the turn's run before the runtime is asked, so a crash
    // between the two still shows somebody asked (spec `turns-survive-restarts` §4.4).
    const stoppedRun = recordStopRequest(sessionId, { via: 'stop' });
    try {
      // A receipt, not an `ok` (spec `runtime-interrupt-receipts` D3). The boolean
      // this replaced was wrong on `not-running` in both directions at once —
      // nothing failed, yet `ok` was `false` — and it told the person nothing
      // about the one ending where pressing Stop again is the only move they have.
      const receipt = await runtime.interruptQuery(sessionId);
      recordStopReceipt(stoppedRun, receipt);
      return c.json({ receipt, cancelledQueued });
    } catch (err) {
      // Adapters are contractually forbidden from throwing for an ordinary refusal
      // (`AgentRuntime.interruptQuery`, conformance I5), so reaching here means
      // something genuinely broke. The queue clear that ran just above is NOT
      // best-effort — those rows are already gone — so failing the request would
      // drop `cancelledQueued` and the person would press Stop, confirm "put N
      // back", and lose the words. Answer the `failed` receipt instead, hand the
      // messages back, and log the failure rather than swallowing it.
      logger.warn('[POST /interrupt] interrupt threw; queue was still cleared', {
        sessionId,
        ...logError(err),
      });
      const receipt: InterruptReceipt = {
        outcome: 'failed',
        reason: 'delivery-failed',
        runtime: runtime.type,
      };
      recordStopReceipt(stoppedRun, receipt);
      return c.json({ receipt, cancelledQueued });
    }
  });

  // GET /api/sessions/:id/events - Always-on durable SSE stream (snapshot → replay → live).
  //
  // The single delivery path for session state (spec chat-stream-reconnection,
  // Design B.3, ADR-0264/ADR-0266). Always on — NO `enableCrossClientSync` gate,
  // no feature flag. A rejection that escapes the handler reaches the chain's
  // error handler (`answerError` in `http/api-chain.ts`): before the head is
  // written it answers JSON, after it closes the connection, which is the
  // correct SSE failure mode (the client reconnects).
  //
  // The SAME path is also served over a WebSocket, by `session-events-socket.ts`
  // through the upgrade router, and that is what the cockpit connects to (ADR
  // 260805-041016). This SSE route stays because it is the public integration
  // contract (`docs/integrations/sse-protocol.mdx`). Both share their sequencing
  // — see `services/core/streams/screen/session-stream-delivery.ts`.
  router.get('/:id/events', sessionEventsHandler);

  return router;
}
