import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCodexUiMcpServer, CODEX_UI_MCP_SERVER } from '../codex-ui-mcp-server.js';
import { createMcpRouter } from '../../../../routes/mcp.js';

// Suppress router error logging; the happy paths under test never log.
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

/**
 * Mount the scoped server behind the production stateless MCP router, exactly
 * as index.ts wires /codex-ui-mcp. A fresh server + transport is created per
 * POST (stateless), so no initialize handshake is required before tools/*.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/codex-ui-mcp',
    createMcpRouter(() => createCodexUiMcpServer())
  );
  return app;
}

/** Loosely-typed JSON-RPC message for assertions. */
interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: {
    serverInfo?: { name: string; version: string };
    tools?: { name: string; description?: string }[];
    content?: { type: string; text: string }[];
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

/** Parse a JSON or SSE (text/event-stream) MCP response into its first message. */
function parseResponse(res: request.Response): JsonRpcMessage {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('text/event-stream')) {
    for (const line of res.text.split('\n')) {
      if (line.startsWith('data: ')) return JSON.parse(line.slice(6)) as JsonRpcMessage;
    }
  }
  return res.body as JsonRpcMessage;
}

/** POST a JSON-RPC body to the scoped endpoint with the MCP Accept headers. */
function postRpc(app: express.Express, body: Record<string, unknown>) {
  return request(app)
    .post('/codex-ui-mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send(body);
}

describe('createCodexUiMcpServer', () => {
  it('identifies itself as the dorkos_ui server on initialize', async () => {
    const res = await postRpc(createTestApp(), {
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
    expect(parseResponse(res).result?.serverInfo).toMatchObject({
      name: CODEX_UI_MCP_SERVER,
      version: '1.0.0',
    });
  });

  it('exposes exactly one tool — control_ui — and never get_ui_state', async () => {
    const res = await postRpc(createTestApp(), { jsonrpc: '2.0', method: 'tools/list', id: 2 });

    expect(res.status).toBe(200);
    const tools = parseResponse(res).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(['control_ui']);
    expect(tools.map((t) => t.name)).not.toContain('get_ui_state');
    // DevTools read tools (DOR-213) are Claude-Code-only: the session-less Codex
    // external server can't resolve which session's buffer to read, and a read
    // must return data in-result. They must never appear here.
    expect(tools.map((t) => t.name)).not.toContain('browser_read_console');
    expect(tools.map((t) => t.name)).not.toContain('browser_read_network');
    expect(tools.map((t) => t.name)).not.toContain('browser_screenshot');
    expect(tools[0]!.description!.length).toBeGreaterThan(0);
  });

  it('control_ui returns the side-effect-free { success: true, action } stub', async () => {
    const res = await postRpc(createTestApp(), {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'control_ui',
        arguments: { action: 'open_canvas', content: { type: 'markdown', content: '# hi' } },
      },
      id: 3,
    });

    expect(res.status).toBe(200);
    const content = parseResponse(res).result?.content ?? [];
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse(content[0]!.text)).toEqual({ success: true, action: 'open_canvas' });
  });

  /**
   * DOR-639. `apply_layout` writes to the person's machine — `SKILL.md` files into
   * their skills root, a receipt naming what it wrote, the active Shape in their
   * config, created/rebound/deleted scheduled tasks, enabled and disabled
   * extensions. claude-code raises an approval card for it; Codex has no approval
   * surface, so the answer is a refusal. (`ui-command-consent.ts` carries the full
   * accounting, including what this action can NOT do.)
   *
   * This is the channel the refusal has to travel on to reach the MODEL: the
   * event-mapper's `error` StreamEvent goes to the client's transcript, never back
   * into the agent's context, so the tool result is the only place the agent can
   * read why. Driven through the production stateless MCP router, so it is the
   * real handler answering, not a stub of one.
   */
  it('refuses a control_ui action that reaches the machine, and says why', async () => {
    const res = await postRpc(createTestApp(), {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'control_ui',
        arguments: { action: 'apply_layout', shape: 'nightly-release' },
      },
      id: 4,
    });

    expect(res.status).toBe(200);
    const result = parseResponse(res).result ?? {};
    expect(result.isError, 'a refusal returned as a success trains the agent to retry').toBe(true);
    const payload = JSON.parse((result.content ?? [])[0]!.text) as {
      success: boolean;
      error: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain('apply_layout');
    expect(payload.error).toContain('DorkOS app');
  });
});
