import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { agentManager } from '../services/core/agent-manager.js';
import { transcriptReader } from '../services/session/transcript-reader.js';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../services/core/stream-adapter.js';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  ListSessionsQuerySchema,
} from '@dorkos/shared/schemas';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(__dirname, '../../../../');

const router = Router();

// POST /api/sessions - Create new session
// Sends an initial message to the SDK to generate the session JSONL file,
// then returns the session metadata.
router.post('/', async (req, res) => {
  const parsed = CreateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { permissionMode = 'default', cwd } = parsed.data;

  // Validate cwd against boundary if provided
  if (cwd) {
    try {
      await validateBoundary(cwd);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  // Use SDK's query() with a no-op prompt to establish the session.
  // The SDK will create the JSONL file and assign a session ID.
  // We need to send a real first message, so we'll just create an in-memory
  // session entry and let the first POST /messages call create the JSONL.
  const sessionId = crypto.randomUUID();
  agentManager.ensureSession(sessionId, { permissionMode, cwd });

  res.json({
    id: sessionId,
    title: `New Session`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    permissionMode,
    cwd,
  });
});

// GET /api/sessions - List all sessions from SDK transcripts
router.get('/', async (req, res) => {
  const parsed = ListSessionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const { limit, cwd } = parsed.data;

  if (cwd) {
    try {
      await validateBoundary(cwd);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  const projectDir = cwd || vaultRoot;
  const sessions = await transcriptReader.listSessions(projectDir);
  res.json(sessions.slice(0, limit));
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req, res) => {
  const cwd = (req.query.cwd as string) || undefined;

  if (cwd) {
    try {
      await validateBoundary(cwd);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  const projectDir = cwd || vaultRoot;
  const session = await transcriptReader.getSession(projectDir, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get('/:id/tasks', async (req, res) => {
  const cwdParam = (req.query.cwd as string) || undefined;

  if (cwdParam) {
    try {
      await validateBoundary(cwdParam);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  const cwd = cwdParam || vaultRoot;

  const etag = await transcriptReader.getTranscriptETag(cwd, req.params.id);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  try {
    const tasks = await transcriptReader.readTasks(cwd, req.params.id);
    res.json({ tasks });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

// GET /api/sessions/:id/messages - Get message history from SDK transcript
router.get('/:id/messages', async (req, res) => {
  const cwdParam = (req.query.cwd as string) || undefined;

  if (cwdParam) {
    try {
      await validateBoundary(cwdParam);
    } catch (err: unknown) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  }

  const cwd = cwdParam || vaultRoot;

  const etag = await transcriptReader.getTranscriptETag(cwd, req.params.id);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  const messages = await transcriptReader.readTranscript(cwd, req.params.id);
  res.json({ messages });
});

// PATCH /api/sessions/:id - Update session settings
router.patch('/:id', async (req, res) => {
  const parsed = UpdateSessionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { permissionMode, model } = parsed.data;
  const updated = agentManager.updateSession(req.params.id, { permissionMode, model });
  if (!updated) return res.status(404).json({ error: 'Session not found' });

  const cwd = (req.query.cwd as string) || vaultRoot;
  const session = await transcriptReader.getSession(cwd, req.params.id);
  if (session) {
    session.permissionMode = permissionMode ?? session.permissionMode;
    session.model = model ?? session.model;
  }
  res.json(session ?? { id: req.params.id, permissionMode, model });
});

// POST /api/sessions/:id/messages - Send message (SSE stream response)
router.post('/:id/messages', async (req, res) => {
  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { content, cwd } = parsed.data;

  const sessionId = req.params.id;

  // Read X-Client-Id header, or generate UUID if missing
  const clientId = (req.headers['x-client-id'] as string) || crypto.randomUUID();

  // Acquire lock before starting SSE stream
  const lockAcquired = agentManager.acquireLock(sessionId, clientId, res);
  if (!lockAcquired) {
    const lockInfo = agentManager.getLockInfo(sessionId);
    return res.status(409).json({
      error: 'Session locked',
      code: 'SESSION_LOCKED',
      lockedBy: lockInfo?.clientId ?? 'unknown',
      lockedAt: lockInfo ? new Date(lockInfo.acquiredAt).toISOString() : new Date().toISOString(),
    });
  }

  // Guarantee lock release if client disconnects before try block
  res.on('close', () => {
    agentManager.releaseLock(sessionId, clientId);
  });

  initSSEStream(res);

  try {
    for await (const event of agentManager.sendMessage(sessionId, content, { cwd })) {
      sendSSEEvent(res, event);

      // If SDK assigned a different session ID, track it
      if (event.type === 'done') {
        const actualSdkId = agentManager.getSdkSessionId(sessionId);
        if (actualSdkId && actualSdkId !== sessionId) {
          // Send a redirect hint so the client can update its session ID
          sendSSEEvent(res, {
            type: 'done',
            data: { sessionId: actualSdkId },
          });
        }
      }
    }
  } catch (err) {
    sendSSEEvent(res, {
      type: 'error',
      data: { message: err instanceof Error ? err.message : 'Unknown error' },
    });
  } finally {
    agentManager.releaseLock(sessionId, clientId);
    endSSEStream(res);
  }
});

// POST /api/sessions/:id/approve - Approve pending tool call
router.post('/:id/approve', async (req, res) => {
  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { toolCallId } = parsed.data;
  const approved = agentManager.approveTool(req.params.id, toolCallId, true);
  if (!approved) return res.status(404).json({ error: 'No pending approval' });
  res.json({ ok: true });
});

// POST /api/sessions/:id/deny - Deny pending tool call
router.post('/:id/deny', async (req, res) => {
  const parsed = ApprovalRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { toolCallId } = parsed.data;
  const denied = agentManager.approveTool(req.params.id, toolCallId, false);
  if (!denied) return res.status(404).json({ error: 'No pending approval' });
  res.json({ ok: true });
});

// POST /api/sessions/:id/submit-answers - Submit answers for AskUserQuestion
router.post('/:id/submit-answers', async (req, res) => {
  const parsed = SubmitAnswersRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { toolCallId, answers } = parsed.data;
  const ok = agentManager.submitAnswers(req.params.id, toolCallId, answers);
  if (!ok) return res.status(404).json({ error: 'No pending question' });
  res.json({ ok: true });
});

// GET /api/sessions/:id/stream - Persistent SSE connection for session sync
router.get('/:id/stream', (req, res) => {
  const sessionId = req.params.id;
  const cwd = (req.query.cwd as string) || vaultRoot;
  const sessionBroadcaster = req.app.locals.sessionBroadcaster;

  initSSEStream(res);

  // Register with broadcaster
  sessionBroadcaster.registerClient(sessionId, cwd, res);

  // The broadcaster handles:
  // - Sending sync_connected event
  // - Auto-deregistering on disconnect (res.on('close'))
  // - Broadcasting sync_update events when JSONL changes
});

export default router;
