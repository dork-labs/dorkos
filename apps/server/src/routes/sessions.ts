import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../services/core/stream-adapter.js';
import {
  UpdateSessionRequestSchema,
  ForkSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  SubmitElicitationRequestSchema,
  ListSessionsQuerySchema,
} from '@dorkos/shared/schemas';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { logger } from '../lib/logger.js';
import { SSE } from '../config/constants.js';

const vaultRoot = DEFAULT_CWD;

const router = Router();

// GET /api/sessions - List all sessions from SDK transcripts
router.get('/', async (req, res) => {
  const parsed = ListSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const { limit, cwd } = parsed.data;
  if (!(await assertBoundary(cwd, res))) return;

  const projectDir = cwd || vaultRoot;
  const runtime = runtimeRegistry.getDefault();
  const sessions = await runtime.listSessions(projectDir);
  res.json(sessions.slice(0, limit));
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwd = (req.query.cwd as string) || undefined;
  if (!(await assertBoundary(cwd, res))) return;

  const projectDir = cwd || vaultRoot;
  // Translate client-facing session ID to backend-internal session ID
  const runtime = runtimeRegistry.getDefault();
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const session = await runtime.getSession(projectDir, internalSessionId);
  if (!session) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');
  res.json(session);
});

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get('/:id/tasks', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res))) return;

  const cwd = cwdParam || vaultRoot;

  // Translate client-facing session ID to backend-internal session ID
  const runtime = runtimeRegistry.getDefault();
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
router.get('/:id/messages', async (req, res, next) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;

  if (!(await assertBoundary(cwdParam, res))) return;

  const cwd = cwdParam || vaultRoot;

  try {
    // Translate client-facing session ID to backend-internal session ID
    const runtime = runtimeRegistry.getDefault();
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
  } catch (err) {
    next(err);
  }
});

// PATCH /api/sessions/:id - Update session settings
router.patch('/:id', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = UpdateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { permissionMode, model, effort, title } = parsed.data;
  const runtime = runtimeRegistry.getDefault();
  // Translate client-facing session ID to backend-internal session ID (same as GET /:id).
  // After a session remap the client uses the SDK UUID directly; without this translation
  // runtime.updateSession would fail to find the session by client-facing ID.
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const updated = runtime.updateSession(internalSessionId, { permissionMode, model, effort });
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
    if (title) session.title = title;
  }
  res.json(session ?? { id: sessionId, permissionMode, model, effort });
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
  if (!(await assertBoundary(cwd, res))) return;

  const runtime = runtimeRegistry.getDefault();
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

  const runtime = runtimeRegistry.getDefault();
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

// POST /api/sessions/:id/messages - Send message (SSE stream)
router.post('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { content, cwd, uiState } = parsed.data;

  // Read X-Client-Id header, or generate UUID if missing
  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  const runtime = runtimeRegistry.getDefault();

  // Acquire lock before processing
  const lockAcquired = runtime.acquireLock(sessionId, clientId, res);
  if (!lockAcquired) {
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

  // Stream SSE response on the POST connection
  // Idempotent lock release — ensures exactly one release regardless of close/finally ordering
  let lockReleased = false;
  const releaseLockOnce = () => {
    if (lockReleased) return;
    lockReleased = true;
    runtime.releaseLock(sessionId, clientId);
  };

  // Guarantee lock release if client disconnects before try block
  res.on('close', releaseLockOnce);

  logger.info('[POST /messages] SSE path', { sessionId, contentLength: content.length });

  initSSEStream(res);

  try {
    for await (const event of runtime.sendMessage(sessionId, content, { cwd, uiState })) {
      // Intercept the done event to enrich it with server-assigned message IDs
      // and session ID remap info, rather than sending a second done event.
      if (event.type === 'done') {
        const actualInternalId = runtime.getInternalSessionId(sessionId);
        const lookupId = actualInternalId ?? sessionId;
        const lastMsgIds = await runtime.getLastMessageIds(lookupId);

        const donePayload: Record<string, unknown> = {
          ...(event.data && typeof event.data === 'object' ? event.data : {}),
        };

        if (actualInternalId && actualInternalId !== sessionId) {
          logger.debug('[POST /messages] session ID remapped', {
            sessionId,
            internalId: actualInternalId,
          });
          donePayload.sessionId = actualInternalId;
        }

        if (lastMsgIds) {
          donePayload.messageIds = lastMsgIds;
        }

        await sendSSEEvent(res, { type: 'done', data: donePayload });
        continue;
      }

      await sendSSEEvent(res, event);
    }
  } catch (err) {
    logger.warn('[POST /messages] SSE stream error', {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await sendSSEEvent(res, {
      type: 'error',
      data: { message: err instanceof Error ? err.message : 'Unknown error' },
    });
  } finally {
    releaseLockOnce();
    endSSEStream(res);
  }
});

// POST /api/sessions/:id/approve - Approve pending tool call
router.post('/:id/approve', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { toolCallId } = parsed.data;
  const runtime = runtimeRegistry.getDefault();
  const approved = runtime.approveTool(sessionId, toolCallId, true);
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
  const { toolCallId } = parsed.data;
  const runtime = runtimeRegistry.getDefault();
  const denied = runtime.approveTool(sessionId, toolCallId, false);
  if (!denied) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
  }
  res.json({ ok: true });
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
  const runtime = runtimeRegistry.getDefault();
  const ok = runtime.submitAnswers(sessionId, toolCallId, answers);
  if (!ok) {
    if (runtime.hasSession(sessionId)) {
      return sendError(res, 409, 'Interaction already resolved', 'INTERACTION_ALREADY_RESOLVED');
    }
    return sendError(res, 404, 'No pending question', 'NO_PENDING_QUESTION');
  }
  res.json({ ok: true });
});

// POST /api/sessions/:id/submit-elicitation - Submit response to MCP elicitation
router.post('/:id/submit-elicitation', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SubmitElicitationRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { interactionId, action, content } = parsed.data;
  const runtime = runtimeRegistry.getDefault();
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

  const { taskId } = req.params;
  if (!taskId) return sendError(res, 400, 'Invalid task ID', 'INVALID_TASK_ID');

  const runtime = runtimeRegistry.getDefault();
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

// GET /api/sessions/:id/stream - Persistent SSE connection for session sync
router.get('/:id/stream', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return;
  const clientId = req.query.clientId as string | undefined;

  initSSEStream(res);

  // Send retry hint so EventSource uses a reasonable reconnection delay
  res.write('retry: 3000\n\n');

  // Translate agent session ID to backend-internal session ID so the broadcaster
  // watches the correct .jsonl file on disk (filename matches internal ID, not agent ID).
  // Falls back to sessionId if no mapping exists (e.g. CLI-started sessions).
  const runtime = runtimeRegistry.getDefault();
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  // Send initial connection event
  sendSSEEvent(res, { type: 'sync_connected', data: { sessionId } });

  // Periodic heartbeat — named event so the client watchdog can detect it
  const heartbeatInterval = setInterval(() => {
    try {
      res.write('event: heartbeat\ndata: {}\n\n');
    } catch {
      clearInterval(heartbeatInterval);
    }
  }, SSE.HEARTBEAT_INTERVAL_MS);

  // Watch session — add event IDs for future Last-Event-ID support
  const unsubscribe = runtime.watchSession(
    internalSessionId,
    cwd,
    (event) => {
      const eventId = `${sessionId}-${Date.now()}`;
      const payload = `id: ${eventId}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
      try {
        res.write(payload);
      } catch {
        // Connection may be closed
      }
    },
    clientId
  );

  res.on('close', () => {
    clearInterval(heartbeatInterval);
    unsubscribe();
  });
});

export default router;
