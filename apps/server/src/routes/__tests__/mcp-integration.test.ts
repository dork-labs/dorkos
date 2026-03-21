import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Mock env for server factory and core-tools handlers
vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 4242,
    MCP_API_KEY: undefined,
  },
}));

vi.mock('../../lib/version.js', () => ({
  SERVER_VERSION: 'test',
  IS_DEV_BUILD: false,
}));

// Mock logger to suppress output during tests
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock manifest reader used by get_agent handler
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';

/**
 * Create minimal McpToolDeps with mock services.
 * Only required fields are set; optional services are omitted.
 */
function createMinimalDeps(): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };
}

/**
 * Create a test Express app that matches the SDK's official stateless pattern:
 * a new McpServer + transport per POST request. This is the correct stateless
 * architecture per the SDK's `simpleStatelessStreamableHttp.ts` example.
 *
 * Each POST creates a fresh McpServer via `createExternalMcpServer` and a fresh
 * `StreamableHTTPServerTransport`, connects them, handles the request, then
 * cleans up on response close.
 */
function createStatelessTestApp() {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    try {
      const server = createExternalMcpServer(createMinimalDeps());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (_err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  });

  return app;
}

/** Standard JSON-RPC initialize request body. */
const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  },
  id: 1,
};

describe('MCP Integration', () => {
  it('initialize handshake returns 200 with server info', async () => {
    const app = createStatelessTestApp();

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_REQUEST);

    expect(res.status).toBe(200);

    const body = parseResponse(res);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        serverInfo: {
          name: 'dorkos',
          version: '1.0.0',
        },
        capabilities: expect.any(Object),
      },
    });
  });

  it('tools/list returns all registered tools after initialization', async () => {
    const app = createStatelessTestApp();

    // In stateless mode, each POST creates a fresh server+transport.
    // The SDK requires `initialize` to be sent alone (not batched).
    // After initialize, subsequent requests (tools/list) work on their own
    // fresh transport — stateless mode skips session validation.
    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_REQUEST);

    expect(initRes.status).toBe(200);

    // tools/list on a fresh stateless transport (no initialize needed per-request
    // in stateless mode — session validation is disabled)
    const toolsRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'tools/list',
        id: 2,
      });

    expect(toolsRes.status).toBe(200);

    const body = parseResponse(toolsRes);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 2,
      result: {
        tools: expect.any(Array),
      },
    });

    const tools = body.result!.tools!;
    // We registered 33 tools in createExternalMcpServer
    expect(tools.length).toBeGreaterThanOrEqual(30);

    // Verify well-known tools from each category are present
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('ping');
    expect(toolNames).toContain('get_server_info');
    expect(toolNames).toContain('get_session_count');
    expect(toolNames).toContain('pulse_list_schedules');
    expect(toolNames).toContain('relay_send');
    expect(toolNames).toContain('mesh_discover');
    expect(toolNames).toContain('binding_list');
    expect(toolNames).toContain('relay_get_trace');
  });

  it('ping tool call returns pong response', async () => {
    const app = createStatelessTestApp();

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'ping',
          arguments: {},
        },
        id: 3,
      });

    expect(res.status).toBe(200);

    const body = parseResponse(res);
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: {
        content: expect.any(Array),
      },
    });

    const content = body.result!.content!;
    expect(content[0].type).toBe('text');

    const pingData = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(pingData).toMatchObject({
      status: 'pong',
      server: 'dorkos',
      timestamp: expect.any(String),
    });
  });

  it('no Mcp-Session-Id header in stateless mode', async () => {
    const app = createStatelessTestApp();

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(INITIALIZE_REQUEST);

    expect(res.status).toBe(200);
    // In stateless mode, no session ID header should be set
    expect(res.headers['mcp-session-id']).toBeUndefined();
  });
});

// ── Types & response parsing helpers ─────────────────────────────────────────

/** Loosely-typed JSON-RPC message for integration test assertions. */
interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: {
    protocolVersion?: string;
    serverInfo?: { name: string; version: string };
    capabilities?: Record<string, unknown>;
    tools?: { name: string; description?: string }[];
    content?: { type: string; text: string }[];
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

/**
 * Parse a response that may be JSON or SSE format.
 * The SDK may respond with SSE (text/event-stream) containing JSON-RPC messages,
 * or with direct JSON. This helper handles both cases.
 */
function parseResponse(res: request.Response): JsonRpcMessage {
  const contentType = (res.headers['content-type'] as string) ?? '';

  if (contentType.includes('application/json')) {
    return res.body as JsonRpcMessage;
  }

  if (contentType.includes('text/event-stream')) {
    const messages = parseSseMessages(res.text);
    return messages[0];
  }

  // Fallback: try to parse body as JSON
  return res.body as JsonRpcMessage;
}

/**
 * Parse SSE text into an array of JSON-RPC message objects.
 * SSE format: lines starting with "data: " followed by JSON.
 */
function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6)) as JsonRpcMessage;
        messages.push(data);
      } catch {
        // Skip non-JSON data lines (e.g., SSE comments)
      }
    }
  }

  return messages;
}
