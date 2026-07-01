import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import type { DataProxyConfig } from '@dorkos/extension-api';

// --- Mocks ---

const mockSecretGet = vi.fn<[string], Promise<string | null>>();

vi.mock('@dorkos/shared/extension-secrets', () => ({
  ExtensionSecretStore: vi.fn().mockImplementation(() => ({
    get: mockSecretGet,
    set: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks
import { createProxyRouter } from '../extension-proxy.js';

// --- Helpers ---

const DEFAULT_CONFIG: DataProxyConfig = {
  baseUrl: 'https://api.example.com',
  authHeader: 'Authorization',
  authType: 'Bearer',
  authSecret: 'api_key',
};

/** Build a minimal Express-like Request object. */
function makeReq(
  overrides: Partial<Request> & { params?: Record<string, string | string[]> } = {}
): Request {
  return {
    method: 'GET',
    url: '/proxy/graphql',
    params: { splat: ['graphql'] },
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      host: 'localhost:6242',
      connection: 'keep-alive',
    },
    body: undefined,
    ...overrides,
  } as unknown as Request;
}

/** Build a minimal Express-like Response object with spies. */
function makeRes(): Response & {
  _status: number | null;
  _headers: Record<string, string>;
  _body: unknown;
} {
  const res = {
    _status: null as number | null,
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res._headers[name] = value;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
    send(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as unknown as Response & typeof res;
}

/** Shape of an Express Router's internal route stack. */
interface RouterStack {
  stack: Array<{
    route: {
      stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
    };
  }>;
}

/** Extract the route handler from the router created by createProxyRouter. */
function getProxyHandler(
  config: DataProxyConfig = DEFAULT_CONFIG
): (req: Request, res: Response) => Promise<void> {
  const router = createProxyRouter('test-ext', config, '/fake/dork-home');
  const routerInternal = router as unknown as RouterStack;
  return routerInternal.stack[0].route.stack[0].handle;
}

// --- Tests ---

describe('createProxyRouter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns an Express Router', () => {
    const router = createProxyRouter('test-ext', DEFAULT_CONFIG, '/fake/dork-home');
    // Express Router has a stack property
    expect(router).toBeDefined();
    expect(typeof router).toBe('function');
  });

  describe('GET forwarding', () => {
    it('forwards GET request to upstream with auth header', async () => {
      mockSecretGet.mockResolvedValue('my-api-token');

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"data":"hello"}'),
      });

      const handler = getProxyHandler();
      const req = makeReq();
      const res = makeRes();

      await handler(req, res);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-api-token',
          }),
          body: undefined,
        })
      );
      expect(res._status).toBe(200);
      expect(res._body).toBe('{"data":"hello"}');
    });
  });

  describe('POST forwarding', () => {
    it('forwards POST body to upstream', async () => {
      mockSecretGet.mockResolvedValue('my-api-token');

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"ok":true}'),
      });

      const handler = getProxyHandler();
      const req = makeReq({
        method: 'POST',
        body: { query: '{ issues { id } }' },
      });
      const res = makeRes();

      await handler(req, res);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ query: '{ issues { id } }' }),
        })
      );
      expect(res._status).toBe(200);
    });
  });

  describe('auth header injection', () => {
    it('formats Bearer auth correctly', async () => {
      mockSecretGet.mockResolvedValue('tok123');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authType: 'Bearer' });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok123' }),
        })
      );
    });

    it('formats Basic auth correctly', async () => {
      mockSecretGet.mockResolvedValue('dXNlcjpwYXNz');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authType: 'Basic' });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Basic dXNlcjpwYXNz' }),
        })
      );
    });

    it('formats Token auth correctly', async () => {
      mockSecretGet.mockResolvedValue('ghp_abc');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authType: 'Token' });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Token ghp_abc' }),
        })
      );
    });

    it('uses raw secret value for Custom auth', async () => {
      mockSecretGet.mockResolvedValue('lin_api_abc123');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authType: 'Custom' });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'lin_api_abc123' }),
        })
      );
    });

    it('uses a custom auth header name', async () => {
      mockSecretGet.mockResolvedValue('my-key');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        authHeader: 'X-Api-Key',
        authType: 'Custom',
      });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Api-Key': 'my-key' }),
        })
      );
    });
  });

  describe('missing secret', () => {
    it('returns 503 when secret is not configured', async () => {
      mockSecretGet.mockResolvedValue(null);

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(503);
      expect(res._body).toEqual({
        error: "Secret 'api_key' not configured for extension 'test-ext'",
        hint: 'Set the secret via PUT /api/extensions/test-ext/secrets/api_key',
      });
      // fetch should not have been called
      expect(globalThis.fetch).toBe(originalFetch);
    });
  });

  describe('upstream failure', () => {
    it('returns 502 on network error', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(502);
      expect(res._body).toEqual({
        error: 'Proxy request failed',
        details: 'ECONNREFUSED',
      });
    });
  });

  describe('upstream non-200 status', () => {
    it('forwards 404 status from upstream', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"error":"Not Found"}'),
      });

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(404);
      expect(res._body).toBe('{"error":"Not Found"}');
    });

    it('forwards 500 status from upstream', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 500,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('Internal Server Error'),
      });

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(500);
      expect(res._body).toBe('Internal Server Error');
    });
  });

  describe('path forwarding', () => {
    it('forwards /proxy/graphql to baseUrl/graphql', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(makeReq({ params: { splat: ['graphql'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.any(Object)
      );
    });

    it('forwards nested paths correctly', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(makeReq({ params: { splat: ['v1', 'issues', '123'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/issues/123',
        expect.any(Object)
      );
    });

    it('strips trailing slash from baseUrl before appending path', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        baseUrl: 'https://api.example.com/',
      });
      await handler(makeReq({ params: { splat: ['data'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.any(Object)
      );
    });
  });

  describe('path rewriting', () => {
    it('applies pathRewrite rules to the target URL', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        pathRewrite: { '/v1/': '/v2/' },
      });
      await handler(
        makeReq({ url: '/proxy/v1/issues', params: { splat: ['v1', 'issues'] } }),
        makeRes()
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v2/issues',
        expect.any(Object)
      );
    });
  });

  describe('query string forwarding', () => {
    it('forwards query parameters to upstream', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(
        makeReq({ url: '/proxy/issues?state=open&limit=10', params: { splat: ['issues'] } }),
        makeRes()
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/issues?state=open&limit=10',
        expect.any(Object)
      );
    });
  });

  describe('header filtering', () => {
    it('strips hop-by-hop headers (host, connection)', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(
        makeReq({
          headers: {
            'content-type': 'application/json',
            host: 'localhost:6242',
            connection: 'keep-alive',
            'transfer-encoding': 'chunked',
            'x-custom': 'keep-me',
          } as Record<string, string>,
        }),
        makeRes()
      );

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('host');
      expect(callHeaders).not.toHaveProperty('connection');
      expect(callHeaders).not.toHaveProperty('transfer-encoding');
      expect(callHeaders).toHaveProperty('x-custom', 'keep-me');
    });
  });

  describe('content-type forwarding', () => {
    it('forwards content-type from upstream response', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: () => Promise.resolve('<html></html>'),
      });

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._headers['Content-Type']).toBe('text/html; charset=utf-8');
    });
  });

  // Regression guard for the Express 5 migration (DOR-171): the other tests call
  // the handler directly with a mock req, so they can't prove the route actually
  // matches. Drive a real request through the mounted router to confirm
  // '/proxy/*splat' matches and the multi-segment sub-path is reconstructed from
  // req.params.splat (a segment array in Express 5, was req.params[0] in v4).
  describe('real router wildcard matching (Express 5)', () => {
    it('matches /proxy/* and forwards the full sub-path with query string', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{}'),
      });

      const app = express();
      app.use(createProxyRouter('test-ext', DEFAULT_CONFIG, '/fake/dork-home'));

      await request(app).get('/proxy/v1/issues/123?state=open');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/issues/123?state=open',
        expect.any(Object)
      );
    });
  });
});
