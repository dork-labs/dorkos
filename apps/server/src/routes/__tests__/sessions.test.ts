import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';

// Mock boundary before importing app
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

// Mock services before importing app
vi.mock('../../services/session/transcript-reader.js', () => ({
  transcriptReader: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    readTranscript: vi.fn(),
    listTranscripts: vi.fn(),
  },
}));

vi.mock('../../services/core/agent-manager.js', () => ({
  agentManager: {
    ensureSession: vi.fn(),
    sendMessage: vi.fn(),
    approveTool: vi.fn(),
    updateSession: vi.fn(),
    hasSession: vi.fn(),
    checkSessionHealth: vi.fn(),
    getSdkSessionId: vi.fn(),
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
    getLockInfo: vi.fn(),
    isLocked: vi.fn(),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/session/session-broadcaster.js', () => ({
  SessionBroadcaster: vi.fn().mockImplementation(() => ({
    registerClient: vi.fn(),
    deregisterClient: vi.fn(),
    shutdown: vi.fn(),
  })),
}));

// Dynamically import after mocks are set up
import request from 'supertest';
import { createApp } from '../../app.js';
import { transcriptReader } from '../../services/session/transcript-reader.js';
import { agentManager } from '../../services/core/agent-manager.js';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

const app = createApp();

// Mock sessionBroadcaster for tests that need it
const mockSessionBroadcaster = {
  registerClient: vi.fn(),
  deregisterClient: vi.fn(),
  shutdown: vi.fn(),
};
app.locals.sessionBroadcaster = mockSessionBroadcaster;

describe('Sessions Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return empty sessions list
    vi.mocked(transcriptReader.listSessions).mockResolvedValue([]);
    vi.mocked(transcriptReader.getSession).mockResolvedValue(null);
    // Default: allow lock acquisition
    vi.mocked(agentManager.acquireLock).mockReturnValue(true);
    vi.mocked(agentManager.getLockInfo).mockReturnValue(null);
    // Reset sessionBroadcaster mock
    mockSessionBroadcaster.registerClient.mockClear();
  });

  // ---- POST /api/sessions ----

  describe('POST /api/sessions', () => {
    it('creates a session with default permissionMode', async () => {
      const res = await request(app).post('/api/sessions').send({});

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('New Session');
      expect(res.body.permissionMode).toBe('default');
      expect(agentManager.ensureSession).toHaveBeenCalledWith(res.body.id, {
        permissionMode: 'default',
      });
    });

    it('creates a session with bypassPermissions permissionMode', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(200);
      expect(res.body.permissionMode).toBe('bypassPermissions');
      expect(agentManager.ensureSession).toHaveBeenCalledWith(res.body.id, {
        permissionMode: 'bypassPermissions',
      });
    });

    it('returns timestamps on created session', async () => {
      const res = await request(app).post('/api/sessions').send({});

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
          id: 's1',
          title: 'First question',
          createdAt: '2024-01-02',
          updatedAt: '2024-01-02',
          permissionMode: 'default' as const,
        },
        {
          id: 's2',
          title: 'Second question',
          createdAt: '2024-01-01',
          updatedAt: '2024-01-01',
          permissionMode: 'bypassPermissions' as const,
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
        id: 's1',
        title: 'My session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
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
      const res = await request(app).post('/api/sessions/s1/messages').send({});

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
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
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
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      const parsed = parseSSEResponse(res.body);
      const errorEvent = parsed.find((e) => e.type === 'error');
      expect(errorEvent).toBeDefined();
      expect((errorEvent!.data as { message: string }).message).toBe('SDK failure');
    });

    it('acquires and releases lock when streaming', async () => {
      const events: StreamEvent[] = [
        { type: 'text_delta', data: { text: 'Hello' } },
        { type: 'done', data: { sessionId: 's1' } },
      ];

      vi.mocked(agentManager.sendMessage).mockImplementation(async function* () {
        for (const event of events) {
          yield event;
        }
      });
      vi.mocked(agentManager.getSdkSessionId).mockReturnValue('s1');

      await request(app)
        .post('/api/sessions/s1/messages')
        .send({ content: 'hi' })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(agentManager.acquireLock).toHaveBeenCalledWith(
        's1',
        expect.any(String),
        expect.anything()
      );
      expect(agentManager.releaseLock).toHaveBeenCalledWith('s1', expect.any(String));
    });

    it('returns 409 when session is locked by another client', async () => {
      vi.mocked(agentManager.acquireLock).mockReturnValue(false);
      vi.mocked(agentManager.getLockInfo).mockReturnValue({
        clientId: 'other-client',
        acquiredAt: Date.now() - 60000,
      });

      const res = await request(app).post('/api/sessions/s1/messages').send({ content: 'hi' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'Session locked',
        code: 'SESSION_LOCKED',
        lockedBy: 'other-client',
      });
      expect(res.body.lockedAt).toBeDefined();
    });

    it('releases lock even when streaming errors', async () => {
      vi.mocked(agentManager.sendMessage).mockImplementation(async function* () {
        throw new Error('SDK failure');
      });

      await request(app)
        .post('/api/sessions/s1/messages')
        .send({ content: 'hi' })
        .buffer(true)
        .parse((res, callback) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => {
            callback(null, data);
          });
        });

      expect(agentManager.acquireLock).toHaveBeenCalled();
      expect(agentManager.releaseLock).toHaveBeenCalled();
    });
  });

  // ---- POST /api/sessions/:id/approve ----

  describe('POST /api/sessions/:id/approve', () => {
    it('approves pending tool call', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(true);

      const res = await request(app).post('/api/sessions/s1/approve').send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(agentManager.approveTool).toHaveBeenCalledWith('s1', 'tc1', true);
    });

    it('returns 404 when no pending approval', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const res = await request(app).post('/api/sessions/s1/approve').send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- POST /api/sessions/:id/deny ----

  describe('POST /api/sessions/:id/deny', () => {
    it('denies pending tool call', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(true);

      const res = await request(app).post('/api/sessions/s1/deny').send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(agentManager.approveTool).toHaveBeenCalledWith('s1', 'tc1', false);
    });

    it('returns 404 when no pending approval', async () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const res = await request(app).post('/api/sessions/s1/deny').send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- GET /api/sessions/:id/stream ----

  describe('GET /api/sessions/:id/stream', () => {
    it('sets SSE headers correctly', async () => {
      // Mock registerClient to immediately close the response
      mockSessionBroadcaster.registerClient.mockImplementation((_sessionId, _vaultRoot, res) => {
        res.end();
      });

      const res = await request(app).get('/api/sessions/s1/stream');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['connection']).toBe('keep-alive');
      expect(res.headers['x-accel-buffering']).toBe('no');
    });

    it('registers client with sessionBroadcaster', async () => {
      // Mock registerClient to immediately close the response
      mockSessionBroadcaster.registerClient.mockImplementation((_sessionId, _vaultRoot, res) => {
        res.end();
      });

      await request(app).get('/api/sessions/s1/stream');

      expect(mockSessionBroadcaster.registerClient).toHaveBeenCalled();
      expect(mockSessionBroadcaster.registerClient).toHaveBeenCalledWith(
        's1',
        expect.any(String),
        expect.anything()
      );
    });
  });

  // ---- Boundary Enforcement ----

  describe('boundary enforcement', () => {
    it('POST /api/sessions rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).post('/api/sessions').send({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/sessions').query({ cwd: '/etc/passwd' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/sessions/s1').query({ cwd: '/etc' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/messages rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/sessions/s1/messages').query({ cwd: '/tmp/evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/tasks rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get('/api/sessions/s1/tasks').query({ cwd: '/tmp/evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('rejects null byte paths with 403 and NULL_BYTE code', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app)
        .post('/api/sessions')
        .send({ cwd: '/home/user/project\0/../../etc' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });
  });
});
