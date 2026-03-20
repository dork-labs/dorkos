import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createMeshRouter, type MeshRouterDeps } from '../mesh.js';
import type { MeshCore } from '@dorkos/mesh';

const MOCK_MANIFEST = {
  id: 'agent-1',
  name: 'Test Agent',
  description: 'A test agent',
  runtime: 'claude-code' as const,
  capabilities: ['code'],
  projectPath: '/home/user/project',
  namespace: 'ns-a',
  behavior: { responseMode: 'always' },
  registeredAt: '2026-02-25T00:00:00Z',
  registeredBy: 'user',
};

const MOCK_MANIFEST_B = {
  ...MOCK_MANIFEST,
  id: 'agent-2',
  name: 'Agent B',
  namespace: 'ns-b',
  projectPath: '/home/user/project-b',
};

/** Create a mock MeshCore with vi.fn() stubs for all methods used by the router. */
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
    updateLastSeen: vi.fn(),
    close: vi.fn(),
    // Topology methods
    getTopology: vi.fn().mockReturnValue({
      namespaces: [],
      accessRules: [],
      agentCount: 0,
    }),
    getAgentAccess: vi.fn().mockReturnValue(undefined),
    allowCrossNamespace: vi.fn(),
    denyCrossNamespace: vi.fn(),
    listCrossNamespaceRules: vi.fn().mockReturnValue([]),
    // Enrichment methods
    inspect: vi.fn().mockReturnValue(undefined),
    getProjectPath: vi.fn().mockReturnValue(undefined),
  };
}

describe('Mesh topology routes', () => {
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
      }
    );
  });

  // --- GET /topology ---

  describe('GET /api/mesh/topology', () => {
    it('returns admin view when no namespace is provided', async () => {
      const mockTopology = {
        namespaces: [
          { namespace: 'ns-a', agents: [MOCK_MANIFEST] },
          { namespace: 'ns-b', agents: [MOCK_MANIFEST_B] },
        ],
        accessRules: [],
        agentCount: 2,
      };
      meshCore.getTopology.mockReturnValue(mockTopology);

      const res = await request(app).get('/api/mesh/topology');

      expect(res.status).toBe(200);
      expect(res.body.namespaces).toHaveLength(2);
      expect(res.body.agentCount).toBe(2);
      expect(meshCore.getTopology).toHaveBeenCalledWith('*');
    });

    it('returns filtered view when namespace query param is provided', async () => {
      const mockTopology = {
        namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
        accessRules: [],
        agentCount: 1,
      };
      meshCore.getTopology.mockReturnValue(mockTopology);

      const res = await request(app).get('/api/mesh/topology?namespace=ns-a');

      expect(res.status).toBe(200);
      expect(res.body.namespaces).toHaveLength(1);
      expect(res.body.namespaces[0].namespace).toBe('ns-a');
      expect(meshCore.getTopology).toHaveBeenCalledWith('ns-a');
    });
  });

  // --- PUT /topology/access ---

  describe('PUT /api/mesh/topology/access', () => {
    it('calls allowCrossNamespace for allow action', async () => {
      const res = await request(app).put('/api/mesh/topology/access').send({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'allow',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'allow',
      });
      expect(meshCore.allowCrossNamespace).toHaveBeenCalledWith('ns-a', 'ns-b');
      expect(meshCore.denyCrossNamespace).not.toHaveBeenCalled();
    });

    it('calls denyCrossNamespace for deny action', async () => {
      const res = await request(app).put('/api/mesh/topology/access').send({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'deny',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'deny',
      });
      expect(meshCore.denyCrossNamespace).toHaveBeenCalledWith('ns-a', 'ns-b');
      expect(meshCore.allowCrossNamespace).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid body', async () => {
      const res = await request(app).put('/api/mesh/topology/access').send({
        sourceNamespace: 'ns-a',
        // missing targetNamespace and action
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when action is invalid', async () => {
      const res = await request(app).put('/api/mesh/topology/access').send({
        sourceNamespace: 'ns-a',
        targetNamespace: 'ns-b',
        action: 'invalid',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 400 when sourceNamespace is empty', async () => {
      const res = await request(app).put('/api/mesh/topology/access').send({
        sourceNamespace: '',
        targetNamespace: 'ns-b',
        action: 'allow',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });
  });

  // --- GET /agents/:id/access ---

  describe('GET /api/mesh/agents/:id/access', () => {
    it('returns reachable agents for an existing agent', async () => {
      meshCore.getAgentAccess.mockReturnValue([MOCK_MANIFEST, MOCK_MANIFEST_B]);

      const res = await request(app).get('/api/mesh/agents/agent-1/access');

      expect(res.status).toBe(200);
      expect(res.body.agents).toHaveLength(2);
      expect(res.body.agents[0].id).toBe('agent-1');
      expect(res.body.agents[1].id).toBe('agent-2');
      expect(meshCore.getAgentAccess).toHaveBeenCalledWith('agent-1');
    });

    it('returns 404 for unknown agent', async () => {
      meshCore.getAgentAccess.mockReturnValue(undefined);

      const res = await request(app).get('/api/mesh/agents/nonexistent/access');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Agent not found');
    });

    it('returns empty array when agent has no reachable peers', async () => {
      meshCore.getAgentAccess.mockReturnValue([]);

      const res = await request(app).get('/api/mesh/agents/agent-1/access');

      expect(res.status).toBe(200);
      expect(res.body.agents).toEqual([]);
    });
  });

  // --- GET /agents with callerNamespace ---

  describe('GET /api/mesh/agents with callerNamespace', () => {
    it('delegates to meshCore.list for namespace-scoped filtering', async () => {
      meshCore.list.mockReturnValue([MOCK_MANIFEST]);

      const res = await request(app).get('/api/mesh/agents?callerNamespace=ns-a');

      expect(res.status).toBe(200);
      expect(meshCore.list).toHaveBeenCalledWith(
        expect.objectContaining({ callerNamespace: 'ns-a' })
      );
      // listWithHealth should NOT be called when callerNamespace is provided
      expect(meshCore.listWithHealth).not.toHaveBeenCalled();
    });

    it('uses listWithHealth when callerNamespace is absent', async () => {
      meshCore.listWithHealth.mockReturnValue([MOCK_MANIFEST]);

      const res = await request(app).get('/api/mesh/agents?runtime=claude-code');

      expect(res.status).toBe(200);
      expect(meshCore.listWithHealth).toHaveBeenCalledWith({ runtime: 'claude-code' });
      expect(meshCore.list).not.toHaveBeenCalled();
    });
  });
});

describe('Topology enrichment — Pulse path matching', () => {
  let app: express.Application;
  let meshCore: ReturnType<typeof createMockMeshCore>;

  beforeEach(() => {
    meshCore = createMockMeshCore();
  });

  it('matches Pulse schedule count using exact projectPath', async () => {
    const mockTopology = {
      namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
      accessRules: [],
      agentCount: 1,
    };
    meshCore.getTopology.mockReturnValue(mockTopology);
    meshCore.getProjectPath.mockReturnValue('/home/user/project');

    const pulseStore = {
      getSchedules: vi
        .fn()
        .mockReturnValue([
          { cwd: '/home/user/project' },
          { cwd: '/home/user/project' },
          { cwd: '/home/user/other' },
        ]),
    };

    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      pulseStore,
    };

    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.pulseScheduleCount).toBe(2);
  });

  it('returns 0 when projectPath does not match any schedule CWD', async () => {
    const mockTopology = {
      namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
      accessRules: [],
      agentCount: 1,
    };
    meshCore.getTopology.mockReturnValue(mockTopology);
    meshCore.getProjectPath.mockReturnValue('/home/user/project');

    const pulseStore = {
      getSchedules: vi.fn().mockReturnValue([{ cwd: '/home/user/other-project' }]),
    };

    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      pulseStore,
    };

    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.pulseScheduleCount).toBe(0);
  });

  it('does not false-match paths with similar namespace suffixes', async () => {
    // This test ensures the old basename heuristic bug is fixed.
    // Old code matched any CWD ending with /<namespace>, which would
    // incorrectly match /home/user/other-ns-a when namespace is 'ns-a'.
    const mockTopology = {
      namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
      accessRules: [],
      agentCount: 1,
    };
    meshCore.getTopology.mockReturnValue(mockTopology);
    meshCore.getProjectPath.mockReturnValue('/home/user/project');

    const pulseStore = {
      getSchedules: vi.fn().mockReturnValue([
        // This would match the old heuristic (ends with /ns-a) but should NOT
        // match the new exact projectPath comparison
        { cwd: '/home/user/other-ns-a' },
      ]),
    };

    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      pulseStore,
    };

    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.pulseScheduleCount).toBe(0);
  });

  it('handles getProjectPath returning undefined gracefully', async () => {
    const mockTopology = {
      namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
      accessRules: [],
      agentCount: 1,
    };
    meshCore.getTopology.mockReturnValue(mockTopology);
    meshCore.getProjectPath.mockReturnValue(undefined);

    const pulseStore = {
      getSchedules: vi.fn().mockReturnValue([{ cwd: '/home/user/project' }]),
    };

    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      pulseStore,
    };

    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.pulseScheduleCount).toBe(0);
  });
});
