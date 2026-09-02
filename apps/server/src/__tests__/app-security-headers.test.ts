import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    status: {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    },
  },
}));

vi.mock('../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { isTrustedUpgradeOrigin } from '../lib/trusted-origins.js';

const EVIL_ORIGIN = 'https://evil.example.com';
const LOOPBACK_ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/**
 * `DORKOS_CORS_ORIGIN='*'` must not hand the whole API to any page the operator
 * happens to visit.
 *
 * The shipped default posture is `auth.enabled: false`, so the API needs no
 * credential at all. A wildcard `Access-Control-Allow-Origin` in that posture
 * lets `evil.com` read every response, which is why the WebSocket path has
 * always refused `'*'` (`isTrustedUpgradeOrigin`). These pin the HTTP path to
 * the same rule.
 */
describe('CORS: DORKOS_CORS_ORIGIN wildcard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DORKOS_CORS_ORIGIN = '*';
  });

  afterEach(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('sends no permissive ACAO to a cross-origin request', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('sends no permissive ACAO on the preflight either', async () => {
    const app = createApp();

    const res = await request(app)
      .options('/api/health')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still allows a genuinely trusted origin (falls through to the per-request policy)', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health').set('Origin', LOOPBACK_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('warns the operator once, naming the variable and what to set instead', () => {
    createApp();

    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    const cors = warnings.filter((line) => line.includes('DORKOS_CORS_ORIGIN'));
    expect(cors).toHaveLength(1);
    expect(cors[0]).toMatch(/ignor/i);
  });

  it('agrees with the WebSocket origin policy, which has always refused the wildcard', async () => {
    const app = createApp();

    const httpAllowed =
      (await request(app).get('/api/health').set('Origin', EVIL_ORIGIN)).headers[
        'access-control-allow-origin'
      ] !== undefined;
    const socketAllowed = isTrustedUpgradeOrigin({
      origin: EVIL_ORIGIN,
      hostHeader: 'localhost:4242',
      hostAllowed: true,
      ownsNetworkBoundary: false,
      configuredOrigins: '*',
      forwardedProto: undefined,
      connectionEncrypted: false,
      hostCheckInert: false,
    });

    expect(httpAllowed).toBe(false);
    expect(socketAllowed).toBe(false);
  });
});

describe('X-Content-Type-Options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('rides every API response, not only the routes that set it themselves', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rides a 404 too', async () => {
    const app = createApp();

    const res = await request(app).get('/api/no-such-route');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS: an explicit DORKOS_CORS_ORIGIN allowlist is untouched', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DORKOS_CORS_ORIGIN = 'http://localhost:5173,https://dorkos.example.com';
  });

  afterEach(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('echoes a listed origin with credentials', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health').set('Origin', 'https://dorkos.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://dorkos.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not on the list', async () => {
    const app = createApp();

    const res = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not warn about a real allowlist', () => {
    createApp();

    const warnings = vi.mocked(logger.warn).mock.calls.map((call) => String(call[0]));
    expect(warnings.filter((line) => line.includes('DORKOS_CORS_ORIGIN'))).toHaveLength(0);
  });
});
