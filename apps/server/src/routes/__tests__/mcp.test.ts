import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';

// Mock the MCP SDK transport — vi.hoisted() ensures variables are initialized
// before vi.mock factory runs (vi.mock is hoisted above all imports).
const { mockHandleRequest, mockTransportConstructor } = vi.hoisted(() => {
  const mockHandleRequest = vi.fn();
  const mockTransportConstructor = vi.fn().mockImplementation(function () {
    return {
      handleRequest: mockHandleRequest,
      close: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { mockHandleRequest, mockTransportConstructor };
});

vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: mockTransportConstructor,
}));

// Mock logger
vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import type { Server } from 'node:http';
import { honoListener, swappableServer } from '@dorkos/test-utils/listening-server';
import type { ApiEnv } from '../../http/api-chain.js';
import { parseRequestBody } from '../../http/request-body.js';
import { MCP_MAX_REQUEST_BODY_BYTES } from '../../services/core/capabilities/mcp-input/limits.js';
import { createMcpEndpoint } from '../mcp.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents } from '@dorkos/db';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';

/**
 * A real audit trail on a test database, so the remote-session rows the route writes can be read
 * back (DOR-4206): the real recorder runs, nothing stands in for it.
 */
function auditRows() {
  const db = createTestDb();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'test-install', readOwnerAccount: () => null }),
  });
  return () => db.select().from(auditEvents).all();
}

/**
 * ONE listener for the whole file, with the app behind it swapped per test
 * (DOR-483). Requests go to `server`, never to a bare app: handed a
 * non-listening app supertest binds and frees an ephemeral port per request,
 * and a pooled keep-alive socket for a reclaimed port lands on the wrong
 * server. See {@link swappableServer}.
 */
const target = swappableServer();

function createTestApp(mockServerFactory: () => unknown, ingress?: 'own-tunnel'): Server {
  const app = new Hono<ApiEnv>();
  // A request through the own tunnel, marked the way its listener marks it: remote use.
  if (ingress)
    app.use(async (c, next) => {
      markIngress(c.env.incoming, ingress);
      await next();
    });
  app.use(parseRequestBody());
  app.route(
    '/mcp',
    createMcpEndpoint(mockServerFactory as Parameters<typeof createMcpEndpoint>[0])
  );
  return target.mount(honoListener(app));
}

/** The transport's answer: a web `Response` the route returns as it is. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MCP Route Handler', () => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);

  function createMockServer() {
    return { connect: mockConnect, close: vi.fn().mockResolvedValue(undefined) };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // `mockReset()`, not `clearAllMocks()`: clearing wipes call history but does
    // NOT drain a queued one-shot (`mockRejectedValueOnce`) implementation. Both
    // of these carry one in the last two tests, and an unconsumed one survives
    // into a later test to fire against whatever request reaches it first.
    mockConnect.mockReset();
    mockHandleRequest.mockReset();
    mockConnect.mockResolvedValue(undefined);
  });

  it('GET /mcp returns 405 with JSON-RPC error', async () => {
    const server = createTestApp(createMockServer);
    const res = await request(server).get('/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  it('DELETE /mcp returns 405 with JSON-RPC error', async () => {
    const server = createTestApp(createMockServer);
    const res = await request(server).delete('/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Method not allowed. This server operates in stateless mode.',
      },
      id: null,
    });
  });

  it('POST /mcp creates transport with stateless config', async () => {
    mockHandleRequest.mockResolvedValue(jsonResponse({ jsonrpc: '2.0', result: {}, id: 1 }));
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockTransportConstructor).toHaveBeenCalledWith({
      sessionIdGenerator: undefined,
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    });
  });

  it('oversized /mcp JSON is refused before the server or SDK can validate it', async () => {
    const factory = vi.fn(createMockServer);
    const app = new Hono<ApiEnv>();
    app.onError((_error, c) => c.json({ error: 'too large' }, 413));
    app.use(parseRequestBody());
    app.route(
      '/mcp',
      createMcpEndpoint(factory as unknown as Parameters<typeof createMcpEndpoint>[0])
    );
    const server = target.mount(honoListener(app));
    const res = await request(server)
      .post('/mcp')
      .send({ padding: 'x'.repeat(MCP_MAX_REQUEST_BODY_BYTES) });
    expect(res.status).toBe(413);
    expect(factory).not.toHaveBeenCalled();
    expect(mockHandleRequest).not.toHaveBeenCalled();
  });

  it('POST /mcp connects transport to server', async () => {
    mockHandleRequest.mockResolvedValue(jsonResponse({ jsonrpc: '2.0', result: {}, id: 1 }));
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockConnect).toHaveBeenCalled();
  });

  it('audits each fresh stateless POST session, including discovery', async () => {
    mockHandleRequest.mockImplementation(() => jsonResponse({ result: {} }));
    const rows = auditRows();
    try {
      const server = createTestApp(createMockServer, 'own-tunnel');
      await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
      await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 2 });
      const written = rows().filter((row) => row.action === 'mcp.remote_session');
      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!.source)).toMatchObject({ surface: 'mcp' });
    } finally {
      resetAuditTrail();
    }
  });

  it('writes no remote-session row for a request at this computer', async () => {
    mockHandleRequest.mockImplementation(() => jsonResponse({ result: {} }));
    const rows = auditRows();
    try {
      const server = createTestApp(createMockServer);
      await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
      expect(rows().filter((row) => row.action === 'mcp.remote_session')).toHaveLength(0);
    } finally {
      resetAuditTrail();
    }
  });

  it('writes no tool call, tool argument or bearer into the remote-session row (DOR-4206)', async () => {
    mockHandleRequest.mockImplementation(() => jsonResponse({ result: {} }));
    const rows = auditRows();
    try {
      const server = createTestApp(createMockServer, 'own-tunnel');
      await request(server)
        .post('/mcp')
        .set('Authorization', 'Bearer bearer-test-value')
        .send({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 3,
          params: { name: 'made_up_tool', arguments: { note: 'tool-argument-test-value' } },
        });
      const written = rows().filter((row) => row.action === 'mcp.remote_session');
      expect(written).toHaveLength(1);
      const raw = JSON.stringify(written);
      for (const secret of ['tool-argument-test-value', 'made_up_tool', 'bearer-test-value'])
        expect(raw, secret).not.toContain(secret);
    } finally {
      resetAuditTrail();
    }
  });

  it('POST /mcp passes request body to transport.handleRequest', async () => {
    const body = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    mockHandleRequest.mockResolvedValue(
      jsonResponse({ jsonrpc: '2.0', result: { tools: [] }, id: 2 })
    );
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send(body);

    // The body the chain parsed once, not a second read of the stream.
    expect(mockHandleRequest).toHaveBeenCalledWith(expect.any(Request), { parsedBody: body });
  });

  it('POST /mcp returns 500 JSON-RPC error when server.connect throws', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connect failed'));
    const server = createTestApp(createMockServer);

    const res = await request(server)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null,
    });
  });

  it('POST /mcp returns 500 JSON-RPC error when transport.handleRequest throws', async () => {
    mockHandleRequest.mockRejectedValueOnce(new Error('Transport error'));
    const server = createTestApp(createMockServer);

    const res = await request(server)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal error' },
      id: null,
    });
  });
});
