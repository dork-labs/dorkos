import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '@lifeos/shared/types';

// Mock services before importing app
vi.mock('../../services/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    updateSession: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
  },
}));

vi.mock('../../services/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

// Dynamically import after mocks are set up
import request from 'supertest';
import { createApp } from '../../app.js';
import { transcriptReader } from '../../services/transcript-reader.js';
import { agentManager } from '../../services/agent-manager.js';
import { parseSSEResponse } from '@lifeos/test-utils/sse-helpers';

const app = createApp();

describe('Sessions Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return empty sessions list
    vi.mocked(transcriptReader.listSessions).mockResolvedValue([]);
    vi.mocked(transcriptReader.getSession).mockResolvedValue(null);
  });

  // ---- POST /api/sessions ----

  describe('POST /api/sessions', () => {
    it('creates a session with default permissionMode', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('New Session');
      expect(res.body.permissionMode).toBe('default');
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        res.body.id,
        { permissionMode: 'default' }
      );
    });

    it('creates a session with bypassPermissions permissionMode', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(200);
      expect(res.body.permissionMode).toBe('bypassPermissions');
      expect(agentManager.ensureSession).toHaveBeenCalledWith(
        res.body.id,
        { permissionMode: 'bypassPermissions' }
      );
    });

    it('returns timestamps on created session', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({});

      expect(res.body.createdAt).toBeDefined();
      expect(res.body.updatedAt).toBeDefined();
    });
  });

  // ---- GET /api/sessions ----

  describe('GET /api/sessions', () => {
    it('returns empty list when no sessions', async () => {
      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      expect(transcriptReader.listSessions).toHaveBeenCalled();
    });

    it('returns sessions from transcriptReader', async () => {
      const sessions = [
        {
          id: 's1', title: 'First question', createdAt: '2024-01-02',
          updatedAt: '2024-01-02', permissionMode: 'default' as const,
        },
        {
          id: 's2', title: 'Second question', createdAt: '2024-01-01',
          updatedAt: '2024-01-01', permissionMode: 'bypassPermissions' as const,
        },
      ];
      vi.mocked(transcriptReader.listSessions).mockResolvedValue(sessions);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(sessions);
    });
  });

  // ---- GET /api/sessions/:id ----

  describe('GET /api/sessions/:id', () => {
    it('returns session when found', async () => {
      const session = {
        id: 's1', title: 'My session', createdAt: '2024-01-01',
        updatedAt: '2024-01-01', permissionMode: 'default' as const,
      };
      vi.mocked(transcriptReader.getSession).mockResolvedValue(session);

      const res = await request(app).get('/api/sessions/s1');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(session);
    });

    it('returns 404 for missing session', async () => {
      const res = await request(app).get('/api/sessions/nonexistent');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });
  });

  // ---- POST /api/sessions/:id/messages (SSE) ----

  describe('POST /api/sessions/:id/messages', () => {
    it('returns 400 for missing content', async () => {
      const res = await request(app)
        .post('/api/sessions/s1/messages')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    });

    it('streams events from agentManager via SSE', async () => {
      const events: StreamEvent[] = [
        { type: 'text_delta', data: { text: 'Hello world' } },
        { type: 'done', data: { sessionId: 's1' } },
      ];

      vi.mocked(agentManager.sendMessage).mockImplementation(async function* () {
        for (const event of events) {
          yield event;
        }
      });
      vi.mocked(agentManager.getSdkSessionId).mockReturnValue('s1');

      const res = await request(app)
        .post('/api/sessions/s1/messages')
        .send({ content: 'hi' })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');

      const parsed = parseSSEResponse(res.body);
      expect(parsed).toHaveLength(2);
      expect(parsed[0].type).toBe('text_delta');
      expect(parsed[0].data).toEqual({ text: 'Hello world' });
      expect(parsed[1].type).toBe('done');
    });

    it('sends error event on agentManager failure', async () => {
      vi.mocked(agentManager.sendMessage).mockImplementation(async function* () {
        throw new Error('SDK failure');
      });

      const res = await request(app)
        .post('/api/sessions/s1/messages')
        .send({ content: 'hi' })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => { callback(null, data); });
        });

      const parsed = parseSSEResponse(res.body);
      const errorEvent = parsed.find(e => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as any).message).toBe('SDK failure');
    });
  });

  // ---- POST /api/sessions/:id/approve ----

  describe('POST /api/sessions/:id/approve', () => {
    it('approves pending tool call', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(true);

      const res = await request(app)
        .post('/api/sessions/s1/approve')
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(agentManager.approveTool).toHaveBeenCalledWith('s1', 'tc1', true);
    });

    it('returns 404 when no pending approval', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const res = await request(app)
        .post('/api/sessions/s1/approve')
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- POST /api/sessions/:id/deny ----

  describe('POST /api/sessions/:id/deny', () => {
    it('denies pending tool call', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(true);

      const res = await request(app)
        .post('/api/sessions/s1/deny')
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(agentManager.approveTool).toHaveBeenCalledWith('s1', 'tc1', false);
    });

    it('returns 404 when no pending approval', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const res = await request(app)
        .post('/api/sessions/s1/deny')
        .send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });
});
