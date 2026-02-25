import { describe, it, expect, vi } from 'vitest';
import {
  createMeshDiscoverHandler,
  createMeshRegisterHandler,
  createMeshListHandler,
  createMeshDenyHandler,
  createMeshUnregisterHandler,
  createMeshStatusHandler,
  createMeshInspectHandler,
  createMeshQueryTopologyHandler,
  type McpToolDeps,
} from '../mcp-tool-server.js';

function createMockDeps(meshEnabled = true): McpToolDeps {
  const mockMeshCore = {
    discover: vi.fn(),
    register: vi.fn(),
    registerByPath: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    getByPath: vi.fn(),
    unregister: vi.fn(),
    deny: vi.fn(),
    undeny: vi.fn(),
    close: vi.fn(),
    getStatus: vi.fn(),
    inspect: vi.fn(),
    getTopology: vi.fn(),
  };

  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    ...(meshEnabled && { meshCore: mockMeshCore as unknown as McpToolDeps['meshCore'] }),
  };
}

describe('Mesh MCP Tools', () => {
  describe('when mesh is disabled', () => {
    it('mesh_discover returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshDiscoverHandler(deps);
      const result = await handler({ roots: ['/test'] });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toEqual(
        expect.objectContaining({ code: 'MESH_DISABLED' }),
      );
    });

    it('mesh_register returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshRegisterHandler(deps);
      const result = await handler({ path: '/test/bot' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });

    it('mesh_list returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshListHandler(deps);
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });

    it('mesh_deny returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshDenyHandler(deps);
      const result = await handler({ path: '/bad' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });

    it('mesh_unregister returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshUnregisterHandler(deps);
      const result = await handler({ agentId: 'a1' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });
  });

  describe('when mesh is enabled', () => {
    it('mesh_discover returns candidates', async () => {
      const deps = createMockDeps(true);
      const mockCandidates = [
        {
          path: '/bot',
          strategy: 'claude-code',
          hints: { suggestedName: 'bot', detectedRuntime: 'claude-code' },
          discoveredAt: new Date().toISOString(),
        },
      ];
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.discover.mockImplementation(async function* () {
        for (const c of mockCandidates) yield c;
      });

      const handler = createMeshDiscoverHandler(deps);
      const result = await handler({ roots: ['/test'] });
      const data = JSON.parse(result.content[0].text);
      expect(data.candidates).toHaveLength(1);
      expect(data.count).toBe(1);
    });

    it('mesh_register creates an agent', async () => {
      const deps = createMockDeps(true);
      const mockAgent = { id: 'a1', name: 'Bot', runtime: 'claude-code' };
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.registerByPath.mockResolvedValue(mockAgent);

      const handler = createMeshRegisterHandler(deps);
      const result = await handler({ path: '/test/bot', name: 'Bot' });
      const data = JSON.parse(result.content[0].text);
      expect(data.agent.id).toBe('a1');
      expect(meshCore.registerByPath).toHaveBeenCalledWith(
        '/test/bot',
        expect.objectContaining({ name: 'Bot', runtime: 'claude-code' }),
        'mcp-tool',
      );
    });

    it('mesh_list returns agents with filters', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.list.mockReturnValue([{ id: 'a1' }]);

      const handler = createMeshListHandler(deps);
      const result = await handler({ runtime: 'claude-code' });
      const data = JSON.parse(result.content[0].text);
      expect(data.agents).toHaveLength(1);
      expect(meshCore.list).toHaveBeenCalledWith({ runtime: 'claude-code', capability: undefined });
    });

    it('mesh_deny denies a path', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;

      const handler = createMeshDenyHandler(deps);
      const result = await handler({ path: '/bad', reason: 'no good' });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(meshCore.deny).toHaveBeenCalledWith('/bad', 'no good', 'mcp-tool');
    });

    it('mesh_unregister removes an agent', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.get.mockReturnValue({ id: 'a1', name: 'Bot' });

      const handler = createMeshUnregisterHandler(deps);
      const result = await handler({ agentId: 'a1' });
      const data = JSON.parse(result.content[0].text);
      expect(data.success).toBe(true);
      expect(meshCore.unregister).toHaveBeenCalledWith('a1');
    });

    it('mesh_unregister returns error for unknown agent', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.get.mockReturnValue(undefined);

      const handler = createMeshUnregisterHandler(deps);
      const result = await handler({ agentId: 'unknown' });
      expect(result.isError).toBe(true);
    });

    it('mesh_status returns aggregate stats', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const mockStatus = {
        totalAgents: 3,
        activeCount: 2,
        inactiveCount: 0,
        staleCount: 1,
        byRuntime: { 'claude-code': 2, cursor: 1 },
        byProject: { '/projects/bot': 2, '/projects/other': 1 },
      };
      meshCore.getStatus.mockReturnValue(mockStatus);

      const handler = createMeshStatusHandler(deps);
      const result = await handler();
      const data = JSON.parse(result.content[0].text);
      expect(data.totalAgents).toBe(3);
      expect(data.activeCount).toBe(2);
      expect(data.staleCount).toBe(1);
      expect(data.byRuntime['claude-code']).toBe(2);
      expect(meshCore.getStatus).toHaveBeenCalled();
    });

    it('mesh_inspect returns agent data for valid ID', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const mockInspect = {
        agent: { id: 'a1', name: 'Bot', runtime: 'claude-code', capabilities: [] },
        health: { agentId: 'a1', name: 'Bot', status: 'active', lastSeenAt: null, lastSeenEvent: null, registeredAt: '2026-01-01T00:00:00.000Z', runtime: 'claude-code', capabilities: [] },
        relaySubject: 'relay.agent.default.a1',
      };
      meshCore.inspect.mockReturnValue(mockInspect);

      const handler = createMeshInspectHandler(deps);
      const result = await handler({ agentId: 'a1' });
      const data = JSON.parse(result.content[0].text);
      expect(data.agent.id).toBe('a1');
      expect(data.health.status).toBe('active');
      expect(data.relaySubject).toBe('relay.agent.default.a1');
      expect(meshCore.inspect).toHaveBeenCalledWith('a1');
    });

    it('mesh_inspect returns error for unknown agent', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.inspect.mockReturnValue(undefined);

      const handler = createMeshInspectHandler(deps);
      const result = await handler({ agentId: 'missing' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('missing');
    });

    it('mesh_query_topology returns topology for admin view (no namespace)', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const mockTopology = {
        namespaces: ['ns-a', 'ns-b'],
        agents: [{ id: 'a1', namespace: 'ns-a' }, { id: 'a2', namespace: 'ns-b' }],
        accessRules: [{ from: 'ns-a', to: 'ns-b' }],
      };
      meshCore.getTopology.mockReturnValue(mockTopology);

      const handler = createMeshQueryTopologyHandler(deps);
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.namespaces).toEqual(['ns-a', 'ns-b']);
      expect(data.agents).toHaveLength(2);
      expect(meshCore.getTopology).toHaveBeenCalledWith('*');
    });

    it('mesh_query_topology returns topology for specific namespace', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const mockTopology = {
        namespaces: ['ns-a'],
        agents: [{ id: 'a1', namespace: 'ns-a' }],
        accessRules: [],
      };
      meshCore.getTopology.mockReturnValue(mockTopology);

      const handler = createMeshQueryTopologyHandler(deps);
      const result = await handler({ namespace: 'ns-a' });
      const data = JSON.parse(result.content[0].text);
      expect(data.namespaces).toEqual(['ns-a']);
      expect(data.agents).toHaveLength(1);
      expect(meshCore.getTopology).toHaveBeenCalledWith('ns-a');
    });

    it('mesh_list with callerNamespace passes through to meshCore', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.list.mockReturnValue([{ id: 'a1', namespace: 'ns-a' }]);

      const handler = createMeshListHandler(deps);
      const result = await handler({ callerNamespace: 'ns-a' });
      const data = JSON.parse(result.content[0].text);
      expect(data.agents).toHaveLength(1);
      expect(meshCore.list).toHaveBeenCalledWith({
        runtime: undefined,
        capability: undefined,
        callerNamespace: 'ns-a',
      });
    });

    it('mesh_list without callerNamespace works (backward compat)', async () => {
      const deps = createMockDeps(true);
      const meshCore = deps.meshCore as unknown as Record<string, ReturnType<typeof vi.fn>>;
      meshCore.list.mockReturnValue([{ id: 'a1' }, { id: 'a2' }]);

      const handler = createMeshListHandler(deps);
      const result = await handler({});
      const data = JSON.parse(result.content[0].text);
      expect(data.agents).toHaveLength(2);
      expect(data.count).toBe(2);
      expect(meshCore.list).toHaveBeenCalledWith(undefined);
    });
  });

  describe('when mesh is disabled', () => {
    it('mesh_status returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshStatusHandler(deps);
      const result = await handler();
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });

    it('mesh_inspect returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshInspectHandler(deps);
      const result = await handler({ agentId: 'a1' });
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });

    it('mesh_query_topology returns MESH_DISABLED error', async () => {
      const deps = createMockDeps(false);
      const handler = createMeshQueryTopologyHandler(deps);
      const result = await handler({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text)).toMatchObject({ code: 'MESH_DISABLED' });
    });
  });
});
