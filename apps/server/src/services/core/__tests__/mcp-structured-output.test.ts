/**
 * Runtime validation for the external MCP server's structured-output tools.
 *
 * The 7 tools that declare an `outputSchema` (`get_agent`, `tasks_list`,
 * `relay_get_metrics`, `mesh_list`, `mesh_status`, `mesh_inspect`,
 * `mesh_query_topology`) are driven through a REAL `McpServer` +
 * `Client` pair over `InMemoryTransport` — the same `tools/call` pipeline an
 * external MCP client exercises. The SDK validates `structuredContent`
 * against the declared `outputSchema` on every non-error result and converts
 * a mismatch into an `isError: true` response, so these tests fail the
 * moment a handler's return shape drifts from its schema. The registration
 * mocks in `mcp-server.test.ts` can't catch that class of bug — they never
 * run the SDK's output validation.
 *
 * Deps are stubbed at the service boundary (`taskStore`, `traceStore`,
 * `meshCore`) with fixtures shaped exactly like the shared Zod schemas;
 * `get_agent` reads a real `.dork/agent.json` written to a temp dir.
 *
 * @module services/core/__tests__/mcp-structured-output
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentManifest,
  MeshStatus,
  MeshInspect,
  TopologyView,
} from '@dorkos/shared/mesh-schemas';
import type { Task } from '@dorkos/shared/schemas';
import type { DeliveryMetrics } from '@dorkos/shared/relay-schemas';
import { createExternalMcpServer } from '../mcp-server.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

const NOW = new Date().toISOString();

/** Fully-materialized agent manifest fixture (all schema defaults applied). */
const MANIFEST: AgentManifest = {
  id: '01JXAMPLE0000000000000TEST',
  name: 'structured-output-bot',
  description: 'Fixture agent for structured-output tests',
  runtime: 'claude-code',
  capabilities: ['testing'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: NOW,
  registeredBy: 'test',
  personaEnabled: true,
  isSystem: false,
  enabledToolGroups: {},
};

const MESH_STATUS: MeshStatus = {
  totalAgents: 1,
  activeCount: 1,
  inactiveCount: 0,
  staleCount: 0,
  unreachableCount: 0,
  byRuntime: { 'claude-code': 1 },
  byProject: { 'structured-output-bot': 1 },
};

const MESH_INSPECT: MeshInspect = {
  agent: MANIFEST,
  health: {
    agentId: MANIFEST.id,
    name: MANIFEST.name,
    status: 'active',
    lastSeenAt: NOW,
    lastSeenEvent: 'heartbeat',
    registeredAt: NOW,
    runtime: 'claude-code',
    capabilities: ['testing'],
  },
  relaySubject: null,
};

const TOPOLOGY: TopologyView = {
  callerNamespace: '*',
  namespaces: [],
  accessRules: [],
};

const TASK: Task = {
  id: 'task-1',
  name: 'Nightly verify',
  displayName: null,
  description: null,
  prompt: 'Run the verification suite',
  cron: '0 2 * * *',
  timezone: null,
  agentId: null,
  enabled: true,
  maxRuntime: null,
  permissionMode: 'default',
  status: 'active',
  filePath: '',
  createdAt: NOW,
  updatedAt: NOW,
};

const METRICS: DeliveryMetrics = {
  totalMessages: 10,
  deliveredCount: 9,
  failedCount: 1,
  deadLetteredCount: 0,
  avgDeliveryLatencyMs: 12.5,
  p95DeliveryLatencyMs: 40,
  activeEndpoints: 3,
  budgetRejections: { hopLimit: 0, ttlExpired: 0, cycleDetected: 0, budgetExhausted: 0 },
};

describe('external MCP structured-output tools (real tools/call pipeline)', () => {
  let agentDir: string;
  let client: Client;

  beforeAll(async () => {
    // Real manifest on disk so get_agent exercises its true read path.
    agentDir = await mkdtemp(path.join(tmpdir(), 'mcp-structured-'));
    await mkdir(path.join(agentDir, '.dork'), { recursive: true });
    await writeFile(path.join(agentDir, '.dork', 'agent.json'), JSON.stringify(MANIFEST), 'utf-8');

    const deps: McpToolDeps = {
      transcriptReader: {
        listSessions: async () => [],
      } as unknown as McpToolDeps['transcriptReader'],
      defaultCwd: agentDir,
      taskStore: {
        getTasks: () => [TASK],
      } as unknown as McpToolDeps['taskStore'],
      traceStore: {
        getMetrics: () => METRICS,
      } as unknown as McpToolDeps['traceStore'],
      meshCore: {
        list: () => [MANIFEST],
        getStatus: () => MESH_STATUS,
        inspect: () => MESH_INSPECT,
        getTopology: () => TOPOLOGY,
      } as unknown as McpToolDeps['meshCore'],
    };

    const server = createExternalMcpServer(deps);
    client = new Client({ name: 'structured-output-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterAll(async () => {
    await client.close();
    await rm(agentDir, { recursive: true, force: true });
  });

  /**
   * Call a tool through the real MCP pipeline and assert the result is a
   * non-error with `structuredContent` present. Because every tool under
   * test declares an `outputSchema`, the SDK has already validated
   * `structuredContent` against it server-side by the time the result
   * reaches us — a schema mismatch surfaces here as `isError: true`.
   */
  async function callStructured(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    expect(
      result.isError,
      `${name} returned an error: ${JSON.stringify(result.content)}`
    ).toBeFalsy();
    expect(result.structuredContent, `${name} returned no structuredContent`).toBeDefined();
    return result.structuredContent as Record<string, unknown>;
  }

  it('get_agent returns schema-valid structuredContent from a real manifest on disk', async () => {
    const structured = await callStructured('get_agent', { cwd: agentDir });
    expect(structured.agent).toMatchObject({ id: MANIFEST.id, name: MANIFEST.name });
  });

  it('tasks_list returns schema-valid structuredContent', async () => {
    const structured = await callStructured('tasks_list');
    expect(structured).toMatchObject({ count: 1 });
    expect(structured.schedules).toEqual([TASK]);
  });

  it('relay_get_metrics returns schema-valid structuredContent', async () => {
    const structured = await callStructured('relay_get_metrics');
    expect(structured).toEqual(METRICS);
  });

  it('mesh_list returns schema-valid structuredContent', async () => {
    const structured = await callStructured('mesh_list');
    expect(structured).toMatchObject({ count: 1 });
    expect(structured.agents).toEqual([MANIFEST]);
  });

  it('mesh_status returns schema-valid structuredContent', async () => {
    const structured = await callStructured('mesh_status');
    expect(structured).toEqual(MESH_STATUS);
  });

  it('mesh_inspect returns schema-valid structuredContent', async () => {
    const structured = await callStructured('mesh_inspect', { agentId: MANIFEST.id });
    expect(structured).toEqual(MESH_INSPECT);
  });

  it('mesh_query_topology returns schema-valid structuredContent', async () => {
    const structured = await callStructured('mesh_query_topology');
    expect(structured).toEqual(TOPOLOGY);
  });

  it('the SDK output-validation gate is live: a schema-drifted return comes back as isError', async () => {
    // Same real pipeline, but with a handler whose return violates its
    // outputSchema (count as a string). If this ever passes as a non-error,
    // the runtime validation these tests depend on has been silently lost.
    const badDeps: McpToolDeps = {
      transcriptReader: {
        listSessions: async () => [],
      } as unknown as McpToolDeps['transcriptReader'],
      defaultCwd: agentDir,
      meshCore: {
        list: () => [MANIFEST],
        getStatus: () => ({ ...MESH_STATUS, totalAgents: 'drifted' }),
        inspect: () => MESH_INSPECT,
        getTopology: () => TOPOLOGY,
      } as unknown as McpToolDeps['meshCore'],
    };
    const badServer = createExternalMcpServer(badDeps);
    const badClient = new Client({ name: 'drift-test', version: '1.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([badServer.connect(st), badClient.connect(ct)]);
    try {
      const result = (await badClient.callTool({
        name: 'mesh_status',
        arguments: {},
      })) as CallToolResult;
      expect(result.isError).toBe(true);
    } finally {
      await badClient.close();
    }
  });
});
