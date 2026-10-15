import { describe, it, expect, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import type { DataProxyConfig } from '@dorkos/extension-api';

// Login off: the chain's session gate reads the `auth` section.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import {
  buildExtensionProxyRateLimiter,
  EXTENSION_PROXY_RATE_LIMIT_DEFAULT,
} from '../extension-proxy-rate-limit.js';
import type { RequestFacts } from '../../http/request-facts.js';
import { createProxyHandler } from '../../services/extensions/http/extension-proxy.js';
import { createExtensionApiRoutes } from '../../routes/extension-api.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const fixtureTarget = swappableServer();

/** A proxy config pointing at an upstream no test request ever reaches. */
const PROXY_CONFIG: DataProxyConfig = {
  baseUrl: 'https://api.example.com',
  authHeader: 'Authorization',
  authType: 'Bearer',
  authSecret: 'api_key',
};

/** One caller, as the chain describes it. */
const CALLER: RequestFacts = {
  headers: {},
  peerAddress: '127.0.0.1',
  forwardedAddress: '127.0.0.1',
  connectionEncrypted: false,
  ingress: 'direct',
  user: undefined,
  agentIdentity: undefined,
};

describe('buildExtensionProxyRateLimiter', () => {
  it('lets requests through up to the limit', () => {
    const limit = buildExtensionProxyRateLimiter(2);

    expect(limit(CALLER).allowed).toBe(true);
    expect(limit(CALLER).allowed).toBe(true);
  });

  it('refuses once the limit is spent, with a Retry-After', () => {
    const limit = buildExtensionProxyRateLimiter(2);

    limit(CALLER);
    limit(CALLER);
    const verdict = limit(CALLER);

    expect(verdict.allowed).toBe(false);
    expect(verdict.headers['Retry-After']).toMatch(/^\d+$/);
  });

  it('sends the standard RateLimit headers and not the legacy ones', () => {
    const { headers } = buildExtensionProxyRateLimiter(2)(CALLER);

    expect(headers['RateLimit-Limit']).toBe('2');
    expect(headers['X-RateLimit-Limit']).toBeUndefined();
  });

  it('counts per limiter, so one extension cannot spend another extension budget', () => {
    const first = buildExtensionProxyRateLimiter(1);
    const second = buildExtensionProxyRateLimiter(1);

    first(CALLER);
    expect(first(CALLER).allowed).toBe(false);
    expect(second(CALLER).allowed).toBe(true);
  });

  it('counts each caller on its own', () => {
    const limit = buildExtensionProxyRateLimiter(1);

    limit(CALLER);
    expect(limit({ ...CALLER, peerAddress: '10.0.0.9' }).allowed).toBe(true);
  });

  it('defaults to 120 requests per minute', () => {
    const { headers } = buildExtensionProxyRateLimiter()(CALLER);

    expect(headers['RateLimit-Limit']).toBe('120');
    expect(EXTENSION_PROXY_RATE_LIMIT_DEFAULT).toBe(120);
  });
});

// The proxy's own test file replaces this module with a spy so it can prove
// WHERE the limiter is asked. That leaves nobody watching the real limiter
// reach a real proxy, which is what this covers.
describe('wired into the extension proxy', () => {
  it('answers a proxy request with the real 120/min budget', async () => {
    const handler = createProxyHandler('test-ext', PROXY_CONFIG, '/no/such/dork-home');
    const app = honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes({ getServerHandler: () => handler }),
    });

    const res = await request(fixtureTarget.mount(app)).get('/api/ext/test-ext/proxy/thing');

    expect(res.headers['ratelimit-limit']).toBe('120');
    // No secret on disk under that dork home, so the request stops at 503 —
    // after the limiter, which is the wiring this asserts.
    expect(res.status).toBe(503);
  });

  it('answers 429 with the refusal once the budget is spent', async () => {
    const handler = createProxyHandler('test-ext', PROXY_CONFIG, '/no/such/dork-home');
    const app = honoGroupListener({
      path: '/api/ext',
      routes: createExtensionApiRoutes({ getServerHandler: () => handler }),
    });
    fixtureTarget.mount(app);

    let res = await request(fixtureTarget.server).get('/api/ext/test-ext/proxy/thing');
    for (let i = 1; i <= EXTENSION_PROXY_RATE_LIMIT_DEFAULT; i += 1) {
      res = await request(fixtureTarget.server).get('/api/ext/test-ext/proxy/thing');
    }

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PROXY_RATE_LIMITED');
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
  });
});
