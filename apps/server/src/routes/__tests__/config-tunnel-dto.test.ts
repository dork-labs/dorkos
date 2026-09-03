/**
 * What `GET /api/config` says about Remote Access.
 *
 * The block used to report LIVE STATUS only, which made it lie in two ways that
 * a settings screen has no way to see through (DOR-1738):
 *
 * - A saved custom domain read back as `null` after a restart, because nothing
 *   was running to report one.
 * - `authEnabled` was the live flag ORed with `env.TUNNEL_AUTH`, so a tunnel
 *   that was genuinely open with NO password on it was reported as protected the
 *   moment the operator had that variable exported. That is the worst direction
 *   for this particular lie to point.
 *
 * @module routes/__tests__/config-tunnel-dto
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/** The live tunnel status the route reads; each test sets it. */
const tunnelStatus: Record<string, unknown> = {};

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    get status() {
      return tunnelStatus;
    },
  },
}));

vi.mock('../../lib/boundary.js', () => ({
  getBoundary: () => '/Users/test-user',
  expandTilde: (p: string) => p,
}));

/** The stored `tunnel` section each test presents. */
let storedTunnel: Record<string, unknown> | undefined;

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'tunnel' ? storedTunnel : undefined),
    getDot: () => undefined,
  },
}));

import { env } from '../../env.js';
import configRouter from '../config.js';

/**
 * Writable handle on the env values this block resolves from.
 *
 * The router is imported once, at module scope, rather than re-imported per test
 * behind `vi.resetModules()`: a reset hands the route a FRESH `env` module, and
 * writes to the snapshot this file holds would then reach a different object
 * than the one the route reads — an assertion that silently measures nothing.
 */
const mutableEnv = env as { TUNNEL_AUTH: string | undefined; NGROK_AUTHTOKEN: string | undefined };
const originalEnv = { TUNNEL_AUTH: env.TUNNEL_AUTH, NGROK_AUTHTOKEN: env.NGROK_AUTHTOKEN };

/** A live status with nothing running. */
const NOT_RUNNING = {
  enabled: false,
  connected: false,
  isRunning: false,
  url: null,
  port: null,
  startedAt: null,
  authEnabled: false,
  tokenConfigured: false,
  domain: null,
};

describe('GET /api/config — the tunnel block', () => {
  let app: express.Application;

  beforeEach(() => {
    Object.assign(mutableEnv, { TUNNEL_AUTH: undefined, NGROK_AUTHTOKEN: undefined });
    Object.assign(tunnelStatus, NOT_RUNNING);
    storedTunnel = undefined;

    app = express();
    app.use(express.json());
    app.use('/api/config', configRouter);
  });

  afterEach(() => {
    Object.assign(mutableEnv, originalEnv);
  });

  it('reports the SAVED domain while no tunnel is running', async () => {
    storedTunnel = { enabled: true, domain: 'my.ngrok.app', authtoken: 'tok', auth: null };

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.domain).toBe('my.ngrok.app');
  });

  it('reports the LIVE domain while a tunnel is running, not the saved one', async () => {
    storedTunnel = { enabled: true, domain: 'saved.ngrok.app', authtoken: 'tok', auth: null };
    Object.assign(tunnelStatus, { enabled: true, connected: true, domain: 'live.ngrok.app' });

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.domain).toBe('live.ngrok.app');
  });

  it('says what the setting says as well as what is running', async () => {
    storedTunnel = { enabled: true, domain: null, authtoken: null, auth: null };

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.enabled).toBe(false);
    expect(res.body.tunnel.enabledInConfig).toBe(true);
  });

  it('reports enabledInConfig false when there is no stored tunnel section', async () => {
    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.enabledInConfig).toBe(false);
  });

  it('counts an exported TUNNEL_AUTH as auth, for a tunnel that is not running yet', async () => {
    mutableEnv.TUNNEL_AUTH = 'user:pass';

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.authEnabled).toBe(true);
  });

  it('does NOT claim a running tunnel has a password just because the env has one', async () => {
    // The lie that mattered. The tunnel was opened before the variable was
    // exported (or by a build that ignored it), so it is genuinely open to
    // anyone with the URL — and the operator was told otherwise.
    mutableEnv.TUNNEL_AUTH = 'user:pass';
    Object.assign(tunnelStatus, { enabled: true, connected: true, authEnabled: false });

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.authEnabled).toBe(false);
  });

  it('passes isRunning through, so this block can tell reconnecting from off', async () => {
    // The config DTO spreads the live status, so the field the tunnel route
    // gained has to arrive here too — this is the read the settings screen makes
    // on load, before any SSE frame has landed.
    Object.assign(tunnelStatus, { enabled: true, connected: false, isRunning: true });

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.isRunning).toBe(true);
    expect(res.body.tunnel.connected).toBe(false);
  });

  it('counts a stored token as configured, for a tunnel that is not running yet', async () => {
    storedTunnel = { enabled: false, domain: null, authtoken: 'stored-token', auth: null };

    const res = await request(app).get('/api/config').expect(200);

    expect(res.body.tunnel.tokenConfigured).toBe(true);
  });
});
