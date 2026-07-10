import { Router } from 'express';
import { z } from 'zod';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  UpdateSessionRequestSchema,
  ForkSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  BatchApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitElicitationRequestSchema,
  ListSessionsQuerySchema,
} from '@dorkos/shared/schemas';
import type { Session, SessionSettings } from '@dorkos/shared/types';
import { readManifest } from '@dorkos/shared/manifest';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { asyncHandler } from '../lib/async-handler.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import {
  aggregateSessionList,
  getOrCreateProjector,
  rekeyProjector,
  triggerTurn,
} from '../services/session/index.js';
import { sessionEventsHandler } from './session-events-handler.js';
import { sessionUiActionHandler } from './session-ui-action-handler.js';
import { sessionMcpAppResourceHandler } from './session-mcp-app-resource-handler.js';
import path from 'node:path';
import { sanitizeWorkspaceKey } from '@dorkos/shared/workspace';
import { getWorkspaceManager } from '../services/workspace/index.js';

const vaultRoot = DEFAULT_CWD;

const router = Router();

/**
 * Overlay persisted per-session settings (ADR-0260) onto a transcript-derived
 * session so the store is the single source of truth for display — keeping the
 * session-list badge, the in-session toolbar, and runtime enforcement in sync.
 * Store wins; transcript-derived values remain the fallback for legacy sessions
 * with no stored row.
 *
 * @param target - The session object to mutate in place
 * @param stored - Persisted settings (only defined fields are applied)
 */
function applyStoredSettings(target: Session, stored: SessionSettings): void {
  if (stored.permissionMode !== undefined) target.permissionMode = stored.permissionMode;
  if (stored.model !== undefined) target.model = stored.model;
  if (stored.effort !== undefined) target.effort = stored.effort;
  if (stored.fastMode !== undefined) target.fastMode = stored.fastMode;
}

// GET /api/sessions - List sessions aggregated across all registered runtimes
// (ADR-0310). Responds with the { sessions, warnings? } envelope rather than a
// bare array: aggregation degrades gracefully per runtime, and the in-band
// warnings[] must survive both transports (an HTTP header would be invisible
// to the Direct in-process transport). See SessionListResponseSchema.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const parsed = ListSessionsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
    }
    const { limit, cwd, runtime: runtimeFilter } = parsed.data;
    if (!(await assertBoundary(cwd, res))) return;
    if (runtimeFilter !== undefined && !runtimeRegistry.has(runtimeFilter)) {
      return sendError(res, 400, `Unknown runtime: ${runtimeFilter}`, 'UNKNOWN_RUNTIME');
    }

    const projectDir = cwd || vaultRoot;
    const runtimes = runtimeFilter
      ? [runtimeRegistry.get(runtimeFilter)]
      : runtimeRegistry.listRuntimes();
    const { sessions, warnings } = await aggregateSessionList({ runtimes, projectDir });

    const page = sessions.slice(0, limit);
    // Overlay persisted settings (ADR-0260) in one batch query — no N+1.
    const stored = runtimeRegistry.getSessionSettingsMany(page.map((s) => s.id));
    for (const session of page) {
      const settings = stored.get(session.id);
      if (settings) applyStoredSettings(session, settings);
    }
    res.json(warnings.length > 0 ? { sessions: page, warnings } : { sessions: page });
  })
);

// GET /api/sessions/:id/runtime-type — Lightweight endpoint for clients that
// need only the runtime owner. Uses getSessionRuntimeType which infers-on-miss
// (legacy sessions resolve to 'claude-code' and back-fill session_metadata).
router.get(
  '/:id/runtime-type',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
    const runtime = await runtimeRegistry.getSessionRuntimeType(sessionId);
    res.json({ runtime });
  })
);

// GET /api/sessions/:id - Get session details
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const cwd = (req.query.cwd as string) || undefined;
    if (!(await assertBoundary(cwd, res))) return;

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
    // chosen mode/model/etc., not just what the transcript recorded.
    const stored = await runtimeRegistry.getSessionSettings(internalSessionId);
    if (stored) applyStoredSettings(session, stored);
    res.json(session);
  })
);

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get(
  '/:id/tasks',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const cwdParam = (req.query.cwd as string) || undefined;

    if (!(await assertBoundary(cwdParam, res))) return;

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
  })
);

// GET /api/sessions/:id/messages - Get message history from SDK transcript
router.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const cwdParam = (req.query.cwd as string) || undefined;

    if (!(await assertBoundary(cwdParam, res))) return;

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
    res.json({ messages });
  })
);

// PATCH /api/sessions/:id - Update session settings
router.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const parsed = UpdateSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
    }
    const { permissionMode, model, effort, fastMode, title } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
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
    if (!(await assertBoundary(cwd, res))) return;

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
  })
);

// POST /api/sessions/:id/fork - Fork a session
router.post(
  '/:id/fork',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const parsed = ForkSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
    }

    const cwd = (req.query.cwd as string) || vaultRoot;
    if (!(await assertBoundary(cwd, res))) return;

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
    try {
      const forked = await runtime.forkSession(cwd, internalSessionId, parsed.data);
      if (!forked) return sendError(res, 404, 'Session not found or fork failed', 'FORK_FAILED');
      res.status(201).json(forked);
    } catch {
      sendError(res, 500, 'Fork failed', 'FORK_ERROR');
    }
  })
);

// POST /api/sessions/:id/reload-plugins - Reload plugins from disk
router.post(
  '/:id/reload-plugins',
  asyncHandler(async (req, res) => {
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
  })
);

/**
 * Choose the runtime type for a newly-created session.
 *
 * Priority: explicit `body.runtime` hint > agent-manifest `runtime` field
 * (read from `<cwd>/.dork/agent.json`) > server default runtime type.
 *
 * Subsequent `POST /:id/messages` calls for the same `sessionId` do NOT
 * re-run this — `persistSessionRuntime` is first-write-wins, so the row
 * set by the first call is authoritative.
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
router.post(
  '/:id/messages',
  asyncHandler(async (req, res) => {
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

    // First-message creation: choose + persist the runtime BEFORE resolving.
    // `persistSessionRuntime` is INSERT OR IGNORE, so subsequent calls that pass
    // a different (or no) hint are no-ops — the first-message row wins.
    const runtimeType = await resolveRuntimeTypeForNewSession({ runtimeHint, agentPath, cwd });
    if (!runtimeRegistry.has(runtimeType)) {
      return sendError(res, 400, `Unknown runtime: ${runtimeType}`, 'UNKNOWN_RUNTIME');
    }
    await runtimeRegistry.persistSessionRuntime(sessionId, runtimeType, agentPath);

    // Read X-Client-Id header, or generate UUID if missing
    const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

    const runtime = await runtimeRegistry.resolveForSession(sessionId);

    logger.info('[POST /messages] trigger', { sessionId, contentLength: content.length });

    // The POST body's cwd is operator-chosen and authoritative — overwrite any
    // earlier stamp from a subscribe-path default (an /events connect without
    // ?cwd falls back to the workspace root, which would otherwise pin this
    // session's liveness to the wrong agent first-writer-wins).
    // Persist the completed-turn stream for LOG-BACKED runtimes (DOR-189) so
    // their history survives a server restart; claude-code opts out (its
    // transcript is SDK JSONL). Enabling here — before the turn is fed —
    // guarantees the turn_end flush regardless of whether an /events subscribe
    // has already minted (and persistence-enabled) the projector.
    const projector = getOrCreateProjector(sessionId, effectiveCwd, {
      persist: runtime.getCapabilities().logBackedHistory === true,
    });
    if (effectiveCwd !== undefined) projector.cwd = effectiveCwd;

    // Trigger the detached turn. The projector is keyed by the client-facing id
    // (stable across the new-session remap, since the projector registry and
    // `/events` both resolve by it); the canonical id is captured for the body.
    const result = await triggerTurn({
      sessionId,
      clientId,
      content,
      cwd: effectiveCwd,
      context,
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
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    if (!result.accepted) {
      const lockInfo = runtime.getLockInfo(sessionId);
      logger.warn('[POST /messages] session locked', {
        sessionId,
        lockedBy: lockInfo?.clientId ?? 'unknown',
      });
      return res.status(409).json({
        error: 'Session locked',
        code: 'SESSION_LOCKED',
        lockedBy: lockInfo?.clientId ?? 'unknown',
        lockedAt: lockInfo ? new Date(lockInfo.acquiredAt).toISOString() : new Date().toISOString(),
      });
    }

    res.status(202).json({ sessionId: result.canonicalId });
  })
);

// POST /api/sessions/:id/approve - Approve pending tool call
router.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const parsed = ApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
    }
    const { toolCallId, alwaysAllow } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const approved = runtime.approveTool(sessionId, toolCallId, true, alwaysAllow);
    if (!approved) {
      if (runtime.hasSession(sessionId)) {
        return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
      }
      return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
    }
    res.json({ ok: true });
  })
);

// POST /api/sessions/:id/deny - Deny pending tool call
router.post(
  '/:id/deny',
  asyncHandler(async (req, res) => {
    const sessionId = parseSessionId(req.params.id);
    if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

    const parsed = ApprovalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
    }
    const { toolCallId } = parsed.data;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    const denied = runtime.approveTool(sessionId, toolCallId, false);
    if (!denied) {
      if (runtime.hasSession(sessionId)) {
        return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
      }
      return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
    }
    res.json({ ok: true });
  })
);

// POST /api/sessions/:id/batch-approve - Approve multiple pending tool calls
router.post(
  '/:id/batch-approve',
  asyncHandler(async (req, res) => {
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
  })
);

// POST /api/sessions/:id/batch-deny - Deny multiple pending tool calls
router.post(
  '/:id/batch-deny',
  asyncHandler(async (req, res) => {
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
  })
);

// POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion
router.post(
  '/:id/submit-answers',
  asyncHandler(async (req, res) => {
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
  })
);

// POST /api/sessions/:id/ui-action — Generative-UI widget interactivity channel
// (spec gen-ui-tier1 §3). The handler lives in `session-ui-action-handler.ts`
// so this route file stays under the file-size rule, mirroring `/:id/events`.
// Semantics: mirrors /messages (fresh turn via triggerTurn, 202, turn streams
// over /events; busy → 409 SESSION_LOCKED) — see the handler's module doc.
router.post('/:id/ui-action', asyncHandler(sessionUiActionHandler));

// POST /api/sessions/:id/mcp-app/resource — Read a ui:// MCP App resource
// (SEP-1865) for client rendering. The handler lives in
// `session-mcp-app-resource-handler.ts`; config stays server-side (ADR
// 260708-141143). See the handler's module doc.
router.post('/:id/mcp-app/resource', asyncHandler(sessionMcpAppResourceHandler));

// POST /api/sessions/:id/submit-elicitation - Submit response to MCP elicitation
router.post(
  '/:id/submit-elicitation',
  asyncHandler(async (req, res) => {
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
  })
);

// POST /api/sessions/:id/tasks/:taskId/stop - Stop a running background task
router.post(
  '/:id/tasks/:taskId/stop',
  asyncHandler(async (req, res) => {
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
  })
);

// POST /api/sessions/:id/interrupt - Interrupt the active query
router.post(
  '/:id/interrupt',
  asyncHandler(async (req, res) => {
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
  })
);

// GET /api/sessions/:id/events - Always-on durable SSE stream (snapshot → replay → live).
//
// The single delivery path for session state (spec chat-stream-reconnection,
// Design B.3, ADR-0264/ADR-0266). Always on — NO `enableCrossClientSync` gate,
// no feature flag. The handler (and `parseResumeCursor`) live in
// `session-events-handler.ts` so this route file stays under the file-size rule
// (`.claude/rules/file-size.md`); behavior is identical. The asyncHandler wrap
// catches rejections that escape the handler's own pre-flush guard (e.g. an
// assertBoundary fs error): pre-flush they get a JSON error response,
// post-flush Express destroys the socket — the correct SSE failure mode.
router.get('/:id/events', asyncHandler(sessionEventsHandler));

export default router;
