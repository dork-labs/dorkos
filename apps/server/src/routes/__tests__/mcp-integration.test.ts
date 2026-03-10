import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock env for server factory and core-tools handlers
vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 4242,
    DORKOS_VERSION: 'test',
    MCP_API_KEY: undefined,
  },
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

// Mock manifest reader used by get_current_agent handler
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import { createMcpRouter } from '../mcp.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';

function createTestApp() {
  const deps: McpToolDeps = {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };

  const mcpServer = createExternalMcpServer(deps);
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(mcpServer));
  return app;
}

describe('MCP Integration', () => {
  it('initialize handshake returns 200 with server info', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
        id: 1,
      });

    expect(res.status).toBe(200);

    // The SDK may return the response as JSON or SSE depending on Accept header.
    // Parse the response body to find the JSON-RPC result.
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

  it('tools/list returns all registered tools', async () => {
    const app = createTestApp();

    // In stateless mode each POST is independent, so we send initialize + notifications/initialized
    // as a batch, then tools/list in a separate request.
    // Actually, in stateless mode each request creates its own transport+connection,
    // so we must send initialize first, then tools/list in a fresh request
    // (the server will re-initialize on each POST).

    // First: initialize
    const initRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
        id: 1,
      });

    expect(initRes.status).toBe(200);

    // Second: tools/list (new stateless transport — needs its own initialize first)
    // In stateless mode, each POST creates a fresh session, so we need to batch
    // initialize + tools/list. The MCP SDK supports JSON-RPC batching.
    const batchRes = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send([
        {
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
          id: 10,
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        {
          jsonrpc: '2.0',
          method: 'tools/list',
          id: 11,
        },
      ]);

    expect(batchRes.status).toBe(200);

    const messages = parseAllMessages(batchRes);
    // Find the tools/list response
    const toolsResponse = messages.find((m) => m.id === 11 && m.result?.tools);

    expect(toolsResponse).toBeDefined();
    const tools = toolsResponse!.result!.tools!;
    expect(tools).toBeInstanceOf(Array);
    // We registered 33 tools in createExternalMcpServer
    expect(tools.length).toBeGreaterThanOrEqual(30);

    // Verify well-known tools are present
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('ping');
    expect(toolNames).toContain('get_server_info');
    expect(toolNames).toContain('get_session_count');
    expect(toolNames).toContain('pulse_list_schedules');
    expect(toolNames).toContain('relay_send');
    expect(toolNames).toContain('mesh_discover');
  });

  it('ping tool call returns pong response', async () => {
    const app = createTestApp();

    // Batch: initialize + initialized notification + tools/call
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send([
        {
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0.0' },
          },
          id: 20,
        },
        {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        {
          jsonrpc: '2.0',
          method: 'tools/call',
          params: {
            name: 'ping',
            arguments: {},
          },
          id: 21,
        },
      ]);

    expect(res.status).toBe(200);

    const messages = parseAllMessages(res);
    const pingResponse = messages.find((m) => m.id === 21 && m.result?.content);

    expect(pingResponse).toBeDefined();
    const content = pingResponse!.result!.content!;
    expect(content).toBeInstanceOf(Array);
    expect(content[0].type).toBe('text');

    const pingData = JSON.parse(content[0].text) as Record<string, unknown>;
    expect(pingData).toMatchObject({
      status: 'pong',
      server: 'dorkos',
      timestamp: expect.any(String),
    });
  });

  it('no Mcp-Session-Id header in stateless mode', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
        id: 1,
      });

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
    // Parse SSE: extract data lines and parse JSON
    const messages = parseSseMessages(res.text);
    // Return the first (and likely only) message for single requests
    return messages[0];
  }

  // Fallback: try to parse body as JSON
  return res.body as JsonRpcMessage;
}

/**
 * Parse all JSON-RPC messages from a response, handling both JSON and SSE formats.
 * For batch requests, the SDK sends multiple SSE data events.
 */
function parseAllMessages(res: request.Response): JsonRpcMessage[] {
  const contentType = (res.headers['content-type'] as string) ?? '';

  if (contentType.includes('application/json')) {
    // Direct JSON response — could be a single object or array
    const body = res.body as JsonRpcMessage | JsonRpcMessage[];
    return Array.isArray(body) ? body : [body];
  }

  if (contentType.includes('text/event-stream')) {
    return parseSseMessages(res.text);
  }

  // Fallback
  const body = res.body as JsonRpcMessage | JsonRpcMessage[];
  return Array.isArray(body) ? body : [body];
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
