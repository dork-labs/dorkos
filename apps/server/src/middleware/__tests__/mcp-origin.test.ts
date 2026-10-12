import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import request from '@dorkos/test-utils/supertest';
import { honoListener, swappableServer } from '@dorkos/test-utils/listening-server';
import type { RequestFactsEnv } from '../../http/request-facts.js';

// Hoist mock so it's available to vi.mock factories (which are hoisted)
const mockTunnelManager = vi.hoisted(() => ({
  status: { url: null as string | null },
}));

// Mock env and tunnelManager before importing the middleware
vi.mock('../../env.js', () => ({
  env: {
    DORKOS_PORT: 4242,
    NODE_ENV: 'test',
    DORKOS_ALLOW_INSECURE_BIND: false,
    DORKOS_TRUSTED_HOSTS: undefined,
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: mockTunnelManager,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined) },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { validateMcpOrigin } from '../mcp-origin.js';

const fixtureTarget = swappableServer();

/** `/mcp`'s guard in front of a route that says it was reached. */
const app = new Hono<RequestFactsEnv>();
app.use('/mcp', validateMcpOrigin);
app.post('/mcp', (c) => c.json({ reached: true }));
const server = fixtureTarget.mount(honoListener(app));

/**
 * Send a request as the middleware reads it: the two headers that decide.
 *
 * `Host` defaults to the loopback address the server listens on, which is what
 * every real request carries. Passing it explicitly is how the DNS-rebinding
 * cases below say what they are.
 */
function send(origin?: string, host = 'localhost:4242') {
  const req = request(server).post('/mcp').set('Host', host);
  return origin === undefined ? req : req.set('Origin', origin);
}

describe('validateMcpOrigin', () => {
  beforeEach(() => {
    mockTunnelManager.status.url = null;
  });

  afterEach(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('allows requests with no Origin header (non-browser clients)', async () => {
    // The load-bearing branch: every MCP client arrives this way. The SDK's HTTP
    // transport sets Authorization, mcp-session-id, mcp-protocol-version, Accept
    // and content-type and nothing else, and Node's fetch adds no Origin — as do
    // DorkOS's own in-process clients on /codex-ui-mcp and the Nango proxy.
    const res = await send();
    expect(res.status).toBe(200);
  });

  it('allows requests from http://localhost:{port}', async () => {
    const res = await send('http://localhost:4242');
    expect(res.status).toBe(200);
  });

  it('allows requests from http://127.0.0.1:{port}', async () => {
    const res = await send('http://127.0.0.1:4242', '127.0.0.1:4242');
    expect(res.status).toBe(200);
  });

  it('allows requests from tunnel origin when tunnel is active', async () => {
    mockTunnelManager.status.url = 'https://my-tunnel.ngrok-free.app';
    const res = await send('https://my-tunnel.ngrok-free.app', 'my-tunnel.ngrok-free.app');
    expect(res.status).toBe(200);
  });

  it('rejects requests from unknown origins with 403', async () => {
    const res = await send('https://evil.com');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Origin https://evil.com not allowed' },
      id: null,
    });
  });

  it('rejects an origin from another process on this machine', async () => {
    // `http://localhost:9999` is some other project's dev server, a docs
    // preview, a notebook. Its hostname matches and its port does not, and the
    // comparison is the whole origin for exactly that reason.
    const res = await send('http://localhost:9999');
    expect(res.status).toBe(403);
  });

  it('rejects tunnel-like origins when tunnel is not active', async () => {
    // tunnelManager.status.url is null (default in beforeEach)
    const res = await send('https://some-tunnel.ngrok-free.app');
    expect(res.status).toBe(403);
  });

  it('rejects the opaque origin `null`, which is not the same as sending none', async () => {
    // A sandboxed iframe, a `data:` document, a `file://` page. It reads like
    // the no-Origin case above and means the opposite.
    const res = await send('null');
    expect(res.status).toBe(403);
  });

  // The rows DOR-1711 unified. Each of these was accepted by `/api` and refused
  // here, because this middleware carried its own allowlist instead of reading
  // the policy every other surface reads.
  describe('reads the one origin policy (DOR-1711)', () => {
    it('accepts the IPv6 loopback literal, which /api already accepted (DOR-553)', async () => {
      const res = await send('http://[::1]:4242', '[::1]:4242');
      expect(res.status).toBe(200);
    });

    it('accepts a remapped host port (docker run -p 4300:4242)', async () => {
      const res = await send('http://localhost:4300', 'localhost:4300');
      expect(res.status).toBe(200);
    });

    it("honours the operator's DORKOS_CORS_ORIGIN allowlist", async () => {
      process.env.DORKOS_CORS_ORIGIN = 'https://dorkos.example.com';
      const res = await send('https://dorkos.example.com', 'localhost:4242');
      expect(res.status).toBe(200);
    });
  });

  // The one thing the same-origin branch must never buy, and the reason `/mcp`
  // pairs it with the host allowlist: `hostGuard` covers `/api` only.
  describe('DNS rebinding stays refused', () => {
    it('refuses a rebound page even though Origin and Host agree', async () => {
      const res = await send('http://evil.example', 'evil.example');
      expect(res.status).toBe(403);
    });

    /**
     * The policy reads the raw `Host`, never a forwarded host a caller can
     * write. On a direct connection the "first proxy" is the caller, so
     * `X-Forwarded-Host` is attacker-written: a guard that preferred it would
     * resolve `localhost`, find the host allowed, and then compare the raw
     * `Host` against the `Origin` — which agree, because that is what DNS
     * rebinding means. The rebound page would get in.
     */
    describe('with a forged forwarded host', () => {
      it('refuses a rebound Host even when X-Forwarded-Host forges localhost', async () => {
        const res = await request(server)
          .post('/mcp')
          .set('Host', 'evil.example')
          .set('X-Forwarded-Host', 'localhost:4242')
          .set('Origin', 'http://evil.example');

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ error: { code: -32002 } });
      });

      it('lets the real thing through, so the refusal above is about the Host', async () => {
        // The positive control. Without it a middleware that refused everything
        // would satisfy the case above.
        const res = await request(server)
          .post('/mcp')
          .set('Host', 'localhost:4242')
          .set('Origin', 'http://localhost:4242');

        expect(res.status).toBe(200);
      });

      it('passes a request with no Origin at all, which is every MCP client', async () => {
        const res = await request(server).post('/mcp').set('Host', 'localhost:4242');

        expect(res.status).toBe(200);
      });
    });
  });
});
