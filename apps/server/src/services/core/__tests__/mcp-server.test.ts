import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Track tool registrations via a mock McpServer ───────────────────────────
// vi.hoisted() ensures variables are initialized before vi.mock factory runs
// (vi.mock is hoisted above all imports and variable declarations).

interface RegisteredTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
  outputSchema?: unknown;
  handler: (...args: unknown[]) => unknown;
}

const { registeredTools, mockConnect, stubHandler, stubFactory } = vi.hoisted(() => {
  const registeredTools: RegisteredTool[] = [];
  const mockConnect = vi.fn();
  const stubHandler = vi.fn();
  const stubFactory = vi.fn().mockReturnValue(stubHandler);
  return { registeredTools, mockConnect, stubHandler, stubFactory };
});

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: vi.fn().mockImplementation(function (config: { name: string; version: string }) {
    return {
      name: config.name,
      version: config.version,
      connect: mockConnect,
      registerTool: vi.fn(
        (
          name: string,
          config: {
            description: string;
            inputSchema?: Record<string, unknown>;
            annotations?: Record<string, boolean>;
            outputSchema?: unknown;
          },
          handler: (...args: unknown[]) => unknown
        ) => {
          registeredTools.push({
            name,
            description: config.description,
            schema: config.inputSchema ?? {},
            annotations: config.annotations,
            outputSchema: config.outputSchema,
            handler,
          });
        }
      ),
      // Resources aren't under test in this file (see resource-specific test
      // files) — just enough surface for createExternalMcpServer's resource
      // registration + capability-override call not to throw.
      registerResource: vi.fn(),
      server: { registerCapabilities: vi.fn() },
    };
  }),
  ResourceTemplate: vi.fn().mockImplementation(function (uriTemplate: string, callbacks: unknown) {
    return {
      uriTemplate,
      callbacks,
    };
  }),
}));

// ── Mock all tool handler modules to return stubs ───────────────────────────

vi.mock('../../runtimes/claude-code/mcp-tools/core-tools.js', () => ({
  handlePing: stubHandler,
  handleGetServerInfo: stubHandler,
  createGetSessionCountHandler: stubFactory,
  createGetAgentHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/task-tools.js', () => ({
  createListSchedulesHandler: stubFactory,
  createCreateScheduleHandler: stubFactory,
  createUpdateScheduleHandler: stubFactory,
  createDeleteScheduleHandler: stubFactory,
  createGetRunHistoryHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/relay-tools.js', () => ({
  createRelaySendHandler: stubFactory,
  createRelayInboxHandler: stubFactory,
  createRelayListEndpointsHandler: stubFactory,
  createRelayRegisterEndpointHandler: stubFactory,
  createRelayQueryHandler: stubFactory,
  createRelayDispatchHandler: stubFactory,
  createRelayUnregisterEndpointHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/adapter-tools.js', () => ({
  createRelayListAdaptersHandler: stubFactory,
  createRelayEnableAdapterHandler: stubFactory,
  createRelayDisableAdapterHandler: stubFactory,
  createRelayReloadAdaptersHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/binding-tools.js', () => ({
  createBindingListHandler: stubFactory,
  createBindingCreateHandler: stubFactory,
  createBindingDeleteHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/trace-tools.js', () => ({
  createRelayGetTraceHandler: stubFactory,
  createRelayGetMetricsHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/agent-tools.js', () => ({
  createCreateAgentHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/mesh-tools.js', () => ({
  createMeshDiscoverHandler: stubFactory,
  createMeshRegisterHandler: stubFactory,
  createMeshListHandler: stubFactory,
  createMeshDenyHandler: stubFactory,
  createMeshUnregisterHandler: stubFactory,
  createMeshStatusHandler: stubFactory,
  createMeshInspectHandler: stubFactory,
  createMeshQueryTopologyHandler: stubFactory,
}));

vi.mock('../../runtimes/claude-code/mcp-tools/extension-tools.js', () => ({
  createListExtensionsHandler: stubFactory,
  createGetExtensionErrorsHandler: stubFactory,
  createGetExtensionApiHandler: stubFactory,
  createCreateExtensionHandler: stubFactory,
  createReloadExtensionsHandler: stubFactory,
  createTestExtensionHandler: stubFactory,
}));

import { createExternalMcpServer } from '../mcp-server.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

/** Create minimal deps with only required fields */
function createMinimalDeps(): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };
}

/** Create full deps with all optional services present */
function createFullDeps(): McpToolDeps {
  return {
    ...createMinimalDeps(),
    taskStore: {} as unknown as McpToolDeps['taskStore'],
    relayCore: {} as unknown as McpToolDeps['relayCore'],
    adapterManager: {} as unknown as McpToolDeps['adapterManager'],
    bindingStore: {} as unknown as McpToolDeps['bindingStore'],
    traceStore: {} as unknown as McpToolDeps['traceStore'],
    meshCore: {} as unknown as McpToolDeps['meshCore'],
  };
}

/** Look up a registered tool by name, failing loudly if it's missing. */
function findTool(name: string): RegisteredTool {
  const tool = registeredTools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool '${name}' was not registered`);
  return tool;
}

describe('createExternalMcpServer', () => {
  beforeEach(() => {
    registeredTools.length = 0;
    vi.clearAllMocks();
  });

  it('creates an McpServer with name dorkos and version 1.0.0', () => {
    const server = createExternalMcpServer(createMinimalDeps()) as unknown as {
      name: string;
      version: string;
    };
    expect(server.name).toBe('dorkos');
    expect(server.version).toBe('1.0.0');
  });

  it('returns an object with a connect method', () => {
    const server = createExternalMcpServer(createMinimalDeps());
    expect(typeof server.connect).toBe('function');
  });

  it('registers all 40 tools', () => {
    // Purpose: regression guard against accidental tool omissions or additions.
    // This count changes intentionally when new MCP tools are added.
    createExternalMcpServer(createMinimalDeps());
    expect(registeredTools).toHaveLength(40);
  });

  it('registers all expected tool names', () => {
    createExternalMcpServer(createMinimalDeps());
    const toolNames = registeredTools.map((t) => t.name);

    // Core tools (4)
    expect(toolNames).toContain('ping');
    expect(toolNames).toContain('get_server_info');
    expect(toolNames).toContain('get_session_count');
    expect(toolNames).toContain('get_agent');

    // Tasks tools (5)
    expect(toolNames).toContain('tasks_list');
    expect(toolNames).toContain('tasks_create');
    expect(toolNames).toContain('tasks_update');
    expect(toolNames).toContain('tasks_delete');
    expect(toolNames).toContain('tasks_get_run_history');

    // Relay tools (7)
    expect(toolNames).toContain('relay_send');
    expect(toolNames).toContain('relay_inbox');
    expect(toolNames).toContain('relay_list_endpoints');
    expect(toolNames).toContain('relay_register_endpoint');
    expect(toolNames).toContain('relay_send_and_wait');
    expect(toolNames).toContain('relay_send_async');
    expect(toolNames).toContain('relay_unregister_endpoint');

    // Adapter tools (4)
    expect(toolNames).toContain('relay_list_adapters');
    expect(toolNames).toContain('relay_enable_adapter');
    expect(toolNames).toContain('relay_disable_adapter');
    expect(toolNames).toContain('relay_reload_adapters');

    // Binding tools (3)
    expect(toolNames).toContain('binding_list');
    expect(toolNames).toContain('binding_create');
    expect(toolNames).toContain('binding_delete');

    // Trace tools (2)
    expect(toolNames).toContain('relay_get_trace');
    expect(toolNames).toContain('relay_get_metrics');

    // Mesh tools (8)
    expect(toolNames).toContain('mesh_discover');
    expect(toolNames).toContain('mesh_register');
    expect(toolNames).toContain('mesh_list');
    expect(toolNames).toContain('mesh_deny');
    expect(toolNames).toContain('mesh_unregister');
    expect(toolNames).toContain('mesh_status');
    expect(toolNames).toContain('mesh_inspect');
    expect(toolNames).toContain('mesh_query_topology');

    // Agent tools (1)
    expect(toolNames).toContain('create_agent');

    // Extension tools (6)
    expect(toolNames).toContain('get_extension_api');
    expect(toolNames).toContain('list_extensions');
    expect(toolNames).toContain('get_extension_errors');
    expect(toolNames).toContain('create_extension');
    expect(toolNames).toContain('reload_extensions');
    expect(toolNames).toContain('test_extension');
  });

  it('registers no duplicate tool names', () => {
    createExternalMcpServer(createMinimalDeps());
    const toolNames = registeredTools.map((t) => t.name);
    const uniqueNames = new Set(toolNames);
    expect(uniqueNames.size).toBe(toolNames.length);
  });

  it('every tool has a non-empty description', () => {
    createExternalMcpServer(createMinimalDeps());
    for (const tool of registeredTools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it('every tool has a handler function', () => {
    createExternalMcpServer(createMinimalDeps());
    for (const tool of registeredTools) {
      expect(typeof tool.handler).toBe('function');
    }
  });

  it('does not throw with minimal deps (only required fields)', () => {
    expect(() => createExternalMcpServer(createMinimalDeps())).not.toThrow();
  });

  it('does not throw with full deps (all optional services present)', () => {
    expect(() => createExternalMcpServer(createFullDeps())).not.toThrow();
  });

  it('passes deps to handler factory functions', () => {
    const deps = createMinimalDeps();
    createExternalMcpServer(deps);
    // Factory functions (e.g., createGetSessionCountHandler) should receive deps
    expect(stubFactory).toHaveBeenCalledWith(deps);
  });

  it('groups tools by domain prefix', () => {
    createExternalMcpServer(createMinimalDeps());
    const toolNames = registeredTools.map((t) => t.name);

    const coreTools = toolNames.filter(
      (n) =>
        !n.startsWith('tasks_') &&
        !n.startsWith('relay_') &&
        !n.startsWith('binding_') &&
        !n.startsWith('mesh_')
    );
    const taskTools = toolNames.filter((n) => n.startsWith('tasks_'));
    const relayTools = toolNames.filter((n) => n.startsWith('relay_'));
    const bindingTools = toolNames.filter((n) => n.startsWith('binding_'));
    const meshTools = toolNames.filter((n) => n.startsWith('mesh_'));

    expect(coreTools).toHaveLength(11); // 4 core + 1 agent (create_agent) + 6 extension (get_extension_api, list_extensions, get_extension_errors, create_extension, reload_extensions, test_extension)
    expect(taskTools).toHaveLength(5);
    expect(relayTools).toHaveLength(13); // 7 relay + 4 adapter + 2 trace
    expect(bindingTools).toHaveLength(3);
    expect(meshTools).toHaveLength(8);

    // Adapter tools use relay_ prefix (relay_list_adapters, relay_enable_adapter, etc.)
    // plus trace tools (relay_get_trace, relay_get_metrics)
    const adapterAndTraceTools = relayTools.filter(
      (n) => n.includes('adapter') || n.includes('trace') || n.includes('metrics')
    );
    expect(adapterAndTraceTools).toHaveLength(6); // 4 adapter + 2 trace
  });

  describe('tool annotations', () => {
    beforeEach(() => {
      createExternalMcpServer(createMinimalDeps());
    });

    it('every tool declares all four annotation hints', () => {
      for (const tool of registeredTools) {
        expect(tool.annotations, `${tool.name} is missing annotations`).toBeDefined();
        expect(tool.annotations).toEqual(
          expect.objectContaining({
            readOnlyHint: expect.any(Boolean),
            destructiveHint: expect.any(Boolean),
            idempotentHint: expect.any(Boolean),
            openWorldHint: expect.any(Boolean),
          })
        );
      }
    });

    it('marks pure lookups readOnlyHint: true', () => {
      for (const name of [
        'ping',
        'get_server_info',
        'get_agent',
        'mesh_list',
        'relay_get_metrics',
      ]) {
        expect(findTool(name).annotations?.readOnlyHint, name).toBe(true);
      }
    });

    it('marks resource-creating tools readOnlyHint: false, idempotentHint: false', () => {
      for (const name of ['tasks_create', 'relay_send', 'mesh_register', 'create_agent']) {
        const annotations = findTool(name).annotations;
        expect(annotations?.readOnlyHint, name).toBe(false);
        expect(annotations?.idempotentHint, name).toBe(false);
      }
    });

    it('marks delete/unregister tools destructiveHint: true', () => {
      for (const name of [
        'tasks_delete',
        'mesh_unregister',
        'binding_delete',
        'relay_unregister_endpoint',
      ]) {
        expect(findTool(name).annotations?.destructiveHint, name).toBe(true);
      }
    });

    it('marks relay_inbox not read-only because ack:true mutates message state', () => {
      expect(findTool('relay_inbox').annotations?.readOnlyHint).toBe(false);
    });

    it('marks mesh_discover not read-only because auto-import upserts the registry', () => {
      expect(findTool('mesh_discover').annotations?.readOnlyHint).toBe(false);
    });

    it('marks adapter tools that open external connections openWorldHint: true', () => {
      expect(findTool('relay_enable_adapter').annotations?.openWorldHint).toBe(true);
      expect(findTool('relay_reload_adapters').annotations?.openWorldHint).toBe(true);
    });
  });

  describe('structured output', () => {
    beforeEach(() => {
      createExternalMcpServer(createMinimalDeps());
    });

    it('declares outputSchema on the read/list tools with an exact existing Zod schema', () => {
      for (const name of [
        'get_agent',
        'mesh_list',
        'mesh_status',
        'mesh_inspect',
        'mesh_query_topology',
        'tasks_list',
        'relay_get_metrics',
      ]) {
        expect(findTool(name).outputSchema, name).toBeDefined();
      }
    });

    it('does not declare outputSchema on tools without a matching return-shape schema', () => {
      for (const name of ['ping', 'relay_send', 'tasks_create', 'mesh_discover']) {
        expect(findTool(name).outputSchema, name).toBeUndefined();
      }
    });
  });
});
