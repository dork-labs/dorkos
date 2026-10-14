import { installSessionListRoutes } from './session-list-routes.js';
import {
  captureOriginalHttpRoomSessionPlacement,
  originalHttpRoomSessionPlacementRefusal,
} from '../services/canvas/doc-channel/http-composition.js';
import type { createDocChannelHttpComposition } from '../services/canvas/doc-channel/http-composition.js';
import { originalDocHonoRequest } from '../http/original-doc-request.js';
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
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  UpdateSessionRequestSchema,
  ForkSessionRequestSchema,
  SendMessageRequestSchema,
} from '@dorkos/shared/schemas';
import type { InterruptReceipt, StoredSessionSettingsResponse } from '@dorkos/shared/types';
import type { MeshCore } from '@dorkos/mesh';
import { getChatMessageService } from '../services/session/chat-messages/chat-message-service.js';
import type { ChatActivityResponse } from '@dorkos/shared/chat-messages';
import { stampHistory } from '../services/session/chat-messages/chat-message-stamps.js';
import { historyRead } from '../services/session/chat-messages/history-read.js';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { boundaryRefusal, errorBody, parseSessionId } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logError, logger } from '../lib/logger.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { httpTurnOrigin } from '../services/session/origin/turn-origin.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import type { RoomBindingsPort, SessionOriginResolvers } from '../services/session/index.js';
import {
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
import { sessionExists } from '../services/session/launch/session-exists.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import { createSessionAnswerRoutes } from './session-answers.js';
import { sessionUiActionHandler } from './session-ui-action-handler.js';
import {
  sessionQueueListHandler,
  sessionQueueRemoveHandler,
  sessionQueueUpdateHandler,
} from './session-queue-handler.js';
import { sessionEventsHandler } from './session-events-handler.js';
import { guardSessionParam } from './session-read-guard.js';
import {
  modelGateAuthority,
  rejectUndeclaredPermissionMode,
  rejectUnknownModel,
} from './session-model-gate.js';
import { recordWroteIfPerson, sessionOpenedHandler } from './session-touch-handler.js';
import { sessionCommandIntentHandler } from './session-command-intent-handler.js';
import { sessionDevtoolsActionHandler, sessionDevtoolsIngestHandler } from './session-devtools.js';
import { createSessionCanvasRoutes } from './session-canvas.js';
import { sessionDevtoolsRecordingHandler } from './session-recording.js';
import { sessionAttachmentHandler } from './session-attachments-handler.js';
import { sessionMcpAppResourceHandler } from './session-mcp-app-resource-handler.js';
import { sessionRunsOnCredits } from '../services/core/cloud/credits-model-gate.js';
import { errorRefusalUnlessOwner } from './cloud-owner-bar.js';
import {
  cancelContinueHandler,
  continueOptionsHandler,
  continueSessionHandler,
  limitHistoryHandler,
  waitForResetHandler,
} from './session-continue.js';
import type { RoomSessionPlacePort } from '../services/workspace/room-session-place.js';
import {
  dispatchSessionMessage,
  isSessionLaunchRefusal,
} from '../services/session/launch/launch-session.js';
// A control request that outlived its bound is not a claude-code-only idea, but
// claude-code is the only runtime with one today, so the class still lives with
// its clock. A second runtime growing one is the signal to move it somewhere
// runtime-neutral rather than to import a second class here.
import { ControlRequestTimeoutError } from '../services/runtimes/claude-code/sessions/bounded-control.js';

/**
 * What the session routes read from the running server, handed over once by
 * `index.ts` at boot. The router keeps this object, and a handler reads the field
 * it needs from it on each request; the origin resolvers are copied off
 * `app.locals` when the object is built, so one set there later is not seen.
 *
 * The origin overlays (session-origin-legibility, team-room-home §D2.3) are
 * narrow batched lookups, each its own read rather than a widening of any bag:
 * a session list asks the rooms domain whether an id is a room's turn and
 * Tasks whether it is a scheduled run, without importing either store. One
 * left unset is a safe no-op.
 */
export interface SessionRouteDeps extends SessionOriginResolvers {
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
  /** Original installation owner; interactive placement never comes from a public DTO. */
  docChannel?: ReturnType<typeof createDocChannelHttpComposition>;
}

const vaultRoot = DEFAULT_CWD;

/**
 * Who is posting a message, for a new workspace its `workspaceKey` names
 * (DOR-2335): a person at this machine, or anyone else, with the name an
 * approval card shows.
 *
 * @param facts - The request's facts, with the agent identity.
 */
function workspaceCallerOf(facts: RequestFacts): { trusted: boolean; requestedBy?: string } {
  const identity = facts.agentIdentity;
  return {
    trusted: trustedCaller(readCallerAuthority(facts)) !== undefined,
    ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
  };
}

/** What naming DorkOS credits for a new session says to a caller that is not the owner. */
const RUN_ON_CREDITS = {
  personOnly: 'Only you can run a chat on your DorkOS credits, from the DorkOS app.',
  action: 'run a chat on DorkOS credits',
};

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
 * @returns The routes, for `http/hono-api.ts` to mount at `/api/sessions`.
 */
export function createSessionRoutes(deps: SessionRouteDeps = {}): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  // The read guard, once, in front of every path under `/:id`: the routes below,
  // the answer routes and the canvas group mounted here, and any route added
  // later. Registered first, so it runs first. In Hono `/:id/*` matches `/:id`
  // itself too, so this one line runs it exactly once per request. A static path
  // such as `/recent` reaches it as an id that does not parse, which it passes.
  router.use('/:id/*', guardSessionParam);

  installSessionListRoutes(router, deps);

  // GET /api/sessions/:id/runtime-type — Lightweight endpoint for clients that
  // need only the runtime owner. Uses getSessionRuntimeType, which infers on a
  // miss ('claude-code' for legacy sessions predating the table) and NEVER
  // writes: a read path that back-filled would mint a ghost row for any id it
  // was handed, and first-write-wins would make that guess the binding (DOR-812).
  router.get('/:id/runtime-type', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
    const runtime = await runtimeRegistry.getSessionRuntimeType(sessionId);
    return c.json({ runtime });
  });

  // GET /api/sessions/:id/settings — the settings STORED for a session id, or
  // `null`. The one read on this server that can see a row belonging to a session
  // that has not started (DOR-2103).
  //
  // ## Why `GET /:id` could not answer this
  //
  // Every other session read resolves a session out of its RUNTIME's store
  // (ADR-0310), so a session with a `session_metadata` row and no transcript is a
  // 404 below and absent from the list. That row is the normal product of a
  // settings change made before the first message (DOR-812's pre-launch picker),
  // which means a person's own explicit choice — including one that LOWERS their
  // power for this conversation — was invisible to the screen after a reload, and
  // the trust dial fell back to showing the operator's configured default over
  // it. Answering that with a synthesized `Session` would mean inventing a title
  // and a `createdAt`, and reporting the registry's runtime INFERENCE in a field
  // the client caches as a fact — the costume DOR-1693 took off PATCH's answer.
  // So this answers the row, and the shape says so.
  //
  // Same posture as `/runtime-type` directly above, for the same reasons: no
  // `?cwd=` and no boundary check, because nothing here touches the filesystem —
  // it is one indexed read of a row keyed by session id. And it NEVER writes: a
  // read that back-filled would mint a row for any id it was handed, and
  // `persistSessionRuntime` is first-write-wins, so the guess would become the
  // binding (DOR-812).
  router.get('/:id/settings', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
    // Under the id as asked, deliberately: a session that has not started has no
    // runtime to hold an alias, and `getInternalSessionId` needs a resolved
    // runtime, which for an unbound id would be the inference. A started session
    // is answered by the overlay on the session reads, not by this one.
    const settings = await runtimeRegistry.getSessionSettings(sessionId);
    return c.json({ settings } satisfies StoredSessionSettingsResponse);
  });

  // GET /api/sessions/:id - Get session details
  // Like `/:id/messages`, no `?cwd=` is required for a session the server can
  // already place (DOR-1444): a window that opened the session URL without `&dir=`
  // used to read the default project directory, which finds nothing — and, on a
  // server whose default sits outside the configured boundary, threw rather than
  // answering. Both now resolve through the same ladder.
  router.get('/:id', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const cwdParam = (readQuery(c).cwd as string) || undefined;

    // Translate client-facing session ID to backend-internal session ID
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    const projectDir = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
    if (!projectDir) return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
    // A directory the caller never named is judged here — otherwise omitting
    // `?cwd=` would read a session that naming the same directory is refused for.
    const outside = await boundaryRefusal(projectDir, { allowDorkHome: true });
    if (outside) return c.json(outside, 403);
    const session = await runtime.getSession(projectDir, internalSessionId);
    if (!session) return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
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
    return c.json(session);
  });

  // GET /api/sessions/:id/tasks - Get task state from SDK transcript
  router.get('/:id/tasks', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

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
    if (outside) return c.json(outside, 403);

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
      return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
    }
  });

  // GET /api/sessions/:id/messages - Get message history from SDK transcript.
  // No `?cwd=` is required for a session the server can already place — see
  // resolveSessionCwdOrNull. A session it genuinely cannot place answers 404 rather
  // than an empty list, so "no messages yet" and "wrong/missing cwd" are never
  // the same response (DOR-1322).
  router.get('/:id/messages', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const cwdParam = (readQuery(c).cwd as string) || undefined;

    // Translate client-facing session ID to backend-internal session ID
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

    const cwd = await resolveSessionCwdOrNull(runtime, sessionId, cwdParam);
    if (!cwd) {
      return c.json(
        errorBody(
          "Could not determine this session's working directory. Pass ?cwd= with the session's project directory.",
          'SESSION_CWD_REQUIRED'
        ),
        404
      );
    }
    // A directory the caller never named is judged here — otherwise omitting
    // `?cwd=` would read a session that naming the same directory is refused for.
    // DOR-1322 shipped without this and the gap was live until DOR-1444.
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return c.json(outside, 403);

    const etag = await runtime.getSessionETag(cwd, internalSessionId);
    // Only a whole read answers by ETag: the tag names the whole transcript.
    if (etag && !readQuery(c).since) {
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
    // (DOR-2890): the end-of-turn refresh keeps everything before it.
    const ids = [...new Set([sessionId, internalSessionId])];
    return c.json(
      historyRead(stampHistory(ids, filterKickoffHistory(messages)), readQuery(c).since)
    );
  });

  // PATCH /api/sessions/:id - Update session settings
  router.patch('/:id', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const cwdParam = readQuery(c).cwd;
    const parsed = UpdateSessionRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
    }
    const {
      permissionMode: requestedMode,
      model,
      effort,
      fastMode,
      title,
      runtime: runtimeHint,
      account: accountHint,
    } = parsed.data;
    // Fail-closed by construction: an unresolvable session throws here, before
    // any check below can be skipped and before anything is written.
    //
    // Routing and ownership come out of the SAME read, because they are different
    // questions with different answers: `runtime` is where this write goes, and
    // `bound` is whether anyone has actually said so or the registry inferred it.
    // A gate that conflates the two refuses requests on a guess — see
    // {@link modelGateAuthority}. Nothing here writes ownership: that is the first
    // turn's to establish (ADR-0255), and the `runtime` hint cannot bind.
    const { runtime, bound } = await runtimeRegistry.resolveForSessionWithOwnership(sessionId, {
      allowUnbound: true,
    });
    // The wire carries any well-formed mode id, because a runtime names its own
    // modes (`PermissionModeIdSchema`). The session's runtime is the ONLY thing
    // that can say whether the id it was handed is real, so it is the authority
    // and this is the single place that asks it. Persisting an undeclared id
    // would make the settings overlay display a safety posture the runtime never
    // adopted — a codex session PATCHed to `auto` reads "Auto" everywhere while
    // it keeps running read-only. WRITE PATH ONLY: a session already persisted in
    // a now-undeclared mode still loads and runs.
    if (requestedMode !== undefined) {
      const modeError = rejectUndeclaredPermissionMode(runtime, requestedMode);
      if (modeError) return c.json(errorBody(modeError, 'UNSUPPORTED_PERMISSION_MODE'), 400);
    }
    // Same authority argument as the mode gate directly above, applied to the
    // model: only the runtime can say whether the id it was handed is real, and it
    // is asked HERE so every caller passes the same door.
    //
    // With one difference the mode gate does not need: WHICH runtime is asked.
    // Model ids are namespaced per runtime and overlap nowhere, so asking the
    // wrong one is a guaranteed refusal rather than a rare one — which is exactly
    // what shipped, and what {@link modelGateAuthority} exists to stop. The mode
    // gate above keeps asking `runtime` because every runtime here declares a
    // SUBSET of claude-code's mode ids, so the inference can only ever be too
    // permissive there, and the too-permissive direction is already caught where
    // the runtime finally becomes known (`RuntimeRegistry.claimedPermissionMode`
    // drops a mode the bound runtime does not declare). Narrowing it to the hint
    // would ADD refusals, not remove them, and that is a separate decision.
    //
    // Which MENU is the other half of the question. A session on DorkOS credits
    // may run only what credits serve on its runtime's protocol, so it is judged
    // against the service's list rather than the runtime's own (DOR-2636), and
    // that check does not degrade: nothing is stored while the list is
    // unreadable. Whether the session is on credits is the same answer its launch
    // reaches (`sessionRunsOnCredits`).
    if (model !== undefined) {
      const authority = modelGateAuthority(runtime, bound, runtimeHint);
      const onCredits = authority
        ? await sessionRunsOnCredits(authority, sessionId, {
            accountHint,
            cwd: typeof cwdParam === 'string' ? cwdParam : undefined,
          })
        : false;
      const modelError = authority
        ? await rejectUnknownModel(authority, model, { onCredits, sessionId })
        : null;
      if (modelError) return c.json(errorBody(modelError, 'UNSUPPORTED_MODEL'), 400);
    }
    // Past the gate the id is one THIS runtime declares, so it is a real mode by
    // the only definition that matters — and it travels on as the runtime-declared
    // id it is, all the way into the settings store. No narrowing happens here
    // (DOR-885): each adapter reconciles the id with its own vocabulary at its own
    // edge, which is the only place that can.
    const permissionMode = requestedMode;
    // Translate client-facing session ID to backend-internal session ID (same as GET /:id).
    // After a session remap the client uses the SDK UUID directly; without this translation
    // runtime.updateSession would fail to find the session by client-facing ID.
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    // updateSession no longer throws on a live mode-switch failure (ADR-0261):
    // the chosen mode is persisted and applies on the next turn, so there is no
    // 422 path — a failed live switch is not a request error.
    const updated = await runtime.updateSession(internalSessionId, {
      permissionMode,
      model,
      effort,
      fastMode,
    });
    if (!updated.updated) return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);

    const cwd = (cwdParam as string) || vaultRoot;
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return c.json(outside, 403);

    // Persist custom title to JSONL via SDK's renameSession()
    if (title) {
      await runtime.renameSession(internalSessionId, title, cwd);
    }

    const session = await runtime.getSession(cwd, internalSessionId);
    if (session) {
      session.permissionMode = permissionMode ?? session.permissionMode;
      session.model = model ?? session.model;
      if (effort) session.effort = effort;
      if (fastMode !== undefined) session.fastMode = fastMode;
      if (title) session.title = title;
      if (!session.runtime) session.runtime = runtime.type;
    }
    // The loose fallback is still Session-shaped on the wire, so it must carry
    // the required `runtime` field (task 1.1) — resolved from the owning runtime.
    const loose = session ?? {
      id: sessionId,
      permissionMode,
      model,
      effort,
      runtime: runtime.type,
    };
    // ## Say when the runtime is a guess (DOR-1693)
    //
    // On a session nobody owns, `runtime` is the legacy inference —
    // `claude-code`, so that reads keep working before anything is recorded — and
    // it goes out in the same field, with the same shape, as a real binding. A
    // caller cannot tell them apart, and it can flatly contradict the `runtime`
    // hint that same request just sent. `bound` is already in hand from the
    // resolve above; throwing it away here is what made the answer an inference
    // wearing the costume of a fact.
    //
    // Unowned is not the same as new. `persistSessionRuntime` is called from the
    // interactive POST /messages path and nowhere else, so a scheduled run or a
    // room turn can go many turns with no row at all — this flag says a runtime
    // was guessed, never how much the session has done.
    //
    // A separate optional flag rather than omitting `runtime` or echoing the
    // hint: both of those change what an existing client reads, and one of them
    // would have this route report a binding the first turn has not written yet
    // (ADR-0255). This adds a field and moves nothing.
    const body = bound ? loose : { ...loose, runtimeUnbound: true as const };
    // ## A tightening the running turn never confirmed is not a 200 (DOR-1435)
    //
    // Everything above is true of what DorkOS has STORED. When the runtime could
    // not tell the turn already running about a mode the person just tightened,
    // it is not true of what that turn will do — under a mode that never asks the
    // CLI skips its approval callback entirely, so nothing on this side can put
    // the prompts back for the reply already in flight. Answering `200
    // {permissionMode:'default'}` there states a safety posture the agent has not
    // adopted, which is the one direction this product must never be confidently
    // wrong in.
    //
    // `202`, because the request was accepted and the change IS saved — it simply
    // has not taken yet, which is exactly what 202 says and what a 4xx would deny.
    // The field is what a client acts on; the status is what makes a client that
    // reads neither at least not report certainty. LOOSENING stays a plain 200:
    // an unconfirmed one costs a few extra approval prompts for the rest of one
    // turn and corrects itself on the next.
    if (updated.permissionModePendingUntilNextTurn) {
      return c.json({ ...body, permissionModePendingUntilNextTurn: true }, 202);
    }
    return c.json(body);
  });

  // POST /api/sessions/:id/fork - Fork a session
  router.post('/:id/fork', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const parsed = ForkSessionRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
    }

    const cwd = (readQuery(c).cwd as string) || vaultRoot;
    const outside = await boundaryRefusal(cwd, { allowDorkHome: true });
    if (outside) return c.json(outside, 403);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    try {
      const forked = await runtime.forkSession(cwd, internalSessionId, parsed.data);
      if (!forked) return c.json(errorBody('Session not found or fork failed', 'FORK_FAILED'), 404);
      return c.json(forked, 201);
    } catch {
      return c.json(errorBody('Fork failed', 'FORK_ERROR'), 500);
    }
  });

  // POST /api/sessions/:id/reload-plugins - Reload plugins from disk
  router.post('/:id/reload-plugins', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    if (!runtime.reloadPlugins) {
      return c.json(errorBody('Plugin reload not supported by this runtime', 'NOT_SUPPORTED'), 501);
    }

    try {
      const result = await runtime.reloadPlugins(sessionId);
      if (!result) {
        return c.json(
          errorBody(
            'No active query — send a message first to establish a session',
            'NO_ACTIVE_QUERY'
          ),
          409
        );
      }
      return c.json(result);
    } catch (err) {
      // Told apart from a plain failure because the two are different facts, and
      // the difference is the whole of what the caller can do next (DOR-1301). A
      // reload the agent never confirmed may still have happened — it was written
      // to a process that stopped answering, not refused — so the honest answer is
      // "no confirmation", not "failed".
      if (err instanceof ControlRequestTimeoutError) {
        return c.json(
          errorBody(
            "The agent didn't confirm the plugin reload in time — it may still apply; try again if the new plugin doesn't appear",
            'RELOAD_TIMEOUT'
          ),
          504
        );
      }
      return c.json(errorBody('Plugin reload failed', 'RELOAD_ERROR'), 500);
    }
  });

  // POST /api/sessions/:id/messages — Accept a message (trigger-only, ADR-0264;
  // accept-only, spec `persistent-session-runtime` §3.3).
  //
  // This endpoint NO LONGER streams tokens in-band, and no longer waits for the
  // session to be free. It validates and hands the message to the dispatcher,
  // which either starts the turn now or puts it on the session's durable queue,
  // then answers `202 Accepted` with the canonical session id, the message id, the
  // delivery outcome and the queue position. Everything after that — the turn
  // starting, its tokens, its end — arrives on `GET /:id/events`, the single
  // delivery path.
  //
  // **There is no `409` here.** A busy session used to refuse a second window;
  // now it queues, and the person can edit or remove what is waiting through the
  // queue routes below. The write-lock still exists — it is the mutex one turn
  // window holds, and its inactivity TTL still reclaims a turn that went dark
  // (DOR-782) — but it is no longer an answer this route can give. The lock is
  // bound to the turn's real duration and released on completion AND on error; a
  // detached failure is surfaced INTO the projector so `/events` consumers see it.
  // See `services/session/message-dispatcher.ts` and `trigger-turn.ts` for the
  // orchestration and the lock/error invariants, and
  // `services/session/launch/launch-session.ts` for the binding this route shares
  // with every other surface that starts a session from a message.
  router.post('/:id/messages', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const parsed = SendMessageRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('Invalid request', 'VALIDATION_ERROR'), 400);
    }

    // Naming DorkOS credits for a new session spends the DorkOS account's money,
    // so only the owner of this DorkOS may name it (DOR-2652). Any other
    // account, or none, is the runtime's own business and stays open.
    if (parsed.data.account === CREDITS_ACCOUNT_ID) {
      const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), RUN_ON_CREDITS);
      if (refusal) return c.json(refusal, 403);
    }

    // An id nobody started is a 404, never a new session (DOR-2712): a stale id
    // used to start a stranger session on the default runtime in the default
    // folder. Starting a chat is said out loud with `create: true`.
    if (parsed.data.create !== true && !(await sessionExists(sessionId, parsed.data.cwd))) {
      return c.json(
        errorBody(
          'No session has this id. To start a new one, send create: true.',
          'SESSION_NOT_FOUND'
        ),
        404
      );
    }

    // Read X-Client-Id header, or generate UUID if missing
    const clientId = c.req.header('x-client-id') || crypto.randomUUID();

    // `{ kind: 'interactive' }` is what unlocks the trust stop, and this route is
    // where that claim is true: a message posted to `/api/sessions/:id/messages`
    // came from a person at a control panel holding the session's event stream
    // open. Rooms, tasks and bindings never pass through here, and each names
    // itself at its own call (DOR-2105). A caller presenting an agent identity
    // is not that person: its chat is agent work, so it can read what it
    // started (spec `audit-trail` §3.4), and it seeds no operator stop.
    let result: Awaited<ReturnType<typeof dispatchSessionMessage>>;
    try {
      const owner = deps.docChannel?.fileWrites;
      const raw = owner ? originalDocHonoRequest(c) : undefined;
      const placement =
        owner && raw
          ? await captureOriginalHttpRoomSessionPlacement(owner, raw.req, raw.res, sessionId)
          : undefined;
      result = await (async () => {
        try {
          return await dispatchSessionMessage({
            origin: httpTurnOrigin(presentsAgentIdentity(honoRequestFacts(c))),
            sessionId,
            request: parsed.data,
            clientId,
            meshCore: deps.meshCore,
            roomSessionPlace: placement?.place ?? deps.roomSessionPlace,
            // Who is asking, for a new workspace a workspaceKey names (DOR-2335).
            workspaceCaller: workspaceCallerOf(honoRequestFacts(c)),
          });
        } finally {
          placement?.retire();
        }
      })();
    } catch (cause) {
      const refusal = originalHttpRoomSessionPlacementRefusal(cause);
      if (refusal) return c.json(errorBody(refusal.message, refusal.code), refusal.status);
      throw cause;
    }
    if (isSessionLaunchRefusal(result)) {
      // The account may not work in this project: the plain sentence, with the
      // project and account it is about (spec `flow-multiproject` §8.3).
      if (result.accountError) return c.json(result.accountError.toBody(), 409);
      // A paused agent: the sentence, its code, and which agent, so the app can
      // offer Resume right where the message failed (spec `audit-trail` PR5).
      if (result.refused === 'AGENT_PAUSED') {
        return c.json(
          { error: result.message, code: result.refused, agentId: result.agentId },
          409
        );
      }
      // A request naming something that does not exist is the caller's mistake;
      // a turn refused for WHERE it would stand is a conflict with the session.
      const status =
        result.refused === 'ROOM_SESSION_MOVED' || result.refused === 'DESK_NOT_OWN' ? 409 : 400;
      return c.json(errorBody(result.message, result.refused), status);
    }

    // Accepted, so it counts as you writing here (spec `your-activity-first`
    // D4). A dispatch that answered `accepted: false` refused the message and
    // records nothing. An accepted one names the chat's canonical id; the
    // fallback only covers the type, which leaves the field optional.
    if (result.accepted) recordWroteIfPerson(honoRequestFacts(c), result.canonicalId ?? sessionId);

    return c.json(
      {
        sessionId: result.canonicalId,
        messageId: result.outcome.messageId,
        outcome: result.outcome,
        queuePosition: result.queuePosition,
      },
      202
    );
  });

  // POST /api/sessions/:id/opened — the chat page is showing this chat (spec
  // `your-activity-first` D3). Handler in `session-touch-handler.ts`.
  router.post('/:id/opened', sessionOpenedHandler);

  // GET /api/sessions/:id/chat-messages - What this chat sent other chats, and
  // when another chat stopped it (spec `spin-off-chats` §6): the Sent cards and
  // the "Stopped by" lines. Re-read on every `chat_activity` stream nudge.
  router.get('/:id/chat-messages', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
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

  // GET|PATCH|DELETE /api/sessions/:id/queue — the messages waiting on a session.
  // Handlers live in `session-queue-handler.ts` so this file stays under the size
  // rule. The queue is per SESSION: any window may edit or remove any message on
  // it, whichever window typed it. See the handler's module doc.
  router.get('/:id/queue', sessionQueueListHandler);
  router.patch('/:id/queue/:messageId', sessionQueueUpdateHandler);
  router.delete('/:id/queue/:messageId', sessionQueueRemoveHandler);

  // POST /api/sessions/:id/{approve,deny,batch-approve,batch-deny,submit-answers,
  // submit-elicitation} — answering a prompt (`session-answers.ts`). The answer
  // guard runs first on all six, after the read guard.
  router.route('/', createSessionAnswerRoutes());

  // POST /api/sessions/:id/ui-action — Generative-UI widget interactivity channel
  // (spec gen-ui-tier1 §3). The handler lives in `session-ui-action-handler.ts`
  // so this route file stays under the file-size rule, mirroring `/:id/events`.
  // Semantics: fresh turn via the dispatcher, 202, turn streams over /events. A
  // session still PRODUCING a turn answers 409 SESSION_LOCKED here — unlike
  // /messages, which now queues: a widget action is answered by the turn it was
  // clicked in, so running it against whatever a later turn leaves behind is not
  // the same action. A click after that turn ENDED is accepted, even while the
  // runtime finishes closing the stream (DOR-1239). See the handler's module doc.
  router.post('/:id/ui-action', sessionUiActionHandler);

  // POST /api/sessions/:id/command-intents/:intent — Runtime-fulfilled command
  // intent (currently `compact`), DOR-109. The handler lives in
  // `session-command-intent-handler.ts` to keep this file under the size rule.
  // Semantics: capability-gated (unsupported runtime → honest 422, adapter never
  // called), else drives runtime.executeCommandIntent through the durable
  // projector (trigger-only, 202; delivery over /events, e.g. compact_boundary);
  // busy → 409 SESSION_LOCKED — see the handler's module doc.
  router.post('/:id/command-intents/:intent', sessionCommandIntentHandler);

  // /api/sessions/:id/canvas — this session's own canvas (spec
  // `canvas-agent-seat` §1.6). Six thin handlers over the one writer, in their own
  // file for the same reason the devtools sink is: this one stays under the size
  // rule. A person is the gate; an agent is refused `PEOPLE_ONLY` and reaches its
  // own canvas through `control_ui` and `read_canvas_document` instead.
  router.route('/:id/canvas', createSessionCanvasRoutes());

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
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

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
          return c.json(errorBody('Task not found or already stopped', 'TASK_NOT_RUNNING'), 409);
        }
        return c.json(errorBody('Session not found', 'SESSION_NOT_FOUND'), 404);
      }
      return c.json({ receipt, taskId });
    } catch (_err) {
      return c.json(errorBody('Failed to stop task', 'STOP_TASK_ERROR'), 500);
    }
  });

  // POST /api/sessions/:id/process/switch - Switch now: run a message held for the
  // agent's background work, ending that work (spec `warm-process-lifecycle` D2a,
  // DOR-2065). Takes no body. `switched: false` means there was no running agent
  // to switch, which is a normal answer: the held message is already on its way.
  router.post('/:id/process/switch', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);
    // It ends an agent's running work on a person's say-so: the owner's call,
    // never an agent's (spec `warm-process-lifecycle`, "Switch now is owner-only").
    const refusal = errorRefusalUnlessOwner(honoRequestFacts(c), SWITCH_NOW);
    if (refusal) return c.json(refusal, 403);
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    return c.json({ switched: runtime.switchWhenReady?.(sessionId) === true });
  });

  // POST /api/sessions/:id/interrupt - Interrupt the active query
  router.post('/:id/interrupt', async (c) => {
    const sessionId = parseSessionId(c.req.param('id'));
    if (!sessionId) return c.json(errorBody('Invalid session ID', 'INVALID_SESSION_ID'), 400);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // Stop means stop everything queued (spec `persistent-session-runtime` §3.5,
    // D4). The DorkOS queue is emptied FIRST — synchronously, with no await
    // between it and the interrupt — so the turn ending here cannot let the pump
    // release the head of the queue on its way out. The removed messages ride
    // back on the response: nothing a person typed is destroyed by a Stop, it
    // returns to their composer. That promise holds on EVERY outcome, `failed`
    // included.
    const cancelledQueued = clearQueuedMessages(sessionId);
    try {
      // A receipt, not an `ok` (spec `runtime-interrupt-receipts` D3). The boolean
      // this replaced was wrong on `not-running` in both directions at once —
      // nothing failed, yet `ok` was `false` — and it told the person nothing
      // about the one ending where pressing Stop again is the only move they have.
      const receipt = await runtime.interruptQuery(sessionId);
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
  // — see `services/session/session-stream-delivery.ts`.
  router.get('/:id/events', sessionEventsHandler);

  return router;
}
