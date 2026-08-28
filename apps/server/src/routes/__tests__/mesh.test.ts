import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock boundary validation — default to passthrough (returns path as-is)
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

// Mock removeDorkDirectory — default to resolved promise
vi.mock('@dorkos/shared/manifest', () => ({
  removeDorkDirectory: vi.fn().mockResolvedValue(undefined),
}));

// Mock orphaned-install surfacing so the unregister route's scan is a spy
// (the real one walks the filesystem). Lets us assert it runs before unregister.
vi.mock('../../services/mesh/orphaned-installs.js', () => ({
  logOrphanedInstalls: vi.fn().mockResolvedValue(undefined),
}));

import { createMeshRouter } from '../mesh.js';
import type { MeshCore } from '@dorkos/mesh';
import { validateBoundary, validateBoundaryOrDorkHome, BoundaryError } from '../../lib/boundary.js';
import { removeDorkDirectory } from '@dorkos/shared/manifest';
import { logOrphanedInstalls } from '../../services/mesh/orphaned-installs.js';
import { setOnAgentCreated } from '../../services/core/agent-created-hook.js';

/** Create a mock MeshCore with vi.fn() stubs for all methods. */
function createMockMeshCore() {
  return {
    discover: vi.fn(),
    register: vi.fn(),
    registerByPath: vi.fn(),
    deny: vi.fn().mockResolvedValue(undefined),
    undeny: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    listWithHealth: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    listDenied: vi.fn().mockReturnValue([]),
    update: vi.fn().mockReturnValue(undefined),
    getStatus: vi.fn().mockReturnValue({
      totalAgents: 0,
      activeCount: 0,
      inactiveCount: 0,
      staleCount: 0,
      byRuntime: {},
      byProject: {},
    }),
    getAgentHealth: vi.fn().mockReturnValue(undefined),
    getProjectPath: vi.fn().mockReturnValue(undefined),
    updateLastSeen: vi.fn(),
    close: vi.fn(),
  };
}

const MOCK_MANIFEST = {
  id: 'agent-1',
  name: 'Test Agent',
  description: 'A test agent',
  runtime: 'claude-code' as const,
  capabilities: ['code'],
  projectPath: '/home/user/project',
  behavior: { responseMode: 'always' },
  registeredAt: '2026-02-25T00:00:00Z',
  registeredBy: 'user',
};

describe('Mesh routes', () => {
  let app: express.Application;
  let meshCore: ReturnType<typeof createMockMeshCore>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset validateBoundary to default passthrough
    vi.mocked(validateBoundary).mockImplementation(async (p: string) => p);

    meshCore = createMockMeshCore();
    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter({ meshCore: meshCore as unknown as MeshCore }));
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      }
    );
  });

  // --- POST /discover ---

  describe('POST /api/mesh/discover', () => {
    it('returns discovered candidates', async () => {
      const candidates = [
        {
          projectPath: '/home/user/proj-a',
          suggestedName: 'proj-a',
          detectedRuntime: 'claude-code',
        },
        { projectPath: '/home/user/proj-b', suggestedName: 'proj-b', detectedRuntime: 'cursor' },
      ];

      // Mock the async generator — yields ScanEvent objects
      meshCore.discover.mockImplementation(async function* () {
        for (const c of candidates) {
          yield { type: 'candidate', data: c };
        }
      });

      const res = await request(app)
        .post('/api/mesh/discover')
        .send({ roots: ['/home/user'] });

      expect(res.status).toBe(200);
      expect(res.body.candidates).toHaveLength(2);
      expect(res.body.candidates[0].projectPath).toBe('/home/user/proj-a');
      expect(res.body.candidates[1].detectedRuntime).toBe('cursor');
      expect(meshCore.discover).toHaveBeenCalledWith(['/home/user'], undefined);
    });

    it('passes maxDepth option when provided', async () => {
      meshCore.discover.mockImplementation(async function* () {
        // yields nothing
      });

      await request(app)
        .post('/api/mesh/discover')
        .send({ roots: ['/home/user'], maxDepth: 3 });

      expect(meshCore.discover).toHaveBeenCalledWith(['/home/user'], { maxDepth: 3 });
    });

    it('returns 400 when roots is missing', async () => {
      const res = await request(app).post('/api/mesh/discover').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when roots is empty array', async () => {
      const res = await request(app).post('/api/mesh/discover').send({ roots: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 500 when discovery throws', async () => {
      meshCore.discover.mockImplementation(async function* () {
        throw new Error('Permission denied');
      });

      const res = await request(app)
        .post('/api/mesh/discover')
        .send({ roots: ['/root/secret'] });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Permission denied');
    });

    it('returns 403 when any root path is outside the boundary', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app)
        .post('/api/mesh/discover')
        .send({ roots: ['/etc/passwd'] });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Path outside boundary');
      expect(meshCore.discover).not.toHaveBeenCalled();
    });

    it('validates all roots and rejects if any fails', async () => {
      // First root passes, second fails
      vi.mocked(validateBoundary)
        .mockResolvedValueOnce('/home/user/good')
        .mockRejectedValueOnce(
          new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
        );

      const res = await request(app)
        .post('/api/mesh/discover')
        .send({ roots: ['/home/user/good', '/outside/boundary'] });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('/outside/boundary');
      expect(meshCore.discover).not.toHaveBeenCalled();
    });
  });

  // --- POST /agents ---

  describe('POST /api/mesh/agents', () => {
    it('registers an agent and returns 201', async () => {
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('agent-1');
      expect(res.body.name).toBe('Test Agent');
      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({ name: 'Test Agent', runtime: 'claude-code' }),
        undefined,
        undefined
      );
    });

    it('passes approver to registerByPath', async () => {
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
          approver: 'admin-user',
        });

      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({ name: 'Test Agent', runtime: 'claude-code' }),
        'admin-user',
        undefined
      );
    });

    it('passes a validated scan root through to registerByPath (ADR-0032)', async () => {
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/projects/dorkos/core',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
          scanRoot: '/home/user/projects',
        });

      // validateBoundary is mocked to echo its input, so the scan root arrives
      // as the fourth positional argument.
      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/home/user/projects/dorkos/core',
        expect.objectContaining({ name: 'Test Agent', runtime: 'claude-code' }),
        undefined,
        '/home/user/projects'
      );
    });

    it('returns 400 when the scan root is not an ancestor of the agent path', async () => {
      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/projects/dorkos/core',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
          scanRoot: '/home/user/other',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Scan root must be an ancestor');
      expect(meshCore.registerByPath).not.toHaveBeenCalled();
    });

    it('returns 403 when the scan root is outside the boundary', async () => {
      // Register uses the dork-home seam for both the agent path (first call) and
      // the scan root (second call). Agent-path validation passes; scan-root rejects.
      vi.mocked(validateBoundaryOrDorkHome)
        .mockImplementationOnce(async (p: string) => p)
        .mockRejectedValueOnce(
          new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
        );

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
          scanRoot: '/etc',
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Scan root outside boundary');
      expect(meshCore.registerByPath).not.toHaveBeenCalled();
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          overrides: { name: 'Test', runtime: 'claude-code' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when overrides.name is missing', async () => {
      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { runtime: 'claude-code' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overrides.name and overrides.runtime are required');
    });

    it('returns 400 when overrides.runtime is missing', async () => {
      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent' },
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overrides.name and overrides.runtime are required');
    });

    it('returns 422 when registerByPath throws', async () => {
      meshCore.registerByPath.mockRejectedValue(new Error('Duplicate agent'));

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Duplicate agent');
    });

    it('returns 403 when projectPath is outside the boundary', async () => {
      // Register uses the dork-home seam for the agent path.
      vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/etc/shadow',
          overrides: { name: 'Evil Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Path outside boundary');
      expect(meshCore.registerByPath).not.toHaveBeenCalled();
    });
  });

  // --- The agent-created seam on the mesh register route (DOR-1042) ---

  describe('agent-created seam (POST /api/mesh/agents)', () => {
    afterEach(() => {
      setOnAgentCreated(null);
    });

    it('notifies the seam after a successful registration, so the agent takes its #team seat now', async () => {
      const listener = vi.fn().mockResolvedValue(undefined);
      setOnAgentCreated(listener);
      meshCore.registerByPath.mockResolvedValue({ ...MOCK_MANIFEST, displayName: 'Testy' });

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(201);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        id: 'agent-1',
        name: 'Test Agent',
        displayName: 'Testy',
        // The validated directory rides along: the rooms domain keys on it.
        path: '/home/user/project',
        // Registration, not creation — it takes the #team seat, but it is not
        // announced as a moment (DOR-1042).
        origin: 'registered',
      });
    });

    it('still returns 201 when the seam listener throws (never-500 guarantee)', async () => {
      setOnAgentCreated(vi.fn().mockRejectedValue(new Error('team seat exploded')));
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('agent-1');
    });

    it('seats the agent even when the activity write fails', async () => {
      // The activity feed is bookkeeping; the #team seat is the thing a person
      // sees. A failed feed write must not cost the seat, and must not turn a
      // registration that genuinely happened into a 422.
      const listener = vi.fn().mockResolvedValue(undefined);
      setOnAgentCreated(listener);
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);
      app.locals.activityService = {
        emit: vi.fn().mockRejectedValue(new Error('activity store is down')),
      };

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(201);
      expect(res.body.id).toBe('agent-1');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('does not notify the seam when registration fails', async () => {
      const listener = vi.fn().mockResolvedValue(undefined);
      setOnAgentCreated(listener);
      meshCore.registerByPath.mockRejectedValue(new Error('Duplicate agent'));

      const res = await request(app)
        .post('/api/mesh/agents')
        .send({
          path: '/home/user/project',
          overrides: { name: 'Test Agent', runtime: 'claude-code' },
        });

      expect(res.status).toBe(422);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // --- GET /agents ---

  describe('GET /api/mesh/agents', () => {
    it('returns agent list with health', async () => {
      meshCore.listWithHealth.mockReturnValue([MOCK_MANIFEST]);

      const res = await request(app).get('/api/mesh/agents');

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].id).toBe('agent-1');
      expect(meshCore.listWithHealth).toHaveBeenCalledWith({});
    });

    it('passes runtime filter', async () => {
      meshCore.listWithHealth.mockReturnValue([]);

      await request(app).get('/api/mesh/agents?runtime=cursor');

      expect(meshCore.listWithHealth).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: 'cursor' })
      );
    });

    it('passes capability filter', async () => {
      meshCore.listWithHealth.mockReturnValue([]);

      await request(app).get('/api/mesh/agents?capability=code');

      expect(meshCore.listWithHealth).toHaveBeenCalledWith(
        expect.objectContaining({ capability: 'code' })
      );
    });

    it('returns 400 for invalid runtime filter', async () => {
      const res = await request(app).get('/api/mesh/agents?runtime=invalid-runtime');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  // --- GET /agents/:id ---

  describe('GET /api/mesh/agents/:id', () => {
    it('returns agent when found', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);

      const res = await request(app).get('/api/mesh/agents/agent-1');

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('agent-1');
      expect(res.body.name).toBe('Test Agent');
      expect(meshCore.get).toHaveBeenCalledWith('agent-1');
    });

    it('returns 404 when agent not found', async () => {
      meshCore.get.mockReturnValue(undefined);

      const res = await request(app).get('/api/mesh/agents/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });
  });

  // --- PATCH /agents/:id ---

  describe('PATCH /api/mesh/agents/:id', () => {
    it('updates agent and returns updated manifest', async () => {
      const updated = { ...MOCK_MANIFEST, name: 'Updated Agent' };
      meshCore.update.mockReturnValue(updated);

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ name: 'Updated Agent' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Updated Agent');
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { name: 'Updated Agent' });
    });

    it('is the ONE way the rooms-management grant is set (DOR-1611, spec §D6)', async () => {
      // The other half of the asymmetry. `updateAgentManifest` — the
      // agent-reachable path behind `PATCH /api/agents/current` and the
      // `update_agent` MCP tool — refuses a patch that names `roomsManage`,
      // because a grant the governed agent can set for itself is not a grant.
      // The operator's route does not come through there, and must keep working:
      // otherwise the switch has no way in at all.
      meshCore.update.mockReturnValue({
        ...MOCK_MANIFEST,
        enabledToolGroups: { roomsManage: true },
      });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ enabledToolGroups: { roomsManage: true } });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', {
        enabledToolGroups: { roomsManage: true },
      });
    });

    it("carries an agent's model and effort through to the manifest write", async () => {
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, model: 'sonnet', effort: 'low' });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ model: 'sonnet', effort: 'low' });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', {
        model: 'sonnet',
        effort: 'low',
      });
    });

    it("accepts a model the agent's runtime may not offer, rather than refusing the save", async () => {
      // Accepted at write, reported as a warning afterwards (design §3.4).
      // Catalogs are remote and a runtime can be disconnected while somebody
      // edits — a refusal here fails for reasons they cannot see or fix.
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, model: 'gpt-5.3-codex' });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ model: 'gpt-5.3-codex' });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { model: 'gpt-5.3-codex' });
    });

    it("carries an agent's billing account through to the manifest write", async () => {
      // The operator half of invariant 4 (spec `billing-account-ladder`): this
      // route is the cockpit's, and it MUST accept `account`. The
      // agent-reachable self-edit path refuses the same key — see
      // `services/core/operator/__tests__/agent-updater.test.ts`.
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, account: 'acme-corp' });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ account: 'acme-corp' });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { account: 'acme-corp' });
    });

    it('reads a null account as "bill the server default again"', async () => {
      meshCore.update.mockReturnValue(MOCK_MANIFEST);

      const res = await request(app).patch('/api/mesh/agents/agent-1').send({ account: null });

      expect(res.status).toBe(200);
      const patch = meshCore.update.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(patch)).toEqual(['account']);
      expect(patch.account).toBeUndefined();
    });

    it('reads null as "go back to inheriting the server default"', async () => {
      meshCore.update.mockReturnValue(MOCK_MANIFEST);

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ model: null, effort: null });

      expect(res.status).toBe(200);
      // The KEY must reach the merge carrying `undefined` — that is what makes
      // the merge drop it, and a manifest without the key is what "inherits"
      // looks like on disk. Asserted on key PRESENCE, because a patch that
      // silently omitted both would satisfy any value comparison against
      // `undefined` while leaving the old model in place forever. See
      // `mesh-core.test.ts` for the same claim end to end, against real files.
      const patch = meshCore.update.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.keys(patch).sort()).toEqual(['effort', 'model']);
      expect(patch.model).toBeUndefined();
      expect(patch.effort).toBeUndefined();
    });

    it('returns 404 when agent not found', async () => {
      meshCore.update.mockReturnValue(undefined);

      const res = await request(app)
        .patch('/api/mesh/agents/nonexistent')
        .send({ name: 'No Agent' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });

    it('returns 403 when modifying protected fields on a system agent', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ name: 'Hacked Name', description: 'Hacked Desc' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('name');
      expect(res.body.error).toContain('description');
      expect(res.body.error).toContain('system agents');
      expect(meshCore.update).not.toHaveBeenCalled();
    });

    it('returns 403 when modifying namespace on a system agent', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ namespace: 'evil-ns' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('namespace');
    });

    it('returns 403 when modifying isSystem on a system agent', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });

      const res = await request(app).patch('/api/mesh/agents/agent-1').send({ isSystem: false });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('isSystem');
    });

    it('allows non-protected fields on a system agent', async () => {
      const systemAgent = { ...MOCK_MANIFEST, isSystem: true };
      meshCore.get.mockReturnValue(systemAgent);
      meshCore.update.mockReturnValue({ ...systemAgent, capabilities: ['code', 'review'] });

      const res = await request(app)
        .patch('/api/mesh/agents/agent-1')
        .send({ capabilities: ['code', 'review'] });

      expect(res.status).toBe(200);
      expect(meshCore.update).toHaveBeenCalledWith('agent-1', { capabilities: ['code', 'review'] });
    });

    it('allows protected fields on a non-system agent', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: false });
      meshCore.update.mockReturnValue({ ...MOCK_MANIFEST, name: 'New Name' });

      const res = await request(app).patch('/api/mesh/agents/agent-1').send({ name: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('New Name');
      expect(meshCore.update).toHaveBeenCalled();
    });
  });

  // --- DELETE /agents/:id ---

  describe('DELETE /api/mesh/agents/:id', () => {
    it('unregisters agent and returns success', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);

      const res = await request(app).delete('/api/mesh/agents/agent-1');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(meshCore.unregister).toHaveBeenCalledWith('agent-1');
    });

    it('returns 404 when agent not found', async () => {
      meshCore.get.mockReturnValue(undefined);

      const res = await request(app).delete('/api/mesh/agents/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });

    it('surfaces orphaned installs BEFORE unregistering (path is gone after unregister)', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.getProjectPath.mockReturnValue('/home/user/project');

      const res = await request(app).delete('/api/mesh/agents/agent-1');

      expect(res.status).toBe(200);
      expect(logOrphanedInstalls).toHaveBeenCalledWith(
        expect.objectContaining({ projectPath: '/home/user/project', agentLabel: 'Test Agent' })
      );
      // Ordering invariant: the scan must run while the agent is still
      // registered — unregister removes the registry entry, after which
      // getProjectPath returns undefined and the scan would find nothing.
      const scanOrder = vi.mocked(logOrphanedInstalls).mock.invocationCallOrder[0];
      const unregisterOrder = meshCore.unregister.mock.invocationCallOrder[0];
      expect(scanOrder).toBeLessThan(unregisterOrder);
    });

    it('skips the orphan scan when the agent has no resolvable project path', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.getProjectPath.mockReturnValue(undefined);

      await request(app).delete('/api/mesh/agents/agent-1');

      expect(logOrphanedInstalls).not.toHaveBeenCalled();
      expect(meshCore.unregister).toHaveBeenCalledWith('agent-1');
    });
  });

  // --- DELETE /agents/:id/data ---

  describe('DELETE /api/mesh/agents/:id/data', () => {
    it('returns 404 when agent not found', async () => {
      meshCore.get.mockReturnValue(undefined);

      const res = await request(app).delete('/api/mesh/agents/nonexistent/data');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
      expect(meshCore.unregister).not.toHaveBeenCalled();
      expect(removeDorkDirectory).not.toHaveBeenCalled();
    });

    it('returns 403 when agent is a system agent', async () => {
      meshCore.get.mockReturnValue({ ...MOCK_MANIFEST, isSystem: true });

      const res = await request(app).delete('/api/mesh/agents/agent-1/data');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('System agents');
      expect(meshCore.unregister).not.toHaveBeenCalled();
      expect(removeDorkDirectory).not.toHaveBeenCalled();
    });

    it('returns 403 when project path is outside the boundary', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.getProjectPath.mockReturnValue('/etc/shadow');
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).delete('/api/mesh/agents/agent-1/data');

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Path outside boundary');
      expect(meshCore.unregister).not.toHaveBeenCalled();
      expect(removeDorkDirectory).not.toHaveBeenCalled();
    });

    it('returns 404 when agent has no project path', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.getProjectPath.mockReturnValue(undefined);

      const res = await request(app).delete('/api/mesh/agents/agent-1/data');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent project path not found');
      expect(meshCore.unregister).not.toHaveBeenCalled();
      expect(removeDorkDirectory).not.toHaveBeenCalled();
    });

    it('unregisters agent, deletes .dork directory, and returns success', async () => {
      meshCore.get.mockReturnValue(MOCK_MANIFEST);
      meshCore.getProjectPath.mockReturnValue('/home/user/project');

      const res = await request(app).delete('/api/mesh/agents/agent-1/data');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deletedPath).toBe('/home/user/project/.dork');
      expect(meshCore.unregister).toHaveBeenCalledWith('agent-1');
      expect(removeDorkDirectory).toHaveBeenCalledWith('/home/user/project');
    });
  });

  // --- POST /deny ---

  describe('POST /api/mesh/deny', () => {
    it('denies a path and returns 201', async () => {
      const res = await request(app).post('/api/mesh/deny').send({
        path: '/home/user/bad-project',
        reason: 'Untrusted source',
        denier: 'admin',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(meshCore.deny).toHaveBeenCalledWith(
        '/home/user/bad-project',
        'Untrusted source',
        'admin'
      );
    });

    it('denies with only required path field', async () => {
      const res = await request(app).post('/api/mesh/deny').send({
        path: '/home/user/bad-project',
      });

      expect(res.status).toBe(201);
      expect(meshCore.deny).toHaveBeenCalledWith('/home/user/bad-project', undefined, undefined);
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app).post('/api/mesh/deny').send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 422 when deny throws', async () => {
      meshCore.deny.mockRejectedValue(new Error('Already denied'));

      const res = await request(app).post('/api/mesh/deny').send({
        path: '/home/user/bad-project',
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Already denied');
    });

    it('returns 403 for out-of-boundary paths', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const res = await request(app).post('/api/mesh/deny').send({
        path: '/etc/passwd',
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Path outside boundary');
      expect(meshCore.deny).not.toHaveBeenCalled();
    });
  });

  // --- GET /denied ---

  describe('GET /api/mesh/denied', () => {
    it('returns denial records', async () => {
      const denials = [
        {
          filePath: '/home/user/bad',
          reason: 'Untrusted',
          deniedAt: '2026-02-25T00:00:00Z',
          deniedBy: 'admin',
        },
      ];
      meshCore.listDenied.mockReturnValue(denials);

      const res = await request(app).get('/api/mesh/denied');

      expect(res.status).toBe(200);
      expect(res.body.denied).toHaveLength(1);
      expect(res.body.denied[0].filePath).toBe('/home/user/bad');
    });

    it('returns empty array when no denials', async () => {
      meshCore.listDenied.mockReturnValue([]);

      const res = await request(app).get('/api/mesh/denied');

      expect(res.status).toBe(200);
      expect(res.body.denied).toEqual([]);
    });
  });

  // --- DELETE /denied/:encodedPath ---

  describe('DELETE /api/mesh/denied/:encodedPath', () => {
    it('clears a denial by encoded path', async () => {
      const encodedPath = encodeURIComponent('/home/user/bad-project');

      const res = await request(app).delete(`/api/mesh/denied/${encodedPath}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(meshCore.undeny).toHaveBeenCalledWith('/home/user/bad-project');
    });

    it('decodes special characters in path', async () => {
      const path = '/home/user/my project (2)/agent';
      const encodedPath = encodeURIComponent(path);

      const res = await request(app).delete(`/api/mesh/denied/${encodedPath}`);

      expect(res.status).toBe(200);
      expect(meshCore.undeny).toHaveBeenCalledWith(path);
    });

    it('returns 403 for out-of-boundary paths', async () => {
      vi.mocked(validateBoundary).mockRejectedValueOnce(
        new BoundaryError('Access denied: path outside directory boundary', 'OUTSIDE_BOUNDARY')
      );

      const encodedPath = encodeURIComponent('/etc/shadow');
      const res = await request(app).delete(`/api/mesh/denied/${encodedPath}`);

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Path outside boundary');
      expect(meshCore.undeny).not.toHaveBeenCalled();
    });
  });

  // --- GET /status ---

  describe('GET /api/mesh/status', () => {
    it('returns aggregate mesh status', async () => {
      const mockStatus = {
        totalAgents: 3,
        activeCount: 2,
        inactiveCount: 1,
        staleCount: 0,
        byRuntime: { 'claude-code': 2, cursor: 1 },
        byProject: { '/home/user/proj-a': 1, '/home/user/proj-b': 2 },
      };
      meshCore.getStatus.mockReturnValue(mockStatus);

      const res = await request(app).get('/api/mesh/status');

      expect(res.status).toBe(200);
      expect(res.body.totalAgents).toBe(3);
      expect(res.body.activeCount).toBe(2);
      expect(res.body.inactiveCount).toBe(1);
      expect(res.body.staleCount).toBe(0);
      expect(res.body.byRuntime['claude-code']).toBe(2);
      expect(meshCore.getStatus).toHaveBeenCalled();
    });

    it('returns zero counts when no agents registered', async () => {
      const res = await request(app).get('/api/mesh/status');

      expect(res.status).toBe(200);
      expect(res.body.totalAgents).toBe(0);
      expect(res.body.activeCount).toBe(0);
    });
  });

  // --- GET /agents/:id/health ---

  describe('GET /api/mesh/agents/:id/health', () => {
    it('returns health snapshot for existing agent', async () => {
      const mockHealth = {
        agentId: 'agent-1',
        name: 'Test Agent',
        status: 'active',
        lastSeenAt: '2026-02-25T00:00:00Z',
        lastSeenEvent: 'heartbeat',
        registeredAt: '2026-02-25T00:00:00Z',
        runtime: 'claude-code',
        capabilities: ['code'],
      };
      meshCore.getAgentHealth.mockReturnValue(mockHealth);

      const res = await request(app).get('/api/mesh/agents/agent-1/health');

      expect(res.status).toBe(200);
      expect(res.body.agentId).toBe('agent-1');
      expect(res.body.status).toBe('active');
      expect(res.body.lastSeenEvent).toBe('heartbeat');
      expect(meshCore.getAgentHealth).toHaveBeenCalledWith('agent-1');
    });

    it('returns 404 for unknown agent', async () => {
      meshCore.getAgentHealth.mockReturnValue(undefined);

      const res = await request(app).get('/api/mesh/agents/nonexistent/health');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });
  });

  // --- POST /agents/:id/heartbeat ---

  describe('POST /api/mesh/agents/:id/heartbeat', () => {
    it('calls updateLastSeen with heartbeat event and returns success', async () => {
      const mockHealth = {
        agentId: 'agent-1',
        name: 'Test Agent',
        status: 'active',
        lastSeenAt: null,
        lastSeenEvent: null,
        registeredAt: '2026-02-25T00:00:00Z',
        runtime: 'claude-code',
        capabilities: [],
      };
      meshCore.getAgentHealth.mockReturnValue(mockHealth);

      const res = await request(app)
        .post('/api/mesh/agents/agent-1/heartbeat')
        .send({ event: 'message_sent' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(meshCore.updateLastSeen).toHaveBeenCalledWith('agent-1', 'message_sent');
    });

    it('defaults to "heartbeat" event when no body provided', async () => {
      const mockHealth = {
        agentId: 'agent-1',
        name: 'Test Agent',
        status: 'inactive',
        lastSeenAt: null,
        lastSeenEvent: null,
        registeredAt: '2026-02-25T00:00:00Z',
        runtime: 'claude-code',
        capabilities: [],
      };
      meshCore.getAgentHealth.mockReturnValue(mockHealth);

      const res = await request(app).post('/api/mesh/agents/agent-1/heartbeat').send({});

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(meshCore.updateLastSeen).toHaveBeenCalledWith('agent-1', 'heartbeat');
    });

    it('returns 404 for unknown agent', async () => {
      meshCore.getAgentHealth.mockReturnValue(undefined);

      const res = await request(app)
        .post('/api/mesh/agents/nonexistent/heartbeat')
        .send({ event: 'heartbeat' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
      expect(meshCore.updateLastSeen).not.toHaveBeenCalled();
    });
  });
});
