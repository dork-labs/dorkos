import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';

// Mock boundary before importing app. Session-cwd routes use the DorkHome-aware
// seam (validateBoundaryOrDorkHome), so that is the validator these tests drive.
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
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

// Declared at module scope so the vi.mock factory closure can reference it.
// Initialized in beforeEach so each test starts with a fresh spy instance.
let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { validateBoundary, validateBoundaryOrDorkHome, BoundaryError } from '../../lib/boundary.js';

const app = createApp();

/** Valid UUID for session ID params (routes validate UUID format). */
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/** The Docker deployment shape: a narrow boundary that excludes dork-home. */
const DORK_HOME = '/home/node/.dork';
/** A system/marketplace agent's home — must stream/read even under the boundary. */
const AGENT_HOME = `${DORK_HOME}/agents/dorkbot`;
/** A dork-home sibling of agents/ — the encrypted credential store, always denied. */
const SECRETS = `${DORK_HOME}/extension-secrets/x`;

function boundaryError(): BoundaryError {
  return new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY');
}

describe('Sessions Routes — Boundary Validation', () => {
  beforeEach(() => {
    fakeRuntime = new FakeAgentRuntime();
    // Provide sensible defaults so boundary-unrelated middleware doesn't fail
    fakeRuntime.getSession.mockResolvedValue({
      id: 'test-id',
      title: 'Test',
      createdAt: '',
      updatedAt: '',
      permissionMode: 'default',
    });
    vi.clearAllMocks();
  });

  describe('PATCH /:id', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app)
        .patch(`/api/sessions/${SESSION_ID}`)
        .query({ cwd: '/etc/shadow' })
        .send({ permissionMode: 'default' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
      expect(res.body.error).toBe('Access denied: path outside directory boundary');
    });

    it('rejects null byte paths with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app)
        .patch(`/api/sessions/${SESSION_ID}`)
        .query({ cwd: '/home/user\0' })
        .send({ permissionMode: 'default' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });

    it('allows request when cwd is within boundary', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockResolvedValueOnce('/mock/home/project');

      const res = await request(app)
        .patch(`/api/sessions/${SESSION_ID}`)
        .query({ cwd: '/mock/home/project' })
        .send({ permissionMode: 'default' });

      expect(res.status).not.toBe(403);
      expect(validateBoundaryOrDorkHome).toHaveBeenCalledWith('/mock/home/project');
    });
  });

  describe('GET /:id/events', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app)
        .get(`/api/sessions/${SESSION_ID}/events`)
        .query({ cwd: '/etc/passwd' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
      expect(res.body.error).toBe('Access denied: path outside directory boundary');
    });

    it('rejects null byte paths with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(
        new BoundaryError('Invalid path: null bytes not allowed', 'NULL_BYTE')
      );

      const res = await request(app)
        .get(`/api/sessions/${SESSION_ID}/events`)
        .query({ cwd: '/home/user\0' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NULL_BYTE');
    });

    it('validates the cwd through the DorkHome-aware seam, not the plain boundary', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      await request(app)
        .get(`/api/sessions/${SESSION_ID}/events`)
        .query({ cwd: '/outside/boundary' });

      expect(validateBoundaryOrDorkHome).toHaveBeenCalledWith('/outside/boundary');
      expect(validateBoundary).not.toHaveBeenCalled();
    });
  });

  describe('GET / (list sessions)', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app).get('/api/sessions').query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('GET /:id (get session)', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app)
        .get(`/api/sessions/${SESSION_ID}`)
        .query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('GET /:id/messages', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app)
        .get(`/api/sessions/${SESSION_ID}/messages`)
        .query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  describe('GET /:id/tasks', () => {
    it('rejects cwd outside boundary with 403', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app)
        .get(`/api/sessions/${SESSION_ID}/tasks`)
        .query({ cwd: '/etc/shadow' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });

  // The onboarding landing path: a session whose cwd is an agent's home under
  // {dorkHome}/agents/* must be allowed even under a narrow DORKOS_BOUNDARY,
  // while dork-home siblings (the credential store) and boundary-external paths
  // stay denied. The subtree discrimination itself is unit-tested against the
  // real validator in lib/__tests__/boundary.test.ts; here we prove the session
  // routes wire that DorkHome-aware seam and map its verdicts to HTTP.
  describe('agent-home ({dorkHome}/agents/*) seam', () => {
    it('allows an agent-home cwd that the plain boundary would reject', async () => {
      const res = await request(app).get(`/api/sessions/${SESSION_ID}`).query({ cwd: AGENT_HOME });

      expect(res.status).not.toBe(403);
      expect(validateBoundaryOrDorkHome).toHaveBeenCalledWith(AGENT_HOME);
      // The plain, strict validator is never consulted for a session cwd.
      expect(validateBoundary).not.toHaveBeenCalled();
    });

    it('still denies a dork-home path outside agents/* (the credential store)', async () => {
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(boundaryError());

      const res = await request(app).get(`/api/sessions/${SESSION_ID}`).query({ cwd: SECRETS });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
    });
  });
});
