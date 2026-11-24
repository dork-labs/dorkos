/**
 * Shared setup for the extension-proxy suites: everything the original file declared or
 * registered outside its tests.
 */
import { beforeEach, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { RequestListener } from 'node:http';
import type { Request, Response } from 'express';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { DataProxyConfig } from '@dorkos/extension-api';
import { createProxyForwarder, createProxyHandler } from '../extension-proxy.js';
import { createExtensionApiRoutes } from '../../../../routes/extension-api.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';

/** What each test runs against; the hooks below reset it. */
export const st = {
  originalFetch: undefined as unknown as typeof globalThis.fetch,
};

// --- Mocks ---

export const mockSecretGet = vi.fn<(key: string) => Promise<string | null>>();

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

// Login off: the chain's session gate reads the `auth` section.
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// The real limiter's behaviour is pinned in
// `middleware/__tests__/extension-proxy-rate-limit.test.ts`. Here it stands in
// as a spy so these tests can prove WHERE it is asked — ahead of the forwarder,
// so a refusal costs no outbound request — without driving 120 requests.
const limiterHoisted = vi.hoisted(() => ({ hits: 0, refuse: false }));

vi.mock('../../../../middleware/extension-proxy-rate-limit.js', () => ({
  EXTENSION_PROXY_RATE_LIMIT_DEFAULT: 120,
  EXTENSION_PROXY_RATE_LIMITED_BODY: {
    type: 'urn:dorkos:problem:rate_limited',
    title: 'Too many requests. Wait a moment, then try again.',
    status: 429,
    code: 'rate_limited',
  },
  buildExtensionProxyRateLimiter: () => () => {
    limiterHoisted.hits += 1;
    return { allowed: !limiterHoisted.refuse, headers: { 'RateLimit-Limit': '120' } };
  },
}));

const roleHoisted = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));

vi.mock('../../../../lib/server-role.js', () => ({ currentServerRole: () => roleHoisted.value }));

export const fixtureTarget = swappableServer();

// --- Helpers ---

export const DEFAULT_CONFIG: DataProxyConfig = {
  baseUrl: 'https://api.example.com',
  authHeader: 'Authorization',
  authType: 'Bearer',
  authSecret: 'api_key',
};

/** Build a minimal Express-like Request object. */
export function makeReq(
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
export function makeRes(): Response & {
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
 * @param app - The listener to serve on an ephemeral port.
 * @param rawPath - The request target, sent verbatim.
 */
export function rawGetStatus(app: RequestListener, rawPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app).listen(0, () => {
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

/**
 * The forwarder for `config`, driven the way the old Express handler was: a
 * fake request in (its `params.splat` segments, `url`, headers and body) and
 * its answer written onto a fake response.
 */
export function getProxyHandler(
  config: DataProxyConfig = DEFAULT_CONFIG
): (req: Request, res: Response) => Promise<void> {
  const forward = createProxyForwarder('test-ext', config, '/fake/dork-home');
  return async (req, res) => {
    const answer = await forward({
      method: req.method,
      segments: (req.params as { splat?: string[] }).splat ?? [],
      url: req.url,
      headers: req.headers,
      body: req.body,
    });
    res.status(answer.status);
    for (const [name, value] of Object.entries(answer.headers)) res.setHeader(name, value);
    if (answer.problem !== undefined) res.json(answer.problem);
    else res.send(answer.text);
  };
}

/**
 * A server answering `/api/ext/test-ext/*` with the real proxy handler behind
 * the real `/api` chain, as the running server does.
 */
export function proxyApp(config: DataProxyConfig = DEFAULT_CONFIG): RequestListener {
  const handler = createProxyHandler('test-ext', config, '/fake/dork-home');
  return honoGroupListener({
    path: '/api/ext',
    routes: createExtensionApiRoutes({ getServerHandler: () => handler }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  st.originalFetch = globalThis.fetch;
  limiterHoisted.hits = 0;
  limiterHoisted.refuse = false;
  roleHoisted.value = 'computer';
});

afterEach(() => {
  globalThis.fetch = st.originalFetch;
});

/** Exported view of the hoisted `limiter` (vitest refuses to export a hoisted binding). */
export const limiter = limiterHoisted;
/** Exported view of the hoisted `role` (vitest refuses to export a hoisted binding). */
export const role = roleHoisted;
