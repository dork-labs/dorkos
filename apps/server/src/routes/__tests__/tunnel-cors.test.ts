import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
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

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

import request from 'supertest';
import { createApp } from '../../app.js';
import { env } from '../../env.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';

const app = createApp();

describe('CORS with tunnel origin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('accepts requests from localhost origins', async () => {
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const res = await request(app).get('/api/health').set('Origin', origin);

    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  // Regression for DOR-241: the desktop dev renderer runs on a distinct Vite
  // origin and the client always fetches with `credentials: 'include'`
  // (auth cookies). Without Access-Control-Allow-Credentials: true, the
  // browser rejects every response even when the origin itself is allowed.
  it('sends Access-Control-Allow-Credentials: true for an allowed origin (trusted-origins callback path)', async () => {
    const origin = `http://localhost:${env.DORKOS_PORT}`;
    const res = await request(app).get('/api/health').set('Origin', origin);

    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('sends Access-Control-Allow-Credentials: true for an allowed origin (DORKOS_CORS_ORIGIN env path)', async () => {
    process.env.DORKOS_CORS_ORIGIN = 'http://localhost:5173';
    const envApp = createApp();

    const res = await request(envApp).get('/api/health').set('Origin', 'http://localhost:5173');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects requests from unknown origins', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts requests from tunnel origin when tunnel is connected', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      enabled: true,
      connected: true,
      url: 'https://abc123.ngrok-free.app',
      port: 4241,
      startedAt: new Date().toISOString(),
      authEnabled: false,
      tokenConfigured: true,
      domain: null,
    };

    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://abc123.ngrok-free.app');

    expect(res.headers['access-control-allow-origin']).toBe('https://abc123.ngrok-free.app');
  });

  it('rejects tunnel origin when tunnel is disconnected', async () => {
    (tunnelManager as unknown as Record<string, unknown>).status = {
      enabled: false,
      connected: false,
      url: null,
      port: null,
      startedAt: null,
      authEnabled: false,
      tokenConfigured: false,
      domain: null,
    };

    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://abc123.ngrok-free.app');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no origin (server-to-server)', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).not.toBe(403);
  });

  // Regression for the Docker host-port-remap bug: with `-p 4300:4242` (or an
  // `ssh -L` forward / reverse proxy) the browser loads the page on the remapped
  // port and requests same-origin assets with that port's Origin, which the
  // container's own `:4242` loopback allowlist does not contain. A request whose
  // Origin equals its own `${protocol}://${host}` is definitionally same-origin
  // and must be allowed without needing DORKOS_CORS_ORIGIN.
  it('accepts a same-origin request when the host port is remapped', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'localhost:9999')
      .set('Origin', 'http://localhost:9999');

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:9999');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects a cross-origin request even when the Host matches the attacker target', async () => {
    // An attacker page at evil.com sends its own Origin with the victim's Host.
    // Same-origin only holds when Origin equals this request's own origin, so
    // this is rejected — the fix adds zero cross-origin exposure.
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'localhost:9999')
      .set('Origin', 'https://evil.com');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a same-host request whose scheme differs (strict full-origin compare)', async () => {
    // Host localhost:9999 over plain http, but Origin claims https — the origins
    // differ by scheme, so this is not same-origin and must be rejected.
    const res = await request(app)
      .get('/api/health')
      .set('Host', 'localhost:9999')
      .set('Origin', 'https://localhost:9999');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('passes a CORS preflight for a remapped same-origin request', async () => {
    // The browser preflights non-simple requests (e.g. POST) before sending
    // them, so the same-origin allowance must hold on OPTIONS too, not just the
    // simple GETs above.
    const res = await request(app)
      .options('/api/health')
      .set('Host', 'localhost:9999')
      .set('Origin', 'http://localhost:9999')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:9999');
  });
});
