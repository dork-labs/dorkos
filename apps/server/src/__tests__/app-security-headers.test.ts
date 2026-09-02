import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

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

import type express from 'express';
import request from 'supertest';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { isTrustedUpgradeOrigin } from '../lib/trusted-origins.js';

// Building an Express app and driving a real request through it is slow on a
// machine already running other agents' suites, and every test here does both.
// The default 5s budget false-failed six of eight runs under that load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const EVIL_ORIGIN = 'https://evil.example.com';
const LOOPBACK_ORIGIN = `http://localhost:${env.DORKOS_PORT}`;

/** Read every warning `createApp` produced that mentions the CORS variable. */
function corsWarnings(): string[] {
  return vi
    .mocked(logger.warn)
    .mock.calls.map((call) => String(call[0]))
    .filter((line) => line.includes('DORKOS_CORS_ORIGIN'));
}

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
  let app: express.Express;

  beforeAll(() => {
    process.env.DORKOS_CORS_ORIGIN = '*';
    app = createApp();
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('sends no permissive ACAO to a cross-origin request', async () => {
    const res = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('sends no permissive ACAO on the preflight either', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still allows a genuinely trusted origin (falls through to the per-request policy)', async () => {
    const res = await request(app).get('/api/health').set('Origin', LOOPBACK_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('warns the operator once, naming the variable and what to set instead', () => {
    vi.mocked(logger.warn).mockClear();

    createApp();

    const warnings = corsWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ignor/i);
  });

  it('agrees with the WebSocket origin policy, which has always refused the wildcard', async () => {
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

// A padded wildcard is the same typo, and used to be read as a one-entry
// allowlist of the literal `*` — a list that matches no origin, suppresses the
// same-origin branch, and warns about nothing. Both surfaces trim first now.
describe('CORS: DORKOS_CORS_ORIGIN with surrounding whitespace', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.DORKOS_CORS_ORIGIN = ' * ';
    app = createApp();
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('reads a padded wildcard as the wildcard, so the app keeps working', async () => {
    const res = await request(app).get('/api/health').set('Origin', LOOPBACK_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
  });

  it('still refuses a stranger', async () => {
    const res = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('warns about it rather than passing silently', () => {
    vi.mocked(logger.warn).mockClear();

    createApp();

    expect(corsWarnings()).toHaveLength(1);
  });

  it('agrees with the socket path on the same padded value', () => {
    const socketAllowed = isTrustedUpgradeOrigin({
      origin: LOOPBACK_ORIGIN,
      hostHeader: `localhost:${env.DORKOS_PORT}`,
      hostAllowed: true,
      ownsNetworkBoundary: false,
      configuredOrigins: ' * ',
      forwardedProto: undefined,
      connectionEncrypted: false,
      hostCheckInert: false,
    });

    expect(socketAllowed).toBe(true);
  });
});

describe('X-Content-Type-Options', () => {
  let app: express.Express;

  beforeAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
    app = createApp();
  });

  it('rides every API response, not only the routes that set it themselves', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rides a 404 too', async () => {
    const res = await request(app).get('/api/no-such-route');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS: an explicit DORKOS_CORS_ORIGIN allowlist is untouched', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.DORKOS_CORS_ORIGIN = 'http://localhost:5173,https://dorkos.example.com';
    app = createApp();
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('echoes a listed origin with credentials', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://dorkos.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://dorkos.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not on the list', async () => {
    const res = await request(app).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not warn about a real allowlist', () => {
    createApp();

    expect(corsWarnings()).toHaveLength(0);
  });
});
