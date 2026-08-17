/**
 * Drift guard: the two MCP servers must describe every shared tool identically
 * (DOR-499).
 *
 * DorkOS puts the same tools on two servers — the in-session `dorkos` server and
 * the external `/mcp` server. Their names, descriptions, and input schemas used to
 * be typed out twice, and drifted: seven tools ended up with two different
 * descriptions, and `mesh_discover` with two different input schemas (the external
 * copy omitted `includeRegistered`, a field the shared handler reads, so no
 * external caller could reach that branch).
 *
 * They now come from one definition per tool, projected onto the external server by
 * `register-from-definitions.ts`. That makes drift structurally impossible for
 * anything registered that way — which is exactly why this test is here: it fails
 * the moment someone goes back to hand-writing a description or a schema at a
 * registration site, which is the only way the old bug can return.
 *
 * It reads the LIVE servers rather than the definition tables, so it cannot be
 * satisfied by a table that agrees with itself.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

vi.mock('../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));
vi.mock('../../../../lib/version.js', () => ({ SERVER_VERSION: 'test', IS_DEV_BUILD: false }));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));

import { createExternalMcpServer } from '../../mcp-server.js';
import { handRegisteredInSessionTools } from '../../../runtimes/claude-code/mcp-tools/index.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';
import { NotifyBudget } from '../../../relay/notify-budget.js';

/**
 * Deps with every optional service present.
 *
 * The in-session domain getters return `[]` when their service is missing, so a
 * minimal fixture would silently compare a fraction of the surface and pass. Only
 * registration is exercised here, never a handler, so opaque stubs are enough.
 */
function createFullDeps(): McpToolDeps {
  const stub = {} as never;
  return {
    notifyBudget: new NotifyBudget(),
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
    taskStore: stub,
    relayCore: stub,
    adapterManager: stub,
    traceStore: stub,
    bindingStore: stub,
    bindingRouter: stub,
    meshCore: stub,
    extensionManager: stub,
    runtimeRegistry: stub,
    activityService: stub,
  };
}

function createMarketplaceDeps(): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as MarketplaceMcpDeps;
}

interface ToolListEntry {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

interface JsonRpcMessage {
  result?: { tools?: ToolListEntry[] };
}

function parseResponse(res: request.Response): JsonRpcMessage {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('text/event-stream')) {
    for (const line of res.text.split('\n')) {
      if (line.startsWith('data: ')) return JSON.parse(line.slice(6)) as JsonRpcMessage;
    }
  }
  return res.body as JsonRpcMessage;
}

/** Every tool the live external `/mcp` server advertises. */
async function fetchExternalTools(): Promise<ToolListEntry[]> {
  const app = express();
  app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = createExternalMcpServer(createFullDeps(), createMarketplaceDeps());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
  });

  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
  expect(res.status).toBe(200);
  return parseResponse(res).result?.tools ?? [];
}

describe('in-session and external MCP surface parity', () => {
  it('describes every shared tool identically on both servers', async () => {
    const external = await fetchExternalTools();
    const inSession = handRegisteredInSessionTools(createFullDeps());

    const externalByName = new Map(external.map((tool) => [tool.name, tool]));
    const shared = inSession.filter((tool) => externalByName.has(tool.name));
    // A fixture that stopped building one of the two servers would otherwise pass
    // by comparing nothing at all.
    expect(shared.length).toBeGreaterThan(30);

    const mismatches: string[] = [];
    for (const tool of shared) {
      const externalTool = externalByName.get(tool.name);
      if (externalTool?.description !== tool.description) {
        mismatches.push(
          `${tool.name}: description differs\n  external:   ${externalTool?.description}\n  in-session: ${tool.description}`
        );
      }
      const externalKeys = Object.keys(externalTool?.inputSchema?.properties ?? {}).sort();
      const inSessionKeys = Object.keys(tool.inputSchema ?? {}).sort();
      if (externalKeys.join(',') !== inSessionKeys.join(',')) {
        mismatches.push(
          `${tool.name}: input schema differs\n  external:   ${externalKeys.join(', ')}\n  in-session: ${inSessionKeys.join(', ')}`
        );
      }
    }

    expect(
      mismatches,
      'these tools are described differently on the two servers, so one of them was hand-written instead of projected from the shared definition'
    ).toEqual([]);
  });

  it('keeps the in-session-only tools off the external server', async () => {
    // Seven tools are deliberately in-session-only, and nothing external-only
    // exists. Pinned so neither half of that changes by accident.
    const external = new Set((await fetchExternalTools()).map((tool) => tool.name));
    const inSession = handRegisteredInSessionTools(createFullDeps()).map((tool) => tool.name);

    expect([...inSession].filter((name) => !external.has(name)).sort()).toEqual([
      'binding_list_sessions',
      'browser_read_console',
      'browser_read_network',
      'browser_screenshot',
      'control_ui',
      'get_ui_state',
      'relay_notify_user',
    ]);
  });
});
