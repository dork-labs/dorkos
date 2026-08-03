import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

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

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: mockTransportConstructor,
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
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createMcpRouter } from '../mcp.js';

/**
 * ONE listener for the whole file, with the app behind it swapped per test
 * (DOR-483). Requests go to `server`, never to a bare app: handed a
 * non-listening app supertest binds and frees an ephemeral port per request,
 * and a pooled keep-alive socket for a reclaimed port lands on the wrong
 * server. See {@link swappableServer}.
 */
const target = swappableServer();

function createTestApp(mockServerFactory: () => unknown): Server {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(mockServerFactory as Parameters<typeof createMcpRouter>[0]));
  return target.mount(app);
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
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: {}, id: 1 });
    });
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockTransportConstructor).toHaveBeenCalledWith({
      sessionIdGenerator: undefined,
    });
  });

  it('POST /mcp connects transport to server', async () => {
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: {}, id: 1 });
    });
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockConnect).toHaveBeenCalled();
  });

  it('POST /mcp passes request body to transport.handleRequest', async () => {
    const body = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: { tools: [] }, id: 2 });
    });
    const server = createTestApp(createMockServer);

    await request(server).post('/mcp').send(body);

    expect(mockHandleRequest).toHaveBeenCalledWith(
      expect.anything(), // req
      expect.anything(), // res
      body // parsed body
    );
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
