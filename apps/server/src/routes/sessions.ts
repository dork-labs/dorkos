import { Router } from 'express';
import { z } from 'zod';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  AUTONOMY_ACK_REQUIRED_CODE,
  hasStandingAutonomyAck,
} from '../services/core/approvals/autonomy-consent.js';
import { reportUsageEvent } from '../services/core/usage-reporter.js';
import {
  UpdateSessionRequestSchema,
  ForkSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitElicitationRequestSchema,
  ListSessionsQuerySchema,
  RecentSessionsQuerySchema,
} from '@dorkos/shared/schemas';
import type { PermissionMode, PermissionModeId } from '@dorkos/shared/types';
import type { AgentRuntime, PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { MeshCore } from '@dorkos/mesh';
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import { isAutonomyStop, needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { readManifest } from '@dorkos/shared/manifest';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logError, logger } from '../lib/logger.js';
import { runInDispatch } from '../lib/dispatch-context.js';
import { logRefusal } from '../services/observability/refusals.js';
import {
  recordDispatchEnd,
  recordDispatchStart,
} from '../services/observability/dispatch-buffers.js';
import {
  aggregateSessionList,
  listRecentSessions,
  getOrCreateProjector,
  persistenceModeFor,
  rekeyProjector,
  triggerTurn,
  applyTaskOriginOverlay,
  applyRoomOriginOverlay,
  overlayStoredSettings,
} from '../services/session/index.js';
import type { ResolveTaskOrigins, ResolveRoomOrigins } from '../services/session/index.js';
import { sessionUiActionHandler } from './session-ui-action-handler.js';
import { sessionEventsHandler } from './session-events-handler.js';
import { sessionCommandIntentHandler } from './session-command-intent-handler.js';
import { sessionDevtoolsIngestHandler } from './session-devtools.js';
import { sessionMcpAppResourceHandler } from './session-mcp-app-resource-handler.js';
import path from 'node:path';
import { sanitizeWorkspaceKey } from '@dorkos/shared/workspace';
import { getWorkspaceManager } from '../services/workspace/index.js';

const vaultRoot = DEFAULT_CWD;

const router = Router();

// GET /api/sessions - List sessions aggregated across all registered runtimes
// (ADR-0310). Responds with the { sessions, warnings? } envelope rather than a
// bare array: aggregation degrades gracefully per runtime, and the in-band
// warnings[] must survive both transports (an HTTP header would be invisible
// to the Direct in-process transport). See SessionListResponseSchema.
router.get('/', async (req, res) => {
  const parsed = ListSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { limit, cwd, runtime: runtimeFilter } = parsed.data;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;
  if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
    return sendError(res, 400, `Unknown runtime: ${runtimeFilter}`, 'UNKNOWN_RUNTIME');
  }

  const projectDir = cwd || vaultRoot;
  const runtimes = runtimeFilter
    ? [runtimeRegistry.get(runtimeFilter)]
    : runtimeRegistry.listRuntimes();
  const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });

  const page = sessions.slice(0, limit);
  // Overlay persisted settings (ADR-0260) through the ONE shared resolver that
  // `GET /:id` also uses, so the two endpoints cannot report different modes
  // for one session (DOR-463).
  overlayStoredSettings(page, runtimeRegistry);
  // Overlay Pulse task origin (session-origin-legibility) — runtime-agnostic,
  // catches direct-branch Pulse runs the transcript-head classifier can't see.
  // Overlay room origin FIRST, so a scheduled task that posts into a room still
  // reads as the task somebody scheduled (see room-origin-overlay's doc).
  const resolveRoomOrigins = req.app.locals.resolveRoomOrigins as ResolveRoomOrigins | undefined;
  applyRoomOriginOverlay(page, resolveRoomOrigins);
  const resolveTaskOrigins = req.app.locals.resolveTaskOrigins as ResolveTaskOrigins | undefined;
  applyTaskOriginOverlay(page, resolveTaskOrigins);
  res.json(warnings.length > 0 ? { sessions: page, warnings } : { sessions: page });
});

// GET /api/sessions/recent - Most-recent sessions across ALL agents (DOR-329).
// MUST be registered before the `/:id` routes below, or Express 5 would capture
// `recent` as an `:id` param. Resolves agent project paths server-side via the
// mesh registry, then fans out via listRecentSessions (bounded concurrency,
// exact-cwd membership per DOR-203, ADR-0310 per-runtime degradation).
router.get('/recent', async (req, res) => {
  const parsed = RecentSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
  }
  const { limit } = parsed.data;

  const meshCore = req.app.locals.meshCore as MeshCore | undefined;
  const agentPaths = meshCore ? meshCore.listWithPaths().map((a) => a.projectPath) : [];
  const runtimes = runtimeRegistry.listRuntimes();

  const { sessions, agentActivity, warnings } = await listRecentSessions({
    runtimes,
    agentPaths,
    limit,
  });
  // Same persisted-settings overlay as the other two session reads — a recent
  // session is the same session, so it must not report a different mode.
  overlayStoredSettings(sessions, runtimeRegistry);
  // Overlay Pulse task origin (session-origin-legibility) — runtime-agnostic,
  // catches direct-branch Pulse runs the transcript-head classifier can't see.
  // Overlay room origin (team-room-home §D2.3) BEFORE the Pulse overlay: a room
  // turn is an engine run under a thread the reader can already see, and this is
  // the only place that knows — the transcript head carries no room marker.
  const resolveRoomOrigins = req.app.locals.resolveRoomOrigins as ResolveRoomOrigins | undefined;
  applyRoomOriginOverlay(sessions, resolveRoomOrigins);
  const resolveTaskOrigins = req.app.locals.resolveTaskOrigins as ResolveTaskOrigins | undefined;
  applyTaskOriginOverlay(sessions, resolveTaskOrigins);
  res.json({ sessions, agentActivity, warnings });
});

// GET /api/sessions/:id/runtime-type — Lightweight endpoint for clients that
// need only the runtime owner. Uses getSessionRuntimeType, which infers on a
// miss ('claude-code' for legacy sessions predating the table) and NEVER
// writes: a read path that back-filled would mint a ghost row for any id it
// was handed, and first-write-wins would make that guess the binding (DOR-812).
router.get('/:id/runtime-type', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
  const runtime = await runtimeRegistry.getSessionRuntimeType(sessionId);
  res.json({ runtime });
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwd = (req.query.cwd as string) || undefined;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

  const projectDir = cwd || vaultRoot;
  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const session = await runtime.getSession(projectDir, internalSessionId);
  if (!session) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  // Adapters tag `runtime` themselves (task 1.1); backstop sloppy ones so
  // the required field always reaches the wire.
  if (!session.runtime) session.runtime = runtime.type;
  // Overlay persisted settings (ADR-0260) so the toolbar reflects the operator's
  // chosen mode/model/etc., not just what the transcript recorded. Same shared
  // resolver (and therefore the same single key) as the list endpoint above —
  // including when this route is reached by a retired id, since the resolver
  // keys off the session it actually resolved, not the id asked for.
  overlayStoredSettings([session], runtimeRegistry);
  const resolveRoomOrigins = req.app.locals.resolveRoomOrigins as ResolveRoomOrigins | undefined;
  applyRoomOriginOverlay([session], resolveRoomOrigins);
  const resolveTaskOrigins = req.app.locals.resolveTaskOrigins as ResolveTaskOrigins | undefined;
  applyTaskOriginOverlay([session], resolveTaskOrigins);
  res.json(session);
});

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get('/:id/tasks', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res, { allowDorkHome: true }))) return;

  const cwd = cwdParam || vaultRoot;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  const etag = await runtime.getSessionETag(cwd, internalSessionId);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  try {
    const tasks = await runtime.getSessionTasks(cwd, internalSessionId);
    res.json({ tasks });
  } catch {
    sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  }
});

// GET /api/sessions/:id/messages - Get message history from SDK transcript
router.get('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res, { allowDorkHome: true }))) return;

  const cwd = cwdParam || vaultRoot;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  const etag = await runtime.getSessionETag(cwd, internalSessionId);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  const messages = await runtime.getMessageHistory(cwd, internalSessionId);
  // The ONE runtime-agnostic suppression seam for the auto-first-turn kickoff
  // (M4): whatever the runtime stored, the synthetic "introduce yourself"
  // record never leaves the server as a user message. Role-scoped (user only),
  // first-user-record-scoped, exact-envelope-shaped — see @dorkos/shared/kickoff.
  res.json({ messages: filterKickoffHistory(messages) });
});

/**
 * Check a requested permission mode against what the runtime declares it can
 * run, returning an operator-readable message when it cannot (or `null` when
 * the mode is fine).
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param permissionMode - The mode the request asks to store.
 */
function rejectUndeclaredPermissionMode(
  runtime: AgentRuntime,
  permissionMode: PermissionModeId
): string | null {
  const declared = runtime.getCapabilities().permissionModes;
  if (!declared.supported || declared.values.length === 0) {
    return `The ${runtime.type} runtime has no permission modes to choose from.`;
  }
  const ids = declared.values.map((descriptor) => descriptor.id);
  if (ids.includes(permissionMode)) return null;
  return `The ${runtime.type} runtime cannot run permission mode '${permissionMode}'. It supports: ${ids.join(', ')}.`;
}

/**
 * The mode as its runtime declared it, or `undefined` for an id this runtime
 * does not offer (which {@link rejectUndeclaredPermissionMode} has already
 * refused by the time the door reads it).
 *
 * @param runtime - The runtime that owns the session being updated.
 * @param permissionMode - The mode the request asks to store.
 */
function declaredMode(
  runtime: AgentRuntime,
  permissionMode: PermissionModeId
): PermissionModeDescriptor | undefined {
  return runtime.getCapabilities().permissionModes.values.find((d) => d.id === permissionMode);
}

/**
 * What a caller refused by the consent door is told, in the words that are true
 * of the mode they asked for.
 *
 * Two sentences rather than one, because one would be false somewhere: the
 * autonomy stop is a position with a name a person recognises from the dial,
 * while a middle stop that never asks is a surprise about behaviour and has to
 * be described as one. Neither names the runtime's own spelling of the mode —
 * the product speaks in the dial's words.
 *
 * @param descriptor - The mode as its runtime declared it.
 */
function consentRequiredMessage(descriptor: PermissionModeDescriptor): string {
  return isAutonomyStop(descriptor)
    ? 'Turning on Full autonomy needs you to confirm what it means first.'
    : 'This mode never stops to ask, so you need to confirm what it means first.';
}

// PATCH /api/sessions/:id - Update session settings
router.patch('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = UpdateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const {
    permissionMode: requestedMode,
    model,
    effort,
    fastMode,
    title,
    acknowledgedAutonomy,
  } = parsed.data;
  // Fail-closed by construction: an unresolvable session throws here, before
  // any check below can be skipped and before anything is written.
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
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
    if (modeError) return sendError(res, 400, modeError, 'UNSUPPORTED_PERMISSION_MODE');
    // ## THE CONSENT DOOR (spec `trust-dial`, decision 5, widened 2026-08-01)
    //
    // A mode that stops asking is the one change a person cannot walk back: by
    // the time they notice they did not mean it, it has already happened. Every
    // mode that still asks is one click and instantly reversible. So the ones
    // that stop asking ask first — and the asking is checked HERE, because a
    // gate that only exists in one client's dialog is not a gate. A second
    // cockpit tab, a script, or a keyboard arrow that selects on focus would
    // each walk straight past it.
    //
    // WHICH modes is {@link needsConsentRitual}'s answer, not this route's, and
    // it is deliberately wider than the Full-autonomy stop. Codex files a mode
    // at the MIDDLE stop that runs shell commands in the workspace and has no
    // way to pause and ask; gating the autonomy position alone let that in with
    // no ritual at all. The rule is semantic — never asks, can do more than read
    // — so a future runtime with the same shape is caught the day it declares
    // itself, without a server release and without its name appearing here.
    //
    // The request satisfies the door with `acknowledgedAutonomy: true`, or with
    // the standing record a person leaves behind by ticking "don't show this
    // again". Both are checked on EVERY gated PATCH: the checkbox trades a
    // repeated ritual for a recorded one, and never weakens the contract. ONE
    // record covers the whole door whatever mode opened it — what a person
    // acknowledged is that a mode will not stop to ask, which is the same fact
    // at either stop, and a second record would mean asking again about
    // something they have already been told.
    //
    // ### What this is not
    //
    // It is a consent ritual for a person, not a boundary against a caller. Any
    // program that can reach this route can send `acknowledgedAutonomy: true`
    // itself, and nothing here can tell it from the cockpit. What it buys is
    // that a person cannot arrive in a mode that never asks without having been
    // told what that means. The boundary for agent callers is separate work
    // (`agent-approval-settings`, DOR-501); do not describe this as covering it.
    //
    // ### Scope: this route is not the only way into a mode that never asks
    //
    // It gates the interactive CHANGE, and nothing else, so read the other ways
    // in as deliberately out of scope rather than as gaps nobody noticed:
    //
    // - **Relay bindings, task execution, room turns.** All create and drive
    //   sessions in-process via `ensureSession` and never reach this route. They
    //   keep their own, stricter gates — the bypass clamp on file-sourced
    //   schedules among them.
    // - **A runtime's own default.** A session is BORN at whatever mode its
    //   runtime declares as default, with no PATCH and therefore no door;
    //   `test-mode` is born at its autonomy stop, which is the entire point of
    //   that runtime. What keeps that honest is the separate invariant that no
    //   production runtime may default to a mode that never asks — asked through
    //   the SAME {@link needsConsentRitual} this door applies, so the two cannot
    //   drift apart and leave a mode that is refused here but shipped as a
    //   birthplace. Enforced per runtime by the conformance suite
    //   (`runtimeConformance`, waivable only with a written reason) and across
    //   the whole set by
    //   `services/runtimes/__tests__/permission-semantics.test.ts`. This door
    //   would be the wrong place for it: there is no request to refuse.
    // - **Obsidian.** `DirectTransport` calls `runtime.updateSession` in-process
    //   and bypasses this route entirely, so the embedded cockpit's dial is
    //   gated by its dialog alone. Pre-existing property of that seam, widened
    //   by nothing here; the checkbox is withheld there for a related reason
    //   (see `AutonomyConfirmDialog`).
    const descriptor = declaredMode(runtime, requestedMode);
    if (descriptor && needsConsentRitual(descriptor) && !acknowledgedAutonomy) {
      if (!hasStandingAutonomyAck()) {
        // 428, not 400. The body is well-formed and the mode is one this runtime
        // genuinely offers — nothing about the request is malformed, so calling
        // it a validation failure would be false. What is missing is a
        // precondition the caller can go and satisfy before retrying the
        // identical request, which is the one thing 428 says and no other 4xx
        // does: 403 would claim they may never do this, and 409 would claim
        // something changed underneath them.
        return sendError(res, 428, consentRequiredMessage(descriptor), AUTONOMY_ACK_REQUIRED_CODE);
      }
    }
  }
  // Past the gate the id is one THIS runtime declares, so it is a real mode by
  // the only definition that matters. `PermissionMode` is the narrower name the
  // rest of the server still uses for the same thing (descriptors have always
  // typed their `id` as a plain `string`), and this is the single seam where
  // the two meet — the assertion is bounded by the check directly above it, and
  // nothing downstream re-derives meaning from the id anyway.
  const permissionMode = requestedMode as PermissionMode | undefined;
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
  if (!updated) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

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
  res.json(session ?? { id: sessionId, permissionMode, model, effort, runtime: runtime.type });
});

// POST /api/sessions/:id/fork - Fork a session
router.post('/:id/fork', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ForkSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res, { allowDorkHome: true }))) return;

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  try {
    const forked = await runtime.forkSession(cwd, internalSessionId, parsed.data);
    if (!forked) return sendError(res, 404, 'Session not found or fork failed', 'FORK_FAILED');
    res.status(201).json(forked);
  } catch {
    sendError(res, 500, 'Fork failed', 'FORK_ERROR');
  }
});

// POST /api/sessions/:id/reload-plugins - Reload plugins from disk
router.post('/:id/reload-plugins', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  if (!runtime.reloadPlugins) {
    return sendError(res, 501, 'Plugin reload not supported by this runtime', 'NOT_SUPPORTED');
  }

  try {
    const result = await runtime.reloadPlugins(sessionId);
    if (!result) {
      return sendError(
        res,
        409,
        'No active query — send a message first to establish a session',
        'NO_ACTIVE_QUERY'
      );
    }
    res.json(result);
  } catch {
    sendError(res, 500, 'Plugin reload failed', 'RELOAD_ERROR');
  }
});

/**
 * Choose the runtime type for a newly-created session.
 *
 * Priority: explicit `body.runtime` hint > agent-manifest `runtime` field
 * (read from `<cwd>/.dork/agent.json`) > server default runtime type.
 *
 * Subsequent `POST /:id/messages` calls for the same `sessionId` do NOT
 * re-run this — `persistSessionRuntime` is first-write-wins, so the row
 * set by the first call is authoritative.
 *
 * The runtime is chosen FIRST because the other two execution defaults hang off
 * it: which model and effort a new session starts with is a per-runtime question
 * (`services/session/resolve-session-defaults.ts`), answered against the runtime
 * this returns, and seeded onto the same first write.
 */
async function resolveRuntimeTypeForNewSession(opts: {
  runtimeHint?: string;
  agentPath?: string;
  cwd?: string;
}): Promise<string> {
  if (opts.runtimeHint) return opts.runtimeHint;

  // Look for an agent manifest in the provided agentPath or cwd. Fall back
  // silently when no manifest exists or the read fails — a missing manifest
  // is not an error on the hot path.
  const manifestDir = opts.agentPath ?? opts.cwd;
  if (manifestDir) {
    try {
      const manifest = await readManifest(manifestDir);
      // The manifest names a runtime PREFERENCE — honor it only when that
      // runtime is registered in this process. Unlike the explicit body hint
      // (which 400s when unknown), an unregistered manifest runtime soft-falls
      // back to the default: the test-mode server (DORKOS_TEST_RUNTIME=true)
      // registers ONLY 'test-mode' while every manifest on disk says
      // 'claude-code' (the AgentRuntime enum has no test-mode member), so
      // without this guard no agent-seeded session can ever start there.
      if (manifest?.runtime) {
        if (runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
        logger.info('[POST /messages] manifest runtime not registered; using default', {
          manifestRuntime: manifest.runtime,
          defaultRuntime: runtimeRegistry.getDefaultType(),
          manifestDir,
        });
      }
    } catch {
      // Fall through to default
    }
  }

  return runtimeRegistry.getDefaultType();
}

// POST /api/sessions/:id/messages — Trigger a turn (trigger-only, ADR-0264).
//
// This endpoint NO LONGER streams tokens in-band. It validates, acquires the
// session write-lock, and STARTS the turn server-side, feeding the runtime's
// `sendMessage` generator into the per-session projector (the single delivery
// path). It then responds `202 Accepted` with the CANONICAL session id and
// returns — the turn runs detached, delivering its tokens solely on
// `GET /:id/events`. The lock is bound to the turn's real duration (not the
// 202) and released on completion AND on error; a detached failure is surfaced
// INTO the projector so `/events` consumers see it. See
// `services/session/trigger-turn.ts` for the orchestration and the lock/error
// invariants.
router.post('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const {
    content,
    cwd,
    context,
    runtime: runtimeHint,
    agentPath,
    workspaceKey,
    workspaceProvider,
    seedContext,
  } = parsed.data;

  // Opt-in workspace binding (DOR-84). When a workspaceKey is supplied, the
  // server provisions-or-reuses the managed workspace from the source repo
  // (`cwd`) and runs the turn with `cwd = workspace.path` + its port block.
  // Additive + resilient: with no key (or a disabled/failing manager) the turn
  // proceeds with the original cwd, byte-for-byte unchanged.
  let effectiveCwd = cwd;
  if (workspaceKey) {
    try {
      const source = cwd ?? DEFAULT_CWD;
      const projectKey = sanitizeWorkspaceKey(path.basename(source));
      const workspace = await getWorkspaceManager().ensure({
        projectKey,
        key: workspaceKey,
        source,
        provider: workspaceProvider,
      });
      effectiveCwd = workspace.path;
      logger.info('[POST /messages] bound to workspace', {
        sessionId,
        workspaceKey,
        path: workspace.path,
      });
    } catch (err) {
      logger.warn('[POST /messages] workspace binding skipped', {
        sessionId,
        workspaceKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // First-message binding: choose + persist the runtime BEFORE resolving.
  // `persistSessionRuntime` binds a session that has none — including one whose
  // row a pre-launch settings change already created — and leaves an
  // already-bound session completely alone, so a later call passing a different
  // (or no) hint changes nothing. The first message wins.
  const runtimeType = await resolveRuntimeTypeForNewSession({ runtimeHint, agentPath, cwd });
  if (!runtimeRegistry.has(runtimeType)) {
    return sendError(res, 400, `Unknown runtime: ${runtimeType}`, 'UNKNOWN_RUNTIME');
  }
  // The registry seeds this session's model, effort and trust stop from the
  // server defaults if this call is what BINDS it — see `resolveSessionDefaults`
  // — filling only what nobody chose, and re-checking a mode chosen before the
  // runtime was known against what this one declares. Nothing is written for a
  // session that is already bound, so a running conversation keeps whatever it
  // is running with.
  //
  // `interactive: true` is what unlocks the trust stop, and this route is where
  // that claim is true: a message posted to `/api/sessions/:id/messages` came
  // from a person at a cockpit holding the session's event stream open. Rooms,
  // tasks and bindings never pass through here.
  const isNewSession = await runtimeRegistry.persistSessionRuntime(
    sessionId,
    runtimeType,
    agentPath,
    { interactive: true }
  );
  // Fire the anonymous `session_created` usage event exactly once, on the write
  // that binds the session (no-op unless usage telemetry is on).
  if (isNewSession)
    reportUsageEvent({ event: 'session_created', properties: { runtime: runtimeType } });

  // Read X-Client-Id header, or generate UUID if missing
  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  const runtime = await runtimeRegistry.resolveForSession(sessionId);

  // One id for this whole dispatch, minted BEFORE the trigger so the line that
  // announces it already carries it and a reader can start there.
  const dispatchId = newDispatchId();
  logger.info('[POST /messages] trigger', { sessionId, contentLength: content.length, dispatchId });
  recordDispatchStart({ dispatchId, origin: 'session', sessionId });

  // The POST body's cwd is operator-chosen and authoritative — overwrite any
  // earlier stamp from a subscribe-path default (an /events connect without
  // ?cwd falls back to the workspace root, which would otherwise pin this
  // session's liveness to the wrong agent first-writer-wins).
  // Persist the completed-turn stream (DOR-189) so it survives a server
  // restart: everything for a log-backed runtime, and for the rest the narrow
  // record its own transcript cannot answer for — including the permission
  // decisions this turn was gated on. Enabling here — before the turn is fed —
  // guarantees the turn_end flush regardless of whether an /events subscribe
  // has already minted (and persistence-enabled) the projector.
  const projector = getOrCreateProjector(sessionId, effectiveCwd, {
    persist: persistenceModeFor(runtime.getCapabilities()),
  });
  if (effectiveCwd !== undefined) projector.cwd = effectiveCwd;

  // Trigger the detached turn. The projector is keyed by the client-facing id
  // (stable across the new-session remap, since the projector registry and
  // `/events` both resolve by it); the canonical id is captured for the body.
  //
  // **The scope wraps `triggerTurn`, and that placement is the whole phase.**
  // `triggerTurn` CONSTRUCTS the detached generator chain and then awaits only
  // the canonical-id race, so entering the dispatch here binds the context to
  // the chain itself — an async generator created inside an ALS scope keeps
  // that scope for its whole life. The turn therefore stays correlated long
  // after this `await` resolves and the 202 has been sent (ADR-0264's `void
  // turn;`). A scope placed around the awaited race INSIDE `triggerTurn` would
  // expire at the 202 and correlate nothing; see
  // `__tests__/sessions-dispatch-correlation.test.ts`, which fails if it moves.
  const result = await runInDispatch({ dispatchId, origin: 'session' }, () =>
    triggerTurn({
      sessionId,
      clientId,
      content,
      cwd: effectiveCwd,
      context,
      // Background this turn's opener attached to it. It rides the neutral
      // context bag, never `content`: the prompt stays the person's message
      // byte for byte, and the seed is stripped from every rendered transcript.
      ...(seedContext ? { seedContext } : {}),
      projector,
      deps: {
        acquireLock: (sid, cid, lifecycle, token) =>
          runtime.acquireLock(sid, cid, lifecycle, token),
        releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
        sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
        rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
        getCapabilities: () => runtime.getCapabilities(),
      },
      onError: (err) => {
        logger.warn('[POST /messages] detached turn error', {
          sessionId,
          ...logError(err),
        });
      },
      // The 202 has long since gone out by the time this fires. It is the only
      // moment the server learns how a detached turn ended, which is exactly
      // what the debug buffer is asked for during an incident.
      onSettled: (outcome) =>
        recordDispatchEnd(dispatchId, outcome === 'failed' ? 'failed' : 'answered'),
    })
  );

  if (!result.accepted) {
    const lockInfo = runtime.getLockInfo(sessionId);
    // A refused trigger still opened a dispatch above, and `onSettled` fires
    // only for a turn that STARTED — so nothing else will ever close this one.
    // Left open, the most common interactive refusal sat at the top of
    // `GET /api/debug/dispatches` reading as a turn still running.
    recordDispatchEnd(dispatchId, 'refused');
    // `shown`, so `info`: the caller gets a 409 naming the holder, which is a
    // refusal the person can see and act on. It is deliberately not a `warn` —
    // the level is reserved for refusals that left no other trace.
    //
    // The id is passed explicitly because this line runs AFTER `runInDispatch`
    // has returned: the scope that would have supplied it ambiently is gone by
    // the time the 409 is written.
    logRefusal('[POST /messages] session locked', {
      reason: 'session_locked',
      visibility: 'shown',
      dispatchId,
      sessionId,
      detail: { lockedBy: lockInfo?.clientId ?? 'unknown' },
    });
    return res.status(409).json({
      error: 'Session locked',
      code: 'SESSION_LOCKED',
      lockedBy: lockInfo?.clientId ?? 'unknown',
      lockedAt: lockInfo ? new Date(lockInfo.acquiredAt).toISOString() : new Date().toISOString(),
    });
  }

  res.status(202).json({ sessionId: result.canonicalId });
});

// POST /api/sessions/:id/approve - Approve pending tool call
router.post('/:id/approve', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, alwaysAllow } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const approved = runtime.approveTool(sessionId, toolCallId, true, { alwaysAllow });
  if (!approved) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/deny - Deny pending tool call
router.post('/:id/deny', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, reason } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  // A blank field is not a reason. Normalising here keeps every runtime and the
  // receipt copy from having to re-decide what an empty string means.
  const denyReason = reason?.trim() ? reason.trim() : undefined;
  const denied = runtime.approveTool(sessionId, toolCallId, false, { denyReason });
  if (!denied) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/batch-approve - Approve multiple pending tool calls
router.post('/:id/batch-approve', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, true),
  }));
  res.json({ results });
});

// POST /api/sessions/:id/batch-deny - Deny multiple pending tool calls
//
// Carries no reason, and the UI offers no field for one: "Deny all" answers a
// stack of unrelated asks at once, so a single sentence would be attached to
// requests it was never about. Each refusal therefore reports honestly that
// nobody explained it, and the transcript receipts say so.
router.post('/:id/batch-deny', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = BatchApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const results = parsed.data.toolCallIds.map((id) => ({
    toolCallId: id,
    ok: runtime.approveTool(sessionId, id, false),
  }));
  res.json({ results });
});

// POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion
router.post('/:id/submit-answers', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitAnswersRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId, answers } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const ok = runtime.submitAnswers(sessionId, toolCallId, answers);
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending question', 'NO_PENDING_QUESTION');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/ui-action — Generative-UI widget interactivity channel
// (spec gen-ui-tier1 §3). The handler lives in `session-ui-action-handler.ts`
// so this route file stays under the file-size rule, mirroring `/:id/events`.
// Semantics: mirrors /messages (fresh turn via triggerTurn, 202, turn streams
// over /events; busy → 409 SESSION_LOCKED) — see the handler's module doc.
router.post('/:id/ui-action', sessionUiActionHandler);

// POST /api/sessions/:id/command-intents/:intent — Runtime-fulfilled command
// intent (currently `compact`), DOR-109. The handler lives in
// `session-command-intent-handler.ts` to keep this file under the size rule.
// Semantics: capability-gated (unsupported runtime → honest 422, adapter never
// called), else drives runtime.executeCommandIntent through the durable
// projector (trigger-only, 202; delivery over /events, e.g. compact_boundary);
// busy → 409 SESSION_LOCKED — see the handler's module doc.
router.post('/:id/command-intents/:intent', sessionCommandIntentHandler);

// POST /api/sessions/:id/devtools/ingest — DevTools bridge capture sink (DOR-213).
// Session-gated (credentialed same-origin client call), Zod-validated, batch-capped.
// The handler lives in `session-devtools.ts` to keep this file under the size rule.
router.post('/:id/devtools/ingest', sessionDevtoolsIngestHandler);

// POST /api/sessions/:id/mcp-app/resource — Read a ui:// MCP App resource
// (SEP-1865) for client rendering. The handler lives in
// `session-mcp-app-resource-handler.ts`; config stays server-side (ADR
// 260708-141143). See the handler's module doc.
router.post('/:id/mcp-app/resource', sessionMcpAppResourceHandler);

// POST /api/sessions/:id/submit-elicitation - Submit response to MCP elicitation
router.post('/:id/submit-elicitation', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitElicitationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { interactionId, action, content } = parsed.data;
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const ok = runtime.submitElicitation(sessionId, interactionId, action, content);
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending elicitation', 'NO_PENDING_ELICITATION');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/tasks/:taskId/stop - Stop a running background task
router.post('/:id/tasks/:taskId/stop', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  // Express 5 typings widen route params to string | string[]; a multi-value
  // taskId can only come from a malformed path, so reject it as invalid.
  const taskId = typeof req.params.taskId === 'string' ? req.params.taskId : undefined;
  if (!taskId) return sendError(res, 400, 'Invalid task ID', 'INVALID_TASK_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  try {
    const stopped = await runtime.stopTask(sessionId, taskId);
    if (!stopped) {
      if (runtime.hasSession(sessionId)) {
        return sendError(res, 409, 'Task not found or already stopped', 'TASK_NOT_RUNNING');
      }
      return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
    }
    res.json({ success: true, taskId });
  } catch (_err) {
    return sendError(res, 500, 'Failed to stop task', 'STOP_TASK_ERROR');
  }
});

// POST /api/sessions/:id/interrupt - Interrupt the active query
router.post('/:id/interrupt', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  try {
    const interrupted = await runtime.interruptQuery(sessionId);
    // Best-effort: ok:false when the query already finished is expected (race
    // between natural completion and the interrupt arriving). Not an error.
    res.json({ ok: interrupted });
  } catch (_err) {
    return sendError(res, 500, 'Failed to interrupt query', 'INTERRUPT_ERROR');
  }
});

// GET /api/sessions/:id/events - Always-on durable SSE stream (snapshot → replay → live).
//
// The single delivery path for session state (spec chat-stream-reconnection,
// Design B.3, ADR-0264/ADR-0266). Always on — NO `enableCrossClientSync` gate,
// no feature flag. Express 5 forwards rejections that escape the handler's own
// pre-flush guard to the error middleware natively: pre-flush they get a JSON
// error response, post-flush Express destroys the socket — the correct SSE
// failure mode (see the `res.headersSent` guard in error-handler.ts).
//
// The SAME path is also served over a WebSocket, by `session-events-socket.ts`
// through the upgrade router, and that is what the cockpit connects to (ADR
// 260805-041016). This SSE route stays because it is the public integration
// contract (`docs/integrations/sse-protocol.mdx`). Both share their sequencing
// — see `services/session/session-stream-delivery.ts`.
router.get('/:id/events', sessionEventsHandler);

export default router;
