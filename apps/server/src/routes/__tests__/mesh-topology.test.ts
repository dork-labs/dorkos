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
    app.use('/api/mesh', createMeshRouter({ meshCore: meshCore as unknown as MeshCore }));
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
        origin: 'explicit',
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
        origin: 'explicit',
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
    it('routes namespace-scoped filtering through listWithHealth (one response shape)', async () => {
      meshCore.listWithHealth.mockReturnValue([MOCK_MANIFEST]);

      const res = await request(app).get('/api/mesh/agents?callerNamespace=ns-a');

      expect(res.status).toBe(200);
      // Unified: callerNamespace narrows visibility but keeps the health-enriched,
      // projectPath-stripped shape — no more separate list() branch.
      expect(meshCore.listWithHealth).toHaveBeenCalledWith(
        expect.objectContaining({ callerNamespace: 'ns-a' })
      );
      expect(meshCore.list).not.toHaveBeenCalled();
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

describe('Topology enrichment — Tasks agent linking', () => {
  let app: express.Application;
  let meshCore: ReturnType<typeof createMockMeshCore>;

  const SINGLE_AGENT_TOPOLOGY = {
    namespaces: [{ namespace: 'ns-a', agents: [MOCK_MANIFEST] }],
    accessRules: [],
    agentCount: 1,
  };

  beforeEach(() => {
    meshCore = createMockMeshCore();
  });

  function buildApp(taskStore?: MeshRouterDeps['taskStore']) {
    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      taskStore,
    };
    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));
  }

  it('counts tasks linked to the agent by agentId', async () => {
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp({
      getTasks: vi.fn().mockReturnValue([
        { agentId: 'agent-1', enabled: true },
        { agentId: 'agent-1', enabled: true },
        { agentId: 'agent-other', enabled: true },
      ]),
    });

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(2);
  });

  it('returns 0 when no tasks are linked to the agent', async () => {
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp({
      getTasks: vi.fn().mockReturnValue([{ agentId: 'agent-other', enabled: true }]),
    });

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(0);
  });

  it('ignores tasks with no linked agent', async () => {
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp({
      getTasks: vi.fn().mockReturnValue([
        { agentId: null, enabled: true },
        { agentId: 'agent-1', enabled: true },
      ]),
    });

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(1);
  });

  it('excludes disabled tasks from the count', async () => {
    // Unregister cascade-disables linked tasks and file removal pauses them;
    // the topology badge must only count live schedules.
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp({
      getTasks: vi.fn().mockReturnValue([
        { agentId: 'agent-1', enabled: true },
        { agentId: 'agent-1', enabled: false },
        { agentId: 'agent-1', enabled: false },
      ]),
    });

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(1);
  });

  it('returns 0 task counts when taskStore is not provided', async () => {
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp(undefined);

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(0);
  });

  it('degrades to 0 when the task store throws', async () => {
    meshCore.getTopology.mockReturnValue(SINGLE_AGENT_TOPOLOGY);

    buildApp({
      getTasks: vi.fn().mockImplementation(() => {
        throw new Error('tasks db unavailable');
      }),
    });

    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const agent = res.body.namespaces[0].agents[0];
    expect(agent.taskCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DOR-335 — relayAdapters must not mislabel sibling agent ULIDs as adapters
// ---------------------------------------------------------------------------

describe('Topology enrichment — relayAdapters excludes sibling agent ULIDs', () => {
  let app: express.Application;
  let meshCore: ReturnType<typeof createMockMeshCore>;

  const NS = 'ns-a';
  // Real agent IDs are ULIDs (26-char Crockford base32), e.g. '01KXQR317...'
  const AGENT_1_ID = `01K${'A'.repeat(23)}`;
  const AGENT_2_ID = `01K${'B'.repeat(23)}`;

  const agent1 = { ...MOCK_MANIFEST, id: AGENT_1_ID, namespace: NS };
  const agent2 = { ...MOCK_MANIFEST, id: AGENT_2_ID, namespace: NS, name: 'Agent 2' };

  beforeEach(() => {
    meshCore = createMockMeshCore();
    meshCore.getTopology.mockReturnValue({
      namespaces: [{ namespace: NS, agents: [agent1, agent2] }],
      accessRules: [],
      agentCount: 2,
    });
    meshCore.inspect.mockImplementation((id: unknown) => ({
      relaySubject: `relay.agent.${NS}.${id as string}`,
    }));

    const deps: MeshRouterDeps = {
      meshCore: meshCore as unknown as MeshCore,
      relayCore: {
        listEndpoints: () => [
          { subject: `relay.agent.${NS}.${AGENT_1_ID}` }, // agent 1's own inbox
          { subject: `relay.agent.${NS}.${AGENT_2_ID}` }, // sibling agent's inbox
          { subject: `relay.agent.${NS}.slack` }, // a plausible non-agent adapter endpoint
        ],
      },
    };
    app = express();
    app.use(express.json());
    app.use('/api/mesh', createMeshRouter(deps));
  });

  function findAgent(
    body: { namespaces: { agents: { id: string; relayAdapters: string[] }[] }[] },
    id: string
  ) {
    return body.namespaces[0]!.agents.find((a) => a.id === id)!;
  }

  it('never lists a sibling agent ULID as one of its own relay adapters', async () => {
    const res = await request(app).get('/api/mesh/topology');

    expect(res.status).toBe(200);
    const returnedAgent1 = findAgent(res.body, AGENT_1_ID);
    expect(returnedAgent1.relayAdapters).not.toContain(AGENT_2_ID);
  });

  it('never lists an agent as its own relay adapter', async () => {
    const res = await request(app).get('/api/mesh/topology');

    const returnedAgent1 = findAgent(res.body, AGENT_1_ID);
    expect(returnedAgent1.relayAdapters).not.toContain(AGENT_1_ID);
  });

  it('still surfaces non-agent-shaped adapter segments', async () => {
    const res = await request(app).get('/api/mesh/topology');

    const returnedAgent1 = findAgent(res.body, AGENT_1_ID);
    expect(returnedAgent1.relayAdapters).toContain('slack');
  });
});
