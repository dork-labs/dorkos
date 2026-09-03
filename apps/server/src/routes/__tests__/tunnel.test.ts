import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    start: vi.fn(),
    stop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    isRunning: false,
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

const defaultTunnelStatus = {
  enabled: false,
  connected: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

// Mock the exposure guard so tunnel-start tests control whether exposure is
// allowed without a live auth DB. `canExpose` defaults to `true` (allowed) so
// the existing success cases pass; the blocked case flips it to `false`.
vi.mock('../../services/core/auth/exposure-guard.js', () => ({
  canExpose: vi.fn(() => true),
  AUTH_REQUIRED_FOR_EXPOSURE: 'AUTH_REQUIRED_FOR_EXPOSURE',
  EXPOSURE_REQUIRES_LOGIN_MESSAGE:
    'Exposing DorkOS requires a login. Create an owner account first.',
}));

import express from 'express';
import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import tunnelRouter from '../tunnel.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { configManager } from '../../services/core/config-manager.js';
import { canExpose } from '../../services/core/auth/exposure-guard.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';

const app = createApp();

/**
 * The tunnel router alone, behind a fixture that stands in for what
 * `sessionGate` resolves onto `res.locals.user`.
 *
 * The full app's gate refuses an unauthenticated caller before the route sees
 * it, so the whole-app request cannot tell "the cookie bar refused this" from
 * "the gate refused this" — an assertion on that path would pass with the bar
 * removed. This mounts the router directly, the way `routes/__tests__/config.ts`
 * tests the identical pair of bars.
 *
 * @param user - The identity to present, or `undefined` for an anonymous caller.
 */
function appWithCaller(user: RequestUser | undefined) {
  const fixture = express();
  fixture.use(express.json());
  fixture.use((_req, res, next) => {
    if (user) res.locals.user = user;
    next();
  });
  fixture.use('/api/tunnel', tunnelRouter);
  return fixture;
}

/**
 * Writable handle on every env value the tunnel route reads.
 *
 * `env` is parsed once at boot, so a test cannot move these by writing to
 * `process.env` after the module loaded — it has to write to the snapshot. Every
 * one of them is set explicitly in `beforeEach` and restored in `afterAll`, so no
 * assertion here moves with whatever the developer running it happens to have
 * exported (the ambient-input trap `lib/__tests__/trusted-origins.test.ts`
 * documents).
 */
const mutableEnv = env as {
  NODE_ENV: 'development' | 'production' | 'test';
  DORKOS_PORT: number;
  TUNNEL_PORT: number | undefined;
  TUNNEL_AUTH: string | undefined;
  TUNNEL_DOMAIN: string | undefined;
  NGROK_AUTHTOKEN: string | undefined;
};
const originalEnv = {
  NODE_ENV: env.NODE_ENV,
  DORKOS_PORT: env.DORKOS_PORT,
  TUNNEL_PORT: env.TUNNEL_PORT,
  TUNNEL_AUTH: env.TUNNEL_AUTH,
  TUNNEL_DOMAIN: env.TUNNEL_DOMAIN,
  NGROK_AUTHTOKEN: env.NGROK_AUTHTOKEN,
};

/** Typed handle to the mocked exposure guard for per-test control. */
const mockCanExpose = vi.mocked(canExpose);

/** Typed helper to mock configManager.get with arbitrary return values. */
const mockConfigGet = vi.mocked(configManager.get) as unknown as ReturnType<typeof vi.fn>;

/**
 * Set the mocked config value for the tunnel route's keys while keeping the
 * `auth` key disabled, so the app-wide session gate (mounted in createApp) is a
 * pass-through in these route tests. A blanket `mockReturnValue` would otherwise
 * feed the tunnel object's `enabled` flag to the gate's `auth.enabled` read.
 */
function setConfig(value: unknown): void {
  mockConfigGet.mockImplementation((key: string) => (key === 'auth' ? undefined : value));
}

/** Typed helper to mock tunnelManager.start with arbitrary implementations. */
const mockTunnelStart = vi.mocked(tunnelManager.start) as unknown as ReturnType<typeof vi.fn>;

/** Every `logger.error` spy installed by a test, restored after it. */
const loggerSpies: { mockRestore: () => void }[] = [];

/**
 * Silence and record `logger.error` for the duration of one test. Restored in
 * `afterEach`, so a swallowed log line can never leak into another test's output.
 */
function spyOnLoggerError() {
  const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
  loggerSpies.push(spy);
  return spy;
}

describe('Tunnel Route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // VITE_PORT is the one port input still read off process.env (by
    // `getLocalCockpitPort`, which owns the only spelling of it), so it is
    // cleared here for the same no-ambient-inputs reason the env snapshot is
    // pinned below.
    delete process.env.VITE_PORT;
    // Non-production (dev mode) by default, so the tunnel resolves to the Vite port.
    mutableEnv.NODE_ENV = 'test';
    mutableEnv.DORKOS_PORT = 4242;
    mutableEnv.TUNNEL_PORT = undefined;
    mutableEnv.TUNNEL_AUTH = undefined;
    mutableEnv.TUNNEL_DOMAIN = undefined;
    mutableEnv.NGROK_AUTHTOKEN = undefined;
    // Default the exposure guard to "allowed" so start-success cases proceed;
    // the blocked-case test overrides this to false.
    mockCanExpose.mockReturnValue(true);

    // Reset status to default, and close any listener a previous test opened.
    (tunnelManager as unknown as Record<string, unknown>).status = { ...defaultTunnelStatus };
    (tunnelManager as unknown as Record<string, unknown>).isRunning = false;
  });

  afterEach(() => {
    while (loggerSpies.length) loggerSpies.pop()?.mockRestore();
  });

  afterAll(() => {
    Object.assign(mutableEnv, originalEnv);
  });

  describe('POST /api/tunnel/start', () => {
    it('returns 200 with URL when NGROK_AUTHTOKEN env var is set and start succeeds', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig(undefined);
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4241,
          startedAt: new Date().toISOString(),
        };
        return 'https://test.ngrok.io';
      });

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(200);
      expect(res.body.url).toBe('https://test.ngrok.io');
      // In dev (NODE_ENV !== 'production'), defaults to Vite's port (4241)
      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ authtoken: 'test-token-123', port: 4241 })
      );
    });

    it('uses Express port in production mode', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      mutableEnv.NODE_ENV = 'production';
      setConfig(undefined);
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://test.ngrok.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        };
        return 'https://test.ngrok.io';
      });

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(200);
      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ authtoken: 'test-token-123', port: 4242 })
      );
    });

    it('follows TUNNEL_PORT when one is set, in dev or production', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      mutableEnv.TUNNEL_PORT = 9999;
      process.env.VITE_PORT = '6241';
      setConfig(undefined);
      mockTunnelStart.mockResolvedValue('https://test.ngrok.io');

      await request(app).post('/api/tunnel/start');

      expect(tunnelManager.start).toHaveBeenCalledWith(expect.objectContaining({ port: 9999 }));
    });

    it('follows VITE_PORT in dev, where Vite serves the UI and proxies /api', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      process.env.VITE_PORT = '6241';
      setConfig(undefined);
      mockTunnelStart.mockResolvedValue('https://test.ngrok.io');

      await request(app).post('/api/tunnel/start');

      expect(tunnelManager.start).toHaveBeenCalledWith(expect.objectContaining({ port: 6241 }));
    });

    it('treats an unparseable VITE_PORT as the default Vite port, not as NaN', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      process.env.VITE_PORT = 'not-a-port';
      setConfig(undefined);
      mockTunnelStart.mockResolvedValue('https://test.ngrok.io');

      await request(app).post('/api/tunnel/start');

      expect(tunnelManager.start).toHaveBeenCalledWith(expect.objectContaining({ port: 4241 }));
    });

    it('returns 400 when no auth token is configured', async () => {
      setConfig(undefined);

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No ngrok auth token configured');
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 409 when tunnel is already running', async () => {
      (tunnelManager as unknown as Record<string, unknown>).isRunning = true;
      (tunnelManager as unknown as Record<string, unknown>).status = {
        ...defaultTunnelStatus,
        enabled: true,
        connected: true,
        url: 'https://already-running.ngrok.io',
      };

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Tunnel is already running');
      expect(res.body.url).toBe('https://already-running.ngrok.io');
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 409, not 500, while a running tunnel is reconnecting (DOR-1738)', async () => {
      // ngrok reports 'closed' on a transient disconnect, which clears
      // `status.connected` while the listener stays open. Gating on
      // `status.connected` therefore let the request through to
      // `tunnelManager.start()`, which threw 'Tunnel is already running' and
      // came back as a 500 — a server error for a tunnel that is fine.
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig(undefined);
      (tunnelManager as unknown as Record<string, unknown>).isRunning = true;
      (tunnelManager as unknown as Record<string, unknown>).status = {
        ...defaultTunnelStatus,
        enabled: true,
        connected: false,
        url: 'https://reconnecting.ngrok.io',
      };

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Tunnel is already running');
      expect(res.body.url).toBe('https://reconnecting.ngrok.io');
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 409 AUTH_REQUIRED_FOR_EXPOSURE when the exposure guard blocks (no login)', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig(undefined);
      mockCanExpose.mockReturnValue(false);

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: 'Exposing DorkOS requires a login. Create an owner account first.',
        code: 'AUTH_REQUIRED_FOR_EXPOSURE',
      });
      // Blocked before any ngrok work — no tunnel is opened.
      expect(tunnelManager.start).not.toHaveBeenCalled();
    });

    it('returns 500 when tunnelManager.start() throws', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig(undefined);
      mockTunnelStart.mockRejectedValue(new Error('Connection failed'));

      const res = await request(app).post('/api/tunnel/start');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Connection failed');
    });

    it('writes the failure to the log, with its stack (DOR-1738)', async () => {
      // The person who hit this in GitHub #1458 raised the log level to debug
      // and still found nothing: the route swallowed the error into a 500 body
      // and never told the log. The response line is one sentence; the log is
      // where the stack that says WHERE it broke can go.
      const logged = spyOnLoggerError();
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig(undefined);
      mockTunnelStart.mockRejectedValue(new Error('failed to bind: ERR_NGROK_108'));

      await request(app).post('/api/tunnel/start');

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('[Tunnel]'),
        expect.objectContaining({
          error: 'failed to bind: ERR_NGROK_108',
          stack: expect.stringContaining('ERR_NGROK_108'),
        })
      );
    });

    it('persists tunnel.enabled: true in config after successful start', async () => {
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      setConfig({
        enabled: false,
        domain: 'my.domain.io',
        authtoken: null,
        auth: null,
      });
      mockTunnelStart.mockImplementation(async () => {
        (tunnelManager as unknown as Record<string, unknown>).status = {
          enabled: true,
          connected: true,
          url: 'https://my.domain.io',
          port: 4242,
          startedAt: new Date().toISOString(),
        };
        return 'https://my.domain.io';
      });

      await request(app).post('/api/tunnel/start');

      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: true })
      );
    });

    it('honors an exported TUNNEL_AUTH the stored config knows nothing about (DOR-1738)', async () => {
      // The route used to read basic auth from the config only, while
      // GET /api/config reports `authEnabled` by ORing in env.TUNNEL_AUTH. So an
      // operator who exported a `user:pass` pair and then pressed the button in
      // the app opened a PUBLIC tunnel with no password on it, and was told auth
      // was on.
      mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
      mutableEnv.TUNNEL_AUTH = 'user:pass';
      mutableEnv.TUNNEL_DOMAIN = 'env.ngrok.app';
      setConfig({ enabled: false, domain: null, authtoken: null, auth: null });
      mockTunnelStart.mockResolvedValue('https://env.ngrok.app');

      await request(app).post('/api/tunnel/start');

      expect(tunnelManager.start).toHaveBeenCalledWith(
        expect.objectContaining({ basicAuth: 'user:pass', domain: 'env.ngrok.app' })
      );
    });

    describe('who may publish this machine', () => {
      // `tunnel.enabled` is operator-only in config-write-policy, and this route
      // writes it directly — so it runs the same two bars PATCH /api/config runs
      // for an operator-only path.

      it('refuses a caller that names itself an agent', async () => {
        mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
        setConfig(undefined);

        const res = await request(app)
          .post('/api/tunnel/start')
          .set('x-dorkos-agent', 'agent-token-abc');

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_only_config');
        expect(tunnelManager.start).not.toHaveBeenCalled();
        expect(configManager.set).not.toHaveBeenCalled();
      });

      it('still allows a plain local caller while login is off', async () => {
        // The residual DOR-505 could not close: with login off the cockpit
        // presents nothing a local program cannot also present, so the agent bar
        // is the only one left and a header-less caller clears it. Pinned so the
        // posture is stated rather than assumed.
        mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
        setConfig(undefined);
        mockTunnelStart.mockResolvedValue('https://test.ngrok.io');

        const res = await request(app).post('/api/tunnel/start');

        expect(res.status).toBe(200);
        expect(tunnelManager.start).toHaveBeenCalled();
      });

      it('refuses a caller holding an API key rather than a session cookie, under login', async () => {
        // Under login-on, a program holding one of the person's per-user API
        // keys is accepted by sessionGate as the same identity a browser proves
        // (DOR-474). It may not publish the machine.
        mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
        mockConfigGet.mockImplementation((key: string) =>
          key === 'auth' ? { enabled: true } : undefined
        );

        const res = await request(appWithCaller({ userId: 'u1', credential: 'api-key' })).post(
          '/api/tunnel/start'
        );

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('operator_cookie_required');
        expect(tunnelManager.start).not.toHaveBeenCalled();
      });

      it('allows a person signed in to the cockpit under login', async () => {
        // The other half of the same bar — without this, the test above would
        // pass just as well if the route refused everyone under login-on.
        mutableEnv.NGROK_AUTHTOKEN = 'test-token-123';
        mockConfigGet.mockImplementation((key: string) =>
          key === 'auth' ? { enabled: true } : undefined
        );
        mockTunnelStart.mockResolvedValue('https://test.ngrok.io');

        const res = await request(appWithCaller({ userId: 'u1', credential: 'cookie' })).post(
          '/api/tunnel/start'
        );

        expect(res.status).toBe(200);
        expect(tunnelManager.start).toHaveBeenCalled();
      });

      it('leaves /stop open to every caller (DOR-574)', async () => {
        // Stopping only ever narrows exposure, so it clears no bars — including
        // for a caller that names itself an agent.
        vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
        setConfig({ enabled: true, domain: null, authtoken: null, auth: null });

        const res = await request(app)
          .post('/api/tunnel/stop')
          .set('x-dorkos-agent', 'agent-token-abc');

        expect(res.status).toBe(200);
        expect(tunnelManager.stop).toHaveBeenCalled();
      });
    });
  });

  describe('GET /api/tunnel/status', () => {
    it('returns current tunnel status', async () => {
      (tunnelManager as unknown as Record<string, unknown>).status = {
        ...defaultTunnelStatus,
        enabled: true,
        connected: true,
        url: 'https://abc.ngrok.io',
      };

      const res = await request(app).get('/api/tunnel/status');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.connected).toBe(true);
      expect(res.body.url).toBe('https://abc.ngrok.io');
    });

    it('returns default status when tunnel is not started', async () => {
      const res = await request(app).get('/api/tunnel/status');

      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.connected).toBe(false);
    });
  });

  describe('POST /api/tunnel/stop', () => {
    it('returns 200 with { ok: true } when stop succeeds', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      setConfig({
        enabled: true,
        domain: null,
        authtoken: null,
        auth: null,
      });

      const res = await request(app).post('/api/tunnel/stop');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(tunnelManager.stop).toHaveBeenCalled();
    });

    it('persists tunnel.enabled: false in config after successful stop', async () => {
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      setConfig({
        enabled: true,
        domain: 'my.domain.io',
        authtoken: null,
        auth: null,
      });

      await request(app).post('/api/tunnel/stop');

      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: false, domain: 'my.domain.io' })
      );
    });

    it('returns 500 when tunnelManager.stop() throws', async () => {
      vi.mocked(tunnelManager.stop).mockRejectedValue(new Error('Disconnect failed'));
      setConfig(undefined);

      const res = await request(app).post('/api/tunnel/stop');

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Disconnect failed');
    });

    it('writes the failure to the log (DOR-1738)', async () => {
      const logged = spyOnLoggerError();
      vi.mocked(tunnelManager.stop).mockRejectedValue(new Error('Disconnect failed'));
      setConfig(undefined);

      await request(app).post('/api/tunnel/stop');

      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('[Tunnel]'),
        expect.objectContaining({ error: 'Disconnect failed' })
      );
    });

    it('always stops the tunnel, even when the exposure guard would block a start (DOR-574)', async () => {
      // An earlier version of this route gated /stop behind canExpose(),
      // mirroring /start. That gate stranded a running tunnel: start it while
      // exposable, disable login afterward, and /stop would 409 forever — the
      // one action that only ever narrows exposure must always succeed.
      vi.mocked(tunnelManager.stop).mockResolvedValue(undefined);
      setConfig({ enabled: true, domain: null, authtoken: null, auth: null });
      mockCanExpose.mockReturnValue(false);

      const res = await request(app).post('/api/tunnel/stop');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(tunnelManager.stop).toHaveBeenCalled();
      expect(configManager.set).toHaveBeenCalledWith(
        'tunnel',
        expect.objectContaining({ enabled: false })
      );
    });
  });
});
