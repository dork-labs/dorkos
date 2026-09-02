import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { Request, Response } from 'express';
import express from 'express';
import request from 'supertest';
import type { DataProxyConfig } from '@dorkos/extension-api';

// --- Mocks ---

const mockSecretGet = vi.fn<[string], Promise<string | null>>();

vi.mock('@dorkos/shared/extension-secrets', () => ({
  ExtensionSecretStore: vi.fn().mockImplementation(function () {
    return {
      get: mockSecretGet,
      set: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
    };
  }),
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The real limiter's behaviour is pinned in
// `middleware/__tests__/extension-proxy-rate-limit.test.ts`. Here it stands in
// as a spy so these tests can prove WHERE it is mounted — ahead of the handler,
// so a refusal costs no outbound request — without driving 120 requests.
const limiter = vi.hoisted(() => ({ seen: [] as string[], refuse: false }));

vi.mock('../../../middleware/extension-proxy-rate-limit.js', () => ({
  EXTENSION_PROXY_RATE_LIMIT_DEFAULT: 120,
  buildExtensionProxyRateLimiter:
    () =>
    (req: Request, res: Response, next: () => void): void => {
      limiter.seen.push(req.url);
      if (limiter.refuse) {
        res.status(429).json({ error: 'Too many requests', code: 'PROXY_RATE_LIMITED' });
        return;
      }
      next();
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

/**
 * GET one path with a raw HTTP client, so the request line reaches the server
 * exactly as written — no client-side path normalization.
 *
 * @param app - The Express app to listen on an ephemeral port.
 * @param rawPath - The request target, sent verbatim.
 */
function rawGetStatus(app: express.Express, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      http
        .get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
          res.resume();
          res.on('end', () => server.close(() => resolve(res.statusCode ?? 0)));
        })
        .on('error', (err) => server.close(() => reject(err)));
    });
  });
}

/** Shape of an Express Router's internal route stack. */
interface RouterStack {
  stack: Array<{
    route: {
      stack: Array<{ handle: (req: Request, res: Response) => Promise<void> }>;
    };
  }>;
}

/**
 * Extract the proxy handler from the router created by createProxyRouter.
 *
 * The last entry in the route's stack — the rate limiter is mounted ahead of it.
 */
function getProxyHandler(
  config: DataProxyConfig = DEFAULT_CONFIG
): (req: Request, res: Response) => Promise<void> {
  const router = createProxyRouter('test-ext', config, '/fake/dork-home');
  const routerInternal = router as unknown as RouterStack;
  const routeStack = routerInternal.stack[0].route.stack;
  return routeStack[routeStack.length - 1].handle;
}

// --- Tests ---

describe('createProxyRouter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    limiter.seen = [];
    limiter.refuse = false;
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

    it('forwards "{}" for an empty-body POST (Express 5 leaves req.body undefined)', async () => {
      mockSecretGet.mockResolvedValue('my-api-token');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"ok":true}'),
      });

      const handler = getProxyHandler();
      // No `body` override -> makeReq's default `body: undefined`.
      await handler(makeReq({ method: 'POST' }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({ method: 'POST', body: '{}' })
      );
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

  // The proxy authenticates itself to the upstream with the extension's own
  // stored secret. Anything the CALLER sent to prove who they are to DorkOS is
  // a credential for DorkOS, not for the upstream, and must not leave with the
  // request — the session cookie above all.
  describe('caller credentials are not forwarded upstream', () => {
    it('strips the caller cookie, Authorization and DorkOS agent token', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authHeader: 'X-Api-Key' });
      await handler(
        makeReq({
          headers: {
            'content-type': 'application/json',
            cookie: 'dorkos.session_token=secret-session',
            authorization: 'Bearer dorkos-api-key',
            'x-dorkos-agent': 'agent-token',
            'x-custom': 'keep-me',
          } as Record<string, string>,
        }),
        makeRes()
      );

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('cookie');
      expect(callHeaders).not.toHaveProperty('authorization');
      expect(callHeaders).not.toHaveProperty('x-dorkos-agent');
      expect(callHeaders).toHaveProperty('x-custom', 'keep-me');
      expect(callHeaders).toHaveProperty('X-Api-Key', 'Bearer tok');
    });

    it('leaves only the injected credential when the upstream header is Authorization', async () => {
      mockSecretGet.mockResolvedValue('upstream-token');
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
            authorization: 'Bearer dorkos-api-key',
          } as Record<string, string>,
        }),
        makeRes()
      );

      // Both spellings would survive into the same `Headers` object and be
      // joined with a comma, handing the upstream the caller's DorkOS key too.
      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(Object.keys(callHeaders).filter((k) => k.toLowerCase() === 'authorization')).toEqual([
        'Authorization',
      ]);
      expect(callHeaders.Authorization).toBe('Bearer upstream-token');
    });
  });

  // The caller controls the whole sub-path, and `fetch` normalizes dot segments
  // before it opens the connection — so an unchecked `..` reaches endpoints
  // above the configured base path, carrying the injected credential.
  describe('path confinement under the baseUrl prefix', () => {
    const SCOPED: DataProxyConfig = { ...DEFAULT_CONFIG, baseUrl: 'https://api.example.com/v1' };

    /** Mock a successful upstream so a call that gets through is visible. */
    function armFetch(): void {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });
    }

    it('forwards a path that stays under the prefix', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      await handler(makeReq({ params: { splat: ['issues', '123'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/issues/123',
        expect.any(Object)
      );
    });

    it('keeps a filename that merely contains dots', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      await handler(makeReq({ params: { splat: ['files', 'a..b.json'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/files/a..b.json',
        expect.any(Object)
      );
    });

    it('refuses a "../" escape without calling the upstream', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['..', 'admin'] } }), res);

      expect(res._status).toBe(400);
      expect((res._body as { code: string }).code).toBe('PROXY_PATH_NOT_ALLOWED');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses an escape that arrived percent-encoded (%2f decoded into one segment)', async () => {
      armFetch();

      // Express decodes each path segment, so `..%2f..%2fadmin` reaches the
      // handler as a single segment that already contains separators.
      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['../../admin'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a query string smuggled through the path', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['issues?admin=1'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a fragment smuggled through the path', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['issues#frag'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    // Sent down a raw socket rather than through supertest: superagent
    // normalizes `%2e%2e` in the path before it ever leaves the client, so
    // supertest cannot express this request. A raw client can, and Express
    // decodes the segments back into `..` on arrival.
    it('refuses `%2e%2e` traversal driven through the real router', async () => {
      armFetch();

      const app = express();
      app.use(createProxyRouter('test-ext', SCOPED, '/fake/dork-home'));

      const status = await rawGetStatus(app, '/proxy/%2e%2e/%2e%2e/admin');

      expect(status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses `..%2f` traversal driven through the real router', async () => {
      armFetch();

      const app = express();
      app.use(createProxyRouter('test-ext', SCOPED, '/fake/dork-home'));

      const res = await request(app).get('/proxy/..%2f..%2fadmin');

      expect(res.status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a path that hops to another host', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['..', '..', '@evil.example.com', 'x'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('redirects', () => {
    it('asks fetch not to follow them', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ redirect: 'manual' })
      );
    });

    it('hands the redirect back to the caller instead of chasing it', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler();
      const res = makeRes();
      await handler(makeReq(), res);

      expect(res._status).toBe(302);
      expect(res._headers.Location).toBe('http://169.254.169.254/latest/meta-data/');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limiting', () => {
    it('runs the limiter ahead of the proxy handler', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const app = express();
      app.use(createProxyRouter('test-ext', DEFAULT_CONFIG, '/fake/dork-home'));

      await request(app).get('/proxy/graphql');

      expect(limiter.seen).toEqual(['/proxy/graphql']);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('costs no upstream request when the limiter refuses', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn();
      limiter.refuse = true;

      const app = express();
      app.use(createProxyRouter('test-ext', DEFAULT_CONFIG, '/fake/dork-home'));

      const res = await request(app).get('/proxy/graphql');

      expect(res.status).toBe(429);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(mockSecretGet).not.toHaveBeenCalled();
    });
  });
});
