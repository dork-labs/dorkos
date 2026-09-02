import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import type { DataProxyConfig } from '@dorkos/extension-api';

import {
  buildExtensionProxyRateLimiter,
  EXTENSION_PROXY_RATE_LIMIT_DEFAULT,
} from '../extension-proxy-rate-limit.js';
import { createProxyRouter } from '../../services/extensions/extension-proxy.js';

/** A proxy config pointing at an upstream no test request ever reaches. */
const PROXY_CONFIG: DataProxyConfig = {
  baseUrl: 'https://api.example.com',
  authHeader: 'Authorization',
  authType: 'Bearer',
  authSecret: 'api_key',
};

/** An app whose only route answers 200, behind the limiter under test. */
function appWithLimiter(maxPerMinute?: number): express.Express {
  const app = express();
  app.use(buildExtensionProxyRateLimiter(maxPerMinute));
  app.get('/proxy/thing', (_req, res) => {
    res.status(200).send('ok');
  });
  return app;
}

describe('buildExtensionProxyRateLimiter', () => {
  it('lets requests through up to the limit', async () => {
    const app = appWithLimiter(2);

    expect((await request(app).get('/proxy/thing')).status).toBe(200);
    expect((await request(app).get('/proxy/thing')).status).toBe(200);
  });

  it('answers 429 once the limit is spent', async () => {
    const app = appWithLimiter(2);

    await request(app).get('/proxy/thing');
    await request(app).get('/proxy/thing');
    const res = await request(app).get('/proxy/thing');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('PROXY_RATE_LIMITED');
  });

  it('sends the standard RateLimit headers and not the legacy ones', async () => {
    const app = appWithLimiter(2);

    const res = await request(app).get('/proxy/thing');

    expect(res.headers['ratelimit-limit']).toBe('2');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('counts per limiter, so one extension cannot spend another extension budget', async () => {
    const first = appWithLimiter(1);
    const second = appWithLimiter(1);

    await request(first).get('/proxy/thing');
    expect((await request(first).get('/proxy/thing')).status).toBe(429);
    expect((await request(second).get('/proxy/thing')).status).toBe(200);
  });

  it('defaults to 120 requests per minute', async () => {
    const app = appWithLimiter();

    const res = await request(app).get('/proxy/thing');

    expect(res.headers['ratelimit-limit']).toBe('120');
    expect(EXTENSION_PROXY_RATE_LIMIT_DEFAULT).toBe(120);
  });
});

// The proxy's own test file replaces this module with a spy so it can prove
// WHERE the limiter is mounted. That leaves nobody watching the real limiter
// reach a real proxy router, which is what this covers.
describe('wired into the extension proxy router', () => {
  it('answers a proxy request with the real 120/min budget', async () => {
    const app = express();
    app.use(createProxyRouter('test-ext', PROXY_CONFIG, '/no/such/dork-home'));

    const res = await request(app).get('/proxy/thing');

    expect(res.headers['ratelimit-limit']).toBe('120');
    expect(res.status).not.toBe(429);
    // No secret on disk under that dork home, so the request stops at 503 —
    // after the limiter, which is the wiring this asserts.
    expect(res.status).toBe(503);
  });
});
