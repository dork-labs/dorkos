import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMeshRouter } from '../mesh.js';
import type { MeshCore } from '@dorkos/mesh';

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
    get: vi.fn().mockReturnValue(undefined),
    listDenied: vi.fn().mockReturnValue([]),
    update: vi.fn().mockReturnValue(undefined),
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
    meshCore = createMockMeshCore();
    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(meshCore as unknown as MeshCore));
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: err.message });
      },
    );
  });

  // --- POST /discover ---

  describe('POST /api/mesh/discover', () => {
    it('returns discovered candidates', async () => {
      const candidates = [
        { projectPath: '/home/user/proj-a', suggestedName: 'proj-a', detectedRuntime: 'claude-code' },
        { projectPath: '/home/user/proj-b', suggestedName: 'proj-b', detectedRuntime: 'cursor' },
      ];

      // Mock the async generator
      meshCore.discover.mockImplementation(async function* () {
        for (const c of candidates) {
          yield c;
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
  });

  // --- POST /agents ---

  describe('POST /api/mesh/agents', () => {
    it('registers an agent and returns 201', async () => {
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      const res = await request(app).post('/api/mesh/agents').send({
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
      );
    });

    it('passes approver to registerByPath', async () => {
      meshCore.registerByPath.mockResolvedValue(MOCK_MANIFEST);

      await request(app).post('/api/mesh/agents').send({
        path: '/home/user/project',
        overrides: { name: 'Test Agent', runtime: 'claude-code' },
        approver: 'admin-user',
      });

      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/home/user/project',
        expect.objectContaining({ name: 'Test Agent', runtime: 'claude-code' }),
        'admin-user',
      );
    });

    it('returns 400 when path is missing', async () => {
      const res = await request(app).post('/api/mesh/agents').send({
        overrides: { name: 'Test', runtime: 'claude-code' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when overrides.name is missing', async () => {
      const res = await request(app).post('/api/mesh/agents').send({
        path: '/home/user/project',
        overrides: { runtime: 'claude-code' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overrides.name and overrides.runtime are required');
    });

    it('returns 400 when overrides.runtime is missing', async () => {
      const res = await request(app).post('/api/mesh/agents').send({
        path: '/home/user/project',
        overrides: { name: 'Test Agent' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('overrides.name and overrides.runtime are required');
    });

    it('returns 422 when registerByPath throws', async () => {
      meshCore.registerByPath.mockRejectedValue(new Error('Duplicate agent'));

      const res = await request(app).post('/api/mesh/agents').send({
        path: '/home/user/project',
        overrides: { name: 'Test Agent', runtime: 'claude-code' },
      });

      expect(res.status).toBe(422);
      expect(res.body.error).toBe('Duplicate agent');
    });
  });

  // --- GET /agents ---

  describe('GET /api/mesh/agents', () => {
    it('returns agent list', async () => {
      meshCore.list.mockReturnValue([MOCK_MANIFEST]);

      const res = await request(app).get('/api/mesh/agents');

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(1);
      expect(res.body.agents[0].id).toBe('agent-1');
      expect(meshCore.list).toHaveBeenCalledWith({});
    });

    it('passes runtime filter', async () => {
      meshCore.list.mockReturnValue([]);

      await request(app).get('/api/mesh/agents?runtime=cursor');

      expect(meshCore.list).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: 'cursor' }),
      );
    });

    it('passes capability filter', async () => {
      meshCore.list.mockReturnValue([]);

      await request(app).get('/api/mesh/agents?capability=code');

      expect(meshCore.list).toHaveBeenCalledWith(
        expect.objectContaining({ capability: 'code' }),
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

    it('returns 404 when agent not found', async () => {
      meshCore.update.mockReturnValue(undefined);

      const res = await request(app)
        .patch('/api/mesh/agents/nonexistent')
        .send({ name: 'No Agent' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
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
      expect(meshCore.deny).toHaveBeenCalledWith('/home/user/bad-project', 'Untrusted source', 'admin');
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
  });

  // --- GET /denied ---

  describe('GET /api/mesh/denied', () => {
    it('returns denial records', async () => {
      const denials = [
        { filePath: '/home/user/bad', reason: 'Untrusted', deniedAt: '2026-02-25T00:00:00Z', deniedBy: 'admin' },
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
  });
});
