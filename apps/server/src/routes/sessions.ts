import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { agentManager } from '../services/agent-manager.js';
import { transcriptReader } from '../services/transcript-reader.js';
import { initSSEStream, sendSSEEvent, endSSEStream } from '../services/stream-adapter.js';
import {
  CreateSessionRequestSchema,
  UpdateSessionRequestSchema,
  SendMessageRequestSchema,
  ApprovalRequestSchema,
  SubmitAnswersRequestSchema,
  ListSessionsQuerySchema,
} from '@lifeos/shared/schemas';

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
  const projectDir = cwd || vaultRoot;
  const sessions = await transcriptReader.listSessions(projectDir);
  res.json(sessions.slice(0, limit));
});

// GET /api/sessions/:id - Get session details
router.get('/:id', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;
  const session = await transcriptReader.getSession(cwd, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// GET /api/sessions/:id/tasks - Get task state from SDK transcript
router.get('/:id/tasks', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;
  try {
    const tasks = await transcriptReader.readTasks(cwd, req.params.id);
    res.json({ tasks });
  } catch {
    res.status(404).json({ error: 'Session not found' });
  }
});

// GET /api/sessions/:id/messages - Get message history from SDK transcript
router.get('/:id/messages', async (req, res) => {
  const cwd = (req.query.cwd as string) || vaultRoot;
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
  }
  res.json(session ?? { id: req.params.id, permissionMode, model });
});

// POST /api/sessions/:id/messages - Send message (SSE stream response)
router.post('/:id/messages', async (req, res) => {
  const parsed = SendMessageRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.format() });
  }
  const { content } = parsed.data;

  const sessionId = req.params.id;

  initSSEStream(res);

  try {
    for await (const event of agentManager.sendMessage(sessionId, content)) {
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

export default router;
