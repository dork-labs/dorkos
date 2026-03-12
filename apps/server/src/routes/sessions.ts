import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../services/core/stream-adapter.js';
import {
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  ListSessionsQuerySchema,
} from '@dorkos/shared/schemas';
import { assertBoundary, parseSessionId, sendError } from '../lib/route-utils.js';
import { DEFAULT_CWD } from '../lib/resolve-root.js';
import { isRelayEnabled } from '../services/relay/relay-state.js';
import { logger } from '../lib/logger.js';
import type { RelayCore } from '@dorkos/relay';

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
  const { permissionMode, model } = parsed.data;
  const runtime = runtimeRegistry.getDefault();
  const updated = runtime.updateSession(sessionId, { permissionMode, model });
  if (!updated) return sendError(res, 404, 'Session not found', 'SESSION_NOT_FOUND');

  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return;
  const session = await runtime.getSession(cwd, sessionId);
  if (session) {
    session.permissionMode = permissionMode ?? session.permissionMode;
    session.model = model ?? session.model;
  }
  res.json(session ?? { id: sessionId, permissionMode, model });
});

/**
 * Publish a user message to the Relay bus and await full pipeline delivery.
 *
 * Despite the name suggesting a fire-and-forget enqueue, this function is
 * **synchronous end-to-end** — `relayCore.publish()` blocks until the full
 * agent response stream has been processed by the pipeline. The caller
 * receives the receipt only after delivery completes, not at enqueue time.
 * This is intentional: it guarantees ordering, enforces call budgets, and
 * ensures trace completeness before returning.
 *
 * Registers a console endpoint for the client, publishes the message
 * to `relay.agent.{sessionId}`, and returns the publish receipt.
 *
 * @param relayCore - The RelayCore instance
 * @param sessionId - Target session UUID
 * @param clientId - Client identifier (from X-Client-Id header)
 * @param content - User message text
 * @param cwd - Optional working directory
 * @param correlationId - Optional per-message correlation ID for relay event filtering
 */
async function publishViaRelay(
  relayCore: RelayCore,
  sessionId: string,
  clientId: string,
  content: string,
  cwd?: string,
  correlationId?: string,
): Promise<{ messageId: string; traceId: string }> {
  const consoleEndpoint = `relay.human.console.${clientId}`;

  // Register the console endpoint (idempotent — catch duplicate registration)
  try {
    await relayCore.registerEndpoint(consoleEndpoint);
  } catch (err) {
    // Only ignore "already registered" — log real failures
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('already registered')) {
      logger.error('publishViaRelay: failed to register console endpoint:', message);
    }
  }

  const publishResult = await relayCore.publish(
    `relay.agent.${sessionId}`,
    { content, cwd, correlationId },
    {
      from: consoleEndpoint,
      replyTo: consoleEndpoint,
      budget: {
        maxHops: 5,
        ttl: Date.now() + 300_000,
        callBudgetRemaining: 10,
      },
    },
  );

  return {
    messageId: publishResult.messageId,
    traceId: publishResult.messageId,
  };
}

// POST /api/sessions/:id/messages - Send message (SSE stream or Relay 202 receipt)
router.post('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, 'Invalid request', 'VALIDATION_ERROR');
  }
  const { content, cwd, correlationId } = parsed.data;

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

  // Relay path: publish to message bus and return 202 receipt.
  // Note: publishViaRelay() is synchronous end-to-end — the relay pipeline processes
  // the full agent stream before returning. The 202 is sent after delivery completes,
  // not at enqueue time. durationMs in the log reflects the full pipeline round-trip.
  const relayCore = req.app.locals.relayCore as RelayCore | undefined;
  if (isRelayEnabled() && relayCore) {
    logger.info('[POST /messages] relay dispatch', { sessionId, contentLength: content.length });
    const relayStart = Date.now();
    try {
      const receipt = await publishViaRelay(relayCore, sessionId, clientId, content, cwd, correlationId);
      logger.debug('[POST /messages] relay pipeline done', {
        sessionId,
        messageId: receipt.messageId,
        durationMs: Date.now() - relayStart,
      });
      return res.status(202).json(receipt);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Relay publish failed';
      logger.warn('[POST /messages] relay publish failed', { sessionId, error: message });
      return res.status(500).json({ error: message });
    } finally {
      runtime.releaseLock(sessionId, clientId);
    }
  }

  // Legacy path: stream SSE response on the POST connection
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
    for await (const event of runtime.sendMessage(sessionId, content, { cwd })) {
      await sendSSEEvent(res, event);

      // If the backend assigned a different internal session ID, track it
      if (event.type === 'done') {
        const actualInternalId = runtime.getInternalSessionId(sessionId);
        if (actualInternalId && actualInternalId !== sessionId) {
          logger.debug('[POST /messages] session ID remapped', {
            sessionId,
            internalId: actualInternalId,
          });
          // Send a redirect hint so the client can update its session ID
          await sendSSEEvent(res, {
            type: 'done',
            data: { sessionId: actualInternalId },
          });
        }
      }
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
  if (!approved) return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
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
  if (!denied) return sendError(res, 404, 'No pending approval', 'NO_PENDING_APPROVAL');
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
  if (!ok) return sendError(res, 404, 'No pending question', 'NO_PENDING_QUESTION');
  res.json({ ok: true });
});

// GET /api/sessions/:id/stream - Persistent SSE connection for session sync
router.get('/:id/stream', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');
  const cwd = (req.query.cwd as string) || vaultRoot;
  if (!(await assertBoundary(cwd, res))) return;
  const clientId = req.query.clientId as string | undefined;

  initSSEStream(res);

  // Translate agent session ID to backend-internal session ID so the broadcaster
  // watches the correct .jsonl file on disk (filename matches internal ID, not agent ID).
  // Falls back to sessionId if no mapping exists (e.g. CLI-started sessions).
  const runtime = runtimeRegistry.getDefault();
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  // Send initial connection event
  sendSSEEvent(res, { type: 'sync_connected', data: { sessionId } });

  // Watch session via runtime interface — callback writes events to SSE stream
  const unsubscribe = runtime.watchSession(
    internalSessionId,
    cwd,
    (event) => sendSSEEvent(res, event),
    clientId,
  );

  // Signal to client that relay subscription is active and ready to receive.
  // Mirrors registerClient() in SessionBroadcaster. Only sent when relay is
  // configured (app.locals.relayCore) and a clientId is present (relay path).
  if (req.app.locals.relayCore && clientId) {
    res.write(`event: stream_ready\ndata: ${JSON.stringify({ clientId })}\n\n`);
  }

  res.on('close', () => unsubscribe());
});

export default router;
