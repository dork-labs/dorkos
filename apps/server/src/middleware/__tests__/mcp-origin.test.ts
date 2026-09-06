import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

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

/**
 * A request as the middleware reads it: the two headers that decide, and a
 * socket, because the shared fact resolver asks whether this connection is
 * itself TLS (it never is — the server binds plain HTTP).
 *
 * `Host` defaults to the loopback address the server listens on, which is what
 * every real request carries. Passing it explicitly is how the DNS-rebinding
 * cases below say what they are.
 */
function createMockReq(origin?: string, host = 'localhost:4242'): Partial<Request> {
  return {
    headers: { ...(origin === undefined ? {} : { origin }), host },
    socket: {} as Request['socket'],
  };
}

function createMockRes(): Partial<Response> & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn().mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  }) as unknown as Response['json'];
  return res;
}

describe('validateMcpOrigin', () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
    mockTunnelManager.status.url = null;
  });

  afterEach(() => {
    delete process.env.DORKOS_CORS_ORIGIN;
  });

  it('allows requests with no Origin header (non-browser clients)', () => {
    // The load-bearing branch: every MCP client arrives this way. The SDK's HTTP
    // transport sets Authorization, mcp-session-id, mcp-protocol-version, Accept
    // and content-type and nothing else, and Node's fetch adds no Origin — as do
    // DorkOS's own in-process clients on /codex-ui-mcp and the Nango proxy.
    const req = createMockReq();
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from http://localhost:{port}', () => {
    const req = createMockReq('http://localhost:4242');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from http://127.0.0.1:{port}', () => {
    const req = createMockReq('http://127.0.0.1:4242', '127.0.0.1:4242');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests from tunnel origin when tunnel is active', () => {
    mockTunnelManager.status.url = 'https://my-tunnel.ngrok-free.app';
    const req = createMockReq('https://my-tunnel.ngrok-free.app', 'my-tunnel.ngrok-free.app');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects requests from unknown origins with 403', () => {
    const req = createMockReq('https://evil.com');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32002, message: 'Origin https://evil.com not allowed' },
      id: null,
    });
  });

  it('rejects an origin from another process on this machine', () => {
    // `http://localhost:9999` is some other project's dev server, a docs
    // preview, a notebook. Its hostname matches and its port does not, and the
    // comparison is the whole origin for exactly that reason.
    const req = createMockReq('http://localhost:9999');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects tunnel-like origins when tunnel is not active', () => {
    // tunnelManager.status.url is null (default in beforeEach)
    const req = createMockReq('https://some-tunnel.ngrok-free.app');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('rejects the opaque origin `null`, which is not the same as sending none', () => {
    // A sandboxed iframe, a `data:` document, a `file://` page. It reads like
    // the no-Origin case above and means the opposite.
    const req = createMockReq('null');
    const res = createMockRes();
    validateMcpOrigin(req as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  // The rows DOR-1711 unified. Each of these was accepted by `/api` and refused
  // here, because this middleware carried its own allowlist instead of reading
  // the policy every other surface reads.
  describe('reads the one origin policy (DOR-1711)', () => {
    it('accepts the IPv6 loopback literal, which /api already accepted (DOR-553)', () => {
      const req = createMockReq('http://[::1]:4242', '[::1]:4242');
      const res = createMockRes();
      validateMcpOrigin(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it('accepts a remapped host port (docker run -p 4300:4242)', () => {
      const req = createMockReq('http://localhost:4300', 'localhost:4300');
      const res = createMockRes();
      validateMcpOrigin(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });

    it("honours the operator's DORKOS_CORS_ORIGIN allowlist", () => {
      process.env.DORKOS_CORS_ORIGIN = 'https://dorkos.example.com';
      const req = createMockReq('https://dorkos.example.com', 'localhost:4242');
      const res = createMockRes();
      validateMcpOrigin(req as Request, res as Response, next);
      expect(next).toHaveBeenCalled();
    });
  });

  // The one thing the same-origin branch must never buy, and the reason these
  // mounts pair it with the host allowlist: `hostGuard` covers `/api` only, and
  // two of the three MCP mounts are not under `/api` at all.
  describe('DNS rebinding stays refused', () => {
    it('refuses a rebound page even though Origin and Host agree', () => {
      const req = createMockReq('http://evil.example', 'evil.example');
      const res = createMockRes();
      validateMcpOrigin(req as Request, res as Response, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    });

    /**
     * Driven through a REAL Express app, because the hand-built request above
     * cannot answer this question.
     *
     * The claim is that the policy reads the raw `Host` rather than Express's
     * `req.hostname`, which `trust proxy, 1` makes prefer `X-Forwarded-Host` —
     * and on a direct connection the "first proxy" is the caller, so that getter
     * is attacker-written. A literal object has no `hostname` at all, so a
     * version of the middleware that read it would get `undefined`, refuse, and
     * pass the test while being exactly the bug it claims to exclude (measured:
     * the reviewer switched the implementation over and the mock-based test
     * stayed green).
     *
     * On a real app the mutation is fatal: `req.hostname` resolves to
     * `localhost`, `isHostAllowed` says yes, the pairing holds, and branch 4
     * then compares the raw `Host` against the `Origin` — which agree, because
     * that is what DNS rebinding means. The rebound page gets in.
     */
    describe('through a real Express app, with trust proxy set as production sets it', () => {
      /** `/mcp`'s guard on an app configured the way `createApp` configures it. */
      function mcpApp(): express.Express {
        const app = express();
        app.set('trust proxy', 1);
        app.use('/mcp', validateMcpOrigin, (_req, res) => {
          res.status(200).json({ reached: true });
        });
        return app;
      }

      it('refuses a rebound Host even when X-Forwarded-Host forges localhost', async () => {
        const res = await request(fixtureTarget.mount(mcpApp()))
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
        const res = await request(fixtureTarget.mount(mcpApp()))
          .post('/mcp')
          .set('Host', 'localhost:4242')
          .set('Origin', 'http://localhost:4242');

        expect(res.status).toBe(200);
      });

      it('passes a request with no Origin at all, which is every MCP client', async () => {
        const res = await request(fixtureTarget.mount(mcpApp()))
          .post('/mcp')
          .set('Host', 'localhost:4242');

        expect(res.status).toBe(200);
      });
    });
  });
});
