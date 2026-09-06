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
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { isTrustedBrowserOrigin } from '../lib/trusted-origins.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** What the WebSocket upgrade asks of the shared origin policy. */
const UPGRADE_POLICY = { allowNoOrigin: true, pairSameOriginWithHost: true } as const;

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
 * always refused `'*'` (`isTrustedBrowserOrigin`). These pin the HTTP path to
 * the same rule.
 */
describe('CORS: DORKOS_CORS_ORIGIN wildcard', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.DORKOS_CORS_ORIGIN = '*';
    app = createApp();

    fixtureTarget.mount(app);
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('sends no permissive ACAO to a cross-origin request', async () => {
    const res = await request(fixtureServer).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('sends no permissive ACAO on the preflight either', async () => {
    const res = await request(fixtureServer)
      .options('/api/health')
      .set('Origin', EVIL_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still allows a genuinely trusted origin (falls through to the per-request policy)', async () => {
    const res = await request(fixtureServer).get('/api/health').set('Origin', LOOPBACK_ORIGIN);

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
      (await request(fixtureServer).get('/api/health').set('Origin', EVIL_ORIGIN)).headers[
        'access-control-allow-origin'
      ] !== undefined;
    const socketAllowed = isTrustedBrowserOrigin(
      {
        origin: EVIL_ORIGIN,
        hostHeader: 'localhost:4242',
        hostAllowed: true,
        ownsNetworkBoundary: false,
        configuredOrigins: '*',
        forwardedProto: undefined,
        connectionEncrypted: false,
        hostCheckInert: false,
      },
      UPGRADE_POLICY
    );

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

    fixtureTarget.mount(app);
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('reads a padded wildcard as the wildcard, so the app keeps working', async () => {
    const res = await request(fixtureServer).get('/api/health').set('Origin', LOOPBACK_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBe(LOOPBACK_ORIGIN);
  });

  it('still refuses a stranger', async () => {
    const res = await request(fixtureServer).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('warns about it rather than passing silently', () => {
    vi.mocked(logger.warn).mockClear();

    createApp();

    expect(corsWarnings()).toHaveLength(1);
  });

  it('agrees with the socket path on the same padded value', () => {
    const socketAllowed = isTrustedBrowserOrigin(
      {
        origin: LOOPBACK_ORIGIN,
        hostHeader: `localhost:${env.DORKOS_PORT}`,
        hostAllowed: true,
        ownsNetworkBoundary: false,
        configuredOrigins: ' * ',
        forwardedProto: undefined,
        connectionEncrypted: false,
        hostCheckInert: false,
      },
      UPGRADE_POLICY
    );

    expect(socketAllowed).toBe(true);
  });
});

describe('X-Content-Type-Options', () => {
  let app: express.Express;

  beforeAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
    app = createApp();

    fixtureTarget.mount(app);
  });

  it('rides every API response, not only the routes that set it themselves', async () => {
    const res = await request(fixtureServer).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('rides a 404 too', async () => {
    const res = await request(fixtureServer).get('/api/no-such-route');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('CORS: an explicit DORKOS_CORS_ORIGIN allowlist is untouched', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.DORKOS_CORS_ORIGIN = 'http://localhost:5173,https://dorkos.example.com';
    app = createApp();

    fixtureTarget.mount(app);
  });

  afterAll(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('echoes a listed origin with credentials', async () => {
    const res = await request(fixtureServer)
      .get('/api/health')
      .set('Origin', 'https://dorkos.example.com');

    expect(res.headers['access-control-allow-origin']).toBe('https://dorkos.example.com');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('refuses an origin that is not on the list', async () => {
    const res = await request(fixtureServer).get('/api/health').set('Origin', EVIL_ORIGIN);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not warn about a real allowlist', () => {
    createApp();

    expect(corsWarnings()).toHaveLength(0);
  });

  /**
   * The regression an adversarial review measured side-by-side against `main`
   * (DOR-1711 round 2), and the reason branch 3 falls THROUGH to branch 4.
   *
   * Before the unification, an explicit `DORKOS_CORS_ORIGIN` switched CORS to
   * `cors({ origin: [...] })`. That form does not refuse anything: an origin off
   * the list simply gets no `Access-Control-Allow-Origin`, the browser withholds
   * the RESPONSE, and the route still runs. The delegate form refuses by calling
   * back with an `Error`, which Express turns into a 500 — so folding the two
   * paths together turned "no header" into "the request dies", for every address
   * that was not on the list.
   *
   * Which sounds like tightening until you notice WHICH addresses those are.
   * A container published on a remapped host port, a LAN IP, a reverse-proxied
   * host: all same-origin with their own request, all absent from a list naming
   * the public origin, and all 200 on `main` against 500 here. Reads kept
   * working (a same-origin GET sends no `Origin` at all), so the shape was the
   * silent outage this whole change exists to remove — the app loads, and every
   * write dies.
   *
   * Both directions are pinned, because either alone is satisfiable by a bug:
   * a policy that trusts everything passes the first, and one that ignores the
   * variable passes the second.
   */
  describe('the list ADDS to the policy, it does not replace it', () => {
    /** A container published on a different host port than it listens on. */
    const REMAPPED = 'localhost:4300';

    it('still accepts a same-origin WRITE from a host that is not on the list', async () => {
      const res = await request(fixtureServer)
        .post('/api/errors')
        .set('Host', REMAPPED)
        .set('Origin', `http://${REMAPPED}`)
        .send({ message: 'boom' });

      // 202 is `POST /api/errors`'s own answer: the write ran. A 500 here is the
      // CORS layer refusing, which is the regression.
      expect(res.status).toBe(202);
      expect(res.headers['access-control-allow-origin']).toBe(`http://${REMAPPED}`);
    });

    it('still refuses a stranger WRITE while the list is set', async () => {
      // The other direction: falling through to the same-origin branch must not
      // become "anything goes". `evil.example.com` is not on the list and is not
      // same-origin with a `Host` this instance answers to.
      const res = await request(fixtureServer)
        .post('/api/errors')
        .set('Host', REMAPPED)
        .set('Origin', EVIL_ORIGIN)
        .send({ message: 'boom' });

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.status).not.toBe(202);
    });

    it('still accepts a listed origin cross-origin, which is what the list is FOR', async () => {
      const res = await request(fixtureServer)
        .post('/api/errors')
        .set('Host', REMAPPED)
        .set('Origin', 'https://dorkos.example.com')
        .send({ message: 'boom' });

      expect(res.status).toBe(202);
      expect(res.headers['access-control-allow-origin']).toBe('https://dorkos.example.com');
    });
  });
});
