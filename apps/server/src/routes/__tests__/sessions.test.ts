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

// Mock runtime that satisfies the AgentRuntime interface methods used by sessions.ts
const mockRuntime = {
  type: 'claude-code',
  ensureSession: vi.fn(),
  hasSession: vi.fn(() => false),
  updateSession: vi.fn(() => true),
  sendMessage: vi.fn(),
  approveTool: vi.fn(),
  submitAnswers: vi.fn(() => true),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getMessageHistory: vi.fn(),
  getSessionTasks: vi.fn().mockResolvedValue([]),
  getSessionETag: vi.fn().mockResolvedValue(null),
  readFromOffset: vi.fn().mockResolvedValue({ content: '', newOffset: 0 }),
  watchSession: vi.fn(() => () => {}),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  isLocked: vi.fn(() => false),
  getLockInfo: vi.fn(),
  getSupportedModels: vi.fn().mockResolvedValue([]),
  getCapabilities: vi.fn(() => ({
    type: 'claude-code',
    supportsPermissionModes: true,
    supportsToolApproval: true,
    supportsCostTracking: true,
    supportsResume: true,
    supportsMcp: true,
    supportsQuestionPrompt: true,
  })),
  getInternalSessionId: vi.fn(),
  getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: '' }),
  checkSessionHealth: vi.fn(),
};

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => mockRuntime),
    get: vi.fn(() => mockRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'claude-code'),
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));


// Dynamically import after mocks are set up
import request from 'supertest';
import { createApp, finalizeApp } from '../../app.js';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';
import { validateBoundary, BoundaryError } from '../../lib/boundary.js';

const app = createApp();
finalizeApp(app);

/** Valid UUID for session ID params (routes validate UUID format). */
const S1 = '00000000-0000-4000-8000-000000000001';

// Legacy mockSessionBroadcaster removed — route now uses runtime.watchSession()

describe('Sessions Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: return empty sessions list
    mockRuntime.listSessions.mockResolvedValue([]);
    mockRuntime.getSession.mockResolvedValue(null);
    mockRuntime.getSessionETag.mockResolvedValue(null);
    mockRuntime.getSessionTasks.mockResolvedValue([]);
    // Default: allow lock acquisition
    mockRuntime.acquireLock.mockReturnValue(true);
    mockRuntime.getLockInfo.mockReturnValue(null);
    mockRuntime.getInternalSessionId.mockReturnValue(undefined);
  });

  // ---- POST /api/sessions ----

  describe('POST /api/sessions', () => {
    it('creates a session with default permissionMode', async () => {
      const res = await request(app).post('/api/sessions').send({});

      expect(res.status).toBe(200);
      expect(res.body.id).toBeDefined();
      expect(res.body.title).toBe('New Session');
      expect(res.body.permissionMode).toBe('default');
      expect(mockRuntime.ensureSession).toHaveBeenCalledWith(res.body.id, {
        permissionMode: 'default',
      });
    });

    it('creates a session with bypassPermissions permissionMode', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ permissionMode: 'bypassPermissions' });

      expect(res.status).toBe(200);
      expect(res.body.permissionMode).toBe('bypassPermissions');
      expect(mockRuntime.ensureSession).toHaveBeenCalledWith(res.body.id, {
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
      expect(mockRuntime.listSessions).toHaveBeenCalled();
    });

    it('returns sessions from runtime', async () => {
      const sessions = [
        {
          id: S1,
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
      mockRuntime.listSessions.mockResolvedValue(sessions);

      const res = await request(app).get('/api/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(sessions);
    });
  });

  // ---- GET /api/sessions/:id ----

  describe('GET /api/sessions/:id', () => {
    it('returns session when found', async () => {
      const session = {
        id: S1,
        title: 'My session',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
        permissionMode: 'default' as const,
      };
      mockRuntime.getSession.mockResolvedValue(session);

      const res = await request(app).get(`/api/sessions/${S1}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(session);
    });

    it('returns 400 for invalid (non-UUID) session ID', async () => {
      const res = await request(app).get('/api/sessions/nonexistent');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SESSION_ID');
    });

    it('returns 404 for missing session', async () => {
      const missingId = '00000000-0000-4000-8000-ffffffffffff';
      const res = await request(app).get(`/api/sessions/${missingId}`);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Session not found');
    });
  });

  // ---- POST /api/sessions/:id/messages (SSE) ----

  describe('POST /api/sessions/:id/messages', () => {
    it('returns 400 for missing content', async () => {
      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid request');
    });

    it('streams events from runtime via SSE', async () => {
      const events: StreamEvent[] = [
        { type: 'text_delta', data: { text: 'Hello world' } },
        { type: 'done', data: { sessionId: S1 } },
      ];

      mockRuntime.sendMessage.mockImplementation(async function* () {
        for (const event of events) {
          yield event;
        }
      });
      mockRuntime.getInternalSessionId.mockReturnValue(S1);

      const res = await request(app)
        .post(`/api/sessions/${S1}/messages`)
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

    it('sends error event on runtime failure', async () => {
      mockRuntime.sendMessage.mockImplementation(async function* () {
        throw new Error('SDK failure');
      });

      const res = await request(app)
        .post(`/api/sessions/${S1}/messages`)
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
        { type: 'done', data: { sessionId: S1 } },
      ];

      mockRuntime.sendMessage.mockImplementation(async function* () {
        for (const event of events) {
          yield event;
        }
      });
      mockRuntime.getInternalSessionId.mockReturnValue(S1);

      await request(app)
        .post(`/api/sessions/${S1}/messages`)
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

      expect(mockRuntime.acquireLock).toHaveBeenCalledWith(
        S1,
        expect.any(String),
        expect.anything()
      );
      expect(mockRuntime.releaseLock).toHaveBeenCalledWith(S1, expect.any(String));
    });

    it('returns 409 when session is locked by another client', async () => {
      mockRuntime.acquireLock.mockReturnValue(false);
      mockRuntime.getLockInfo.mockReturnValue({
        clientId: 'other-client',
        acquiredAt: Date.now() - 60000,
      });

      const res = await request(app).post(`/api/sessions/${S1}/messages`).send({ content: 'hi' });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: 'Session locked',
        code: 'SESSION_LOCKED',
        lockedBy: 'other-client',
      });
      expect(res.body.lockedAt).toBeDefined();
    });

    it('releases lock even when streaming errors', async () => {
      mockRuntime.sendMessage.mockImplementation(async function* () {
        throw new Error('SDK failure');
      });

      await request(app)
        .post(`/api/sessions/${S1}/messages`)
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

      expect(mockRuntime.acquireLock).toHaveBeenCalled();
      expect(mockRuntime.releaseLock).toHaveBeenCalled();
    });
  });

  // ---- POST /api/sessions/:id/approve ----

  describe('POST /api/sessions/:id/approve', () => {
    it('approves pending tool call', async () => {
      mockRuntime.approveTool.mockReturnValue(true);

      const res = await request(app).post(`/api/sessions/${S1}/approve`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockRuntime.approveTool).toHaveBeenCalledWith(S1, 'tc1', true);
    });

    it('returns 404 when no pending approval', async () => {
      mockRuntime.approveTool.mockReturnValue(false);

      const res = await request(app).post(`/api/sessions/${S1}/approve`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- POST /api/sessions/:id/deny ----

  describe('POST /api/sessions/:id/deny', () => {
    it('denies pending tool call', async () => {
      mockRuntime.approveTool.mockReturnValue(true);

      const res = await request(app).post(`/api/sessions/${S1}/deny`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockRuntime.approveTool).toHaveBeenCalledWith(S1, 'tc1', false);
    });

    it('returns 404 when no pending approval', async () => {
      mockRuntime.approveTool.mockReturnValue(false);

      const res = await request(app).post(`/api/sessions/${S1}/deny`).send({ toolCallId: 'tc1' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No pending approval');
    });
  });

  // ---- GET /api/sessions/:id/stream ----

  describe('GET /api/sessions/:id/stream', () => {
    /** Helper: make an SSE request with AbortController so it doesn't hang. */
    async function sseRequest(url: string) {
      const controller = new AbortController();
      const responsePromise = new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve) => {
        const req = request(app).get(url);
        // Supertest doesn't support AbortController natively, so use .buffer(true) + custom parser
        req.buffer(true).parse(
          (res: { statusCode: number; headers: Record<string, string>; on: (event: string, handler: (chunk: Buffer) => void) => void }, callback: (err: null, data: string) => void) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            // Give the route enough time to call watchSession and write initial SSE events
            setTimeout(() => {
              resolve({ status: res.statusCode, headers: res.headers, body: data });
              callback(null, data);
            }, 150);
          },
        ).end();
      });
      const result = await responsePromise;
      controller.abort();
      return result;
    }

    it('sets SSE headers correctly', async () => {
      mockRuntime.watchSession.mockImplementation(() => () => {});

      const res = await sseRequest(`/api/sessions/${S1}/stream`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
      expect(res.headers['x-accel-buffering']).toBe('no');
    });

    it('calls watchSession on the runtime', async () => {
      mockRuntime.watchSession.mockImplementation(() => () => {});

      await sseRequest(`/api/sessions/${S1}/stream`);

      expect(mockRuntime.watchSession).toHaveBeenCalled();
      expect(mockRuntime.watchSession).toHaveBeenCalledWith(
        S1,
        expect.any(String),
        expect.any(Function),
        undefined,
      );
    });

    it('translates agent-ID to internal session ID before calling watchSession', async () => {
      const INTERNAL_ID = '00000000-0000-4000-8000-000000000099';
      mockRuntime.getInternalSessionId.mockReturnValue(INTERNAL_ID);
      mockRuntime.watchSession.mockImplementation(() => () => {});

      await sseRequest(`/api/sessions/${S1}/stream`);

      // watchSession must receive the internal session ID, not the raw agent ID from the URL
      expect(mockRuntime.watchSession).toHaveBeenCalledWith(
        INTERNAL_ID,
        expect.any(String),
        expect.any(Function),
        undefined,
      );
    });

    it('falls back to original session ID when no internal mapping exists', async () => {
      mockRuntime.getInternalSessionId.mockReturnValue(undefined);
      mockRuntime.watchSession.mockImplementation(() => () => {});

      await sseRequest(`/api/sessions/${S1}/stream`);

      expect(mockRuntime.watchSession).toHaveBeenCalledWith(
        S1,
        expect.any(String),
        expect.any(Function),
        undefined,
      );
    });
  });

  // ---- Session ID Translation ----

  describe('session ID translation', () => {
    it('GET /messages uses internal session ID when available', async () => {
      mockRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-123');
      mockRuntime.getMessageHistory.mockResolvedValue([]);

      await request(app).get(`/api/sessions/${S1}/messages`);

      expect(mockRuntime.getInternalSessionId).toHaveBeenCalledWith(S1);
      expect(mockRuntime.getMessageHistory).toHaveBeenCalledWith(
        expect.any(String),
        'sdk-uuid-123'
      );
    });

    it('returns 500 when getMessageHistory throws', async () => {
      mockRuntime.getMessageHistory.mockRejectedValueOnce(new Error('I/O error'));

      const res = await request(app)
        .get(`/api/sessions/${S1}/messages`)
        .set('x-client-id', 'test-client');

      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty('error');
    });

    it('GET /messages falls back to URL session ID when not in runtime', async () => {
      mockRuntime.getInternalSessionId.mockReturnValue(undefined);
      mockRuntime.getMessageHistory.mockResolvedValue([]);

      await request(app).get(`/api/sessions/${S1}/messages`);

      expect(mockRuntime.getMessageHistory).toHaveBeenCalledWith(
        expect.any(String),
        S1
      );
    });

    it('GET /:id uses internal session ID for metadata lookup', async () => {
      mockRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-456');
      mockRuntime.getSession.mockResolvedValue({
        id: 'sdk-uuid-456',
        title: 'Test',
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
        permissionMode: 'default',
      });

      const res = await request(app).get(`/api/sessions/${S1}`);

      expect(res.status).toBe(200);
      expect(mockRuntime.getSession).toHaveBeenCalledWith(
        expect.any(String),
        'sdk-uuid-456'
      );
    });

    it('GET /:id/tasks uses internal session ID', async () => {
      mockRuntime.getInternalSessionId.mockReturnValue('sdk-uuid-789');

      await request(app).get(`/api/sessions/${S1}/tasks`);

      expect(mockRuntime.getSessionTasks).toHaveBeenCalledWith(
        expect.any(String),
        'sdk-uuid-789'
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

      const res = await request(app).get(`/api/sessions/${S1}`).query({ cwd: '/etc' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/messages rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get(`/api/sessions/${S1}/messages`).query({ cwd: '/tmp/evil' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });

    it('GET /api/sessions/:id/tasks rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).get(`/api/sessions/${S1}/tasks`).query({ cwd: '/tmp/evil' });

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
