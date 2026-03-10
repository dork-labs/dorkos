import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// Mock the MCP SDK transport — vi.hoisted() ensures variables are initialized
// before vi.mock factory runs (vi.mock is hoisted above all imports).
const { mockHandleRequest, mockTransportConstructor } = vi.hoisted(() => {
  const mockHandleRequest = vi.fn();
  const mockTransportConstructor = vi.fn().mockImplementation(() => ({
    handleRequest: mockHandleRequest,
  }));
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

import { createMcpRouter } from '../mcp.js';

function createTestApp(mockServer: unknown) {
  const app = express();
  app.use(express.json());
  app.use('/mcp', createMcpRouter(mockServer as Parameters<typeof createMcpRouter>[0]));
  return app;
}

describe('MCP Route Handler', () => {
  const mockServer = {
    connect: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer.connect.mockResolvedValue(undefined);
  });

  it('GET /mcp returns 405 with JSON-RPC error', async () => {
    const app = createTestApp(mockServer);
    const res = await request(app).get('/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server operates in stateless mode.' },
      id: null,
    });
  });

  it('DELETE /mcp returns 405 with JSON-RPC error', async () => {
    const app = createTestApp(mockServer);
    const res = await request(app).delete('/mcp');

    expect(res.status).toBe(405);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. This server operates in stateless mode.' },
      id: null,
    });
  });

  it('POST /mcp creates transport with stateless config', async () => {
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: {}, id: 1 });
    });
    const app = createTestApp(mockServer);

    await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockTransportConstructor).toHaveBeenCalledWith({
      sessionIdGenerator: undefined,
    });
  });

  it('POST /mcp connects transport to server', async () => {
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: {}, id: 1 });
    });
    const app = createTestApp(mockServer);

    await request(app)
      .post('/mcp')
      .send({ jsonrpc: '2.0', method: 'initialize', id: 1 });

    expect(mockServer.connect).toHaveBeenCalled();
  });

  it('POST /mcp passes request body to transport.handleRequest', async () => {
    const body = { jsonrpc: '2.0', method: 'tools/list', id: 2 };
    mockHandleRequest.mockImplementation((_req: unknown, res: express.Response) => {
      res.json({ jsonrpc: '2.0', result: { tools: [] }, id: 2 });
    });
    const app = createTestApp(mockServer);

    await request(app).post('/mcp').send(body);

    expect(mockHandleRequest).toHaveBeenCalledWith(
      expect.anything(), // req
      expect.anything(), // res
      body,              // parsed body
    );
  });

  it('POST /mcp returns 500 JSON-RPC error when server.connect throws', async () => {
    mockServer.connect.mockRejectedValueOnce(new Error('Connect failed'));
    const app = createTestApp(mockServer);

    const res = await request(app)
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
    const app = createTestApp(mockServer);

    const res = await request(app)
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
