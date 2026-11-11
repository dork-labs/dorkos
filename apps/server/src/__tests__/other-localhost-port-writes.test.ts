/**
 * DOR-3370: a page on another port of this computer is same-site with DorkOS
 * (cookies and `SameSite` ignore the port), so the origin check is what keeps
 * it from writing. Each case POSTs a real write route through the composed
 * server and checks the route never ran, against a same-port control that does.
 */
import { MainRequestAdmission } from '../services/core/lifecycle/main-request-admission.js';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

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
  configManager: { get: vi.fn(), set: vi.fn() },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The write the route makes: stood in for so "nothing was written" is a fact
// the test can read rather than infer from a status code.
const captureClientError = vi.fn(async (_body: unknown) => {});
vi.mock('../services/core/error-reporter.js', () => ({
  captureClientError: (body: unknown) => captureClientError(body),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { composedListener } from '../http/__tests__/composed-listener.js';
import { env } from '../env.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

// Building the composed server is slow on a loaded machine (see
// app-security-headers.test.ts for the measurement).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PORT = env.DORKOS_PORT;
const HOST = `localhost:${PORT}`;
const OTHER_PORT = PORT + 1357;

beforeAll(() => {
  fixtureTarget.mount(composedListener(new MainRequestAdmission()));
});

beforeEach(() => {
  captureClientError.mockClear();
});

describe('writes from another port on this computer (DOR-3370)', () => {
  it('lets this app’s own page write (the control)', async () => {
    const res = await request(fixtureServer)
      .post('/api/errors')
      .set('Host', HOST)
      .set('Origin', `http://${HOST}`)
      .send({ name: 'Error', message: 'control' });

    expect(res.status).toBe(202);
    expect(captureClientError).toHaveBeenCalledTimes(1);
  });

  it.each([
    `http://localhost:${OTHER_PORT}`,
    `http://127.0.0.1:${OTHER_PORT}`,
    `http://[::1]:${OTHER_PORT}`,
    `https://localhost:${PORT}`,
  ])('refuses a fetch write from %s, and writes nothing', async (origin) => {
    const res = await request(fixtureServer)
      .post('/api/errors')
      .set('Host', HOST)
      .set('Origin', origin)
      .send({ name: 'Error', message: 'from another port' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(captureClientError).not.toHaveBeenCalled();
  });

  it('refuses a plain HTML form post from another port, which skips the preflight', async () => {
    const res = await request(fixtureServer)
      .post('/api/errors')
      .set('Host', HOST)
      .set('Origin', `http://localhost:${OTHER_PORT}`)
      .set('Content-Type', 'text/plain')
      .send('{"name":"Error","message":"form"}');

    expect(res.status).toBe(403);
    expect(captureClientError).not.toHaveBeenCalled();
  });

  it('refuses the preflight too, so the browser never sends the write', async () => {
    const res = await request(fixtureServer)
      .options('/api/errors')
      .set('Host', HOST)
      .set('Origin', `http://localhost:${OTHER_PORT}`)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(captureClientError).not.toHaveBeenCalled();
  });

  it('refuses a page that claims an opaque origin (a sandboxed frame or a file)', async () => {
    const res = await request(fixtureServer)
      .post('/api/errors')
      .set('Host', HOST)
      .set('Origin', 'null')
      .send({ name: 'Error', message: 'opaque' });

    expect(res.status).toBe(403);
    expect(captureClientError).not.toHaveBeenCalled();
  });
});
