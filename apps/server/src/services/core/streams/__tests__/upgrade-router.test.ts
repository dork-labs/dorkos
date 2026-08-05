import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';

vi.mock('../../tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../config-manager.js', () => ({
  configManager: { get: vi.fn(() => ({ enabled: false })) },
}));

vi.mock('../stream-upgrade-auth.js', () => ({
  authorizeStreamUpgrade: vi.fn(),
}));

// `env` is validated once at import, so a late `process.env` write would not
// reach `DORKOS_TRUSTED_HOSTS` — the tests set it through the module instead.
vi.mock('../../../../env.js', () => ({
  env: { DORKOS_TRUSTED_HOSTS: undefined, DORKOS_PUBLIC_URL: undefined, DORKOS_PORT: 4242 },
}));

import { attachUpgradeRouter, type UpgradeRoute } from '../upgrade-router.js';
import { authorizeStreamUpgrade } from '../stream-upgrade-auth.js';
import { resolveTrustedOrigins } from '../../../../lib/trusted-origins.js';
import { env } from '../../../../env.js';

const gate = vi.mocked(authorizeStreamUpgrade);
const mutableEnv = env as { DORKOS_TRUSTED_HOSTS?: string; DORKOS_PUBLIC_URL?: string };

/**
 * Upgrade-router tests.
 *
 * This is the file that stands in for `sessionGate` and the CORS policy on the
 * socket path — a WebSocket upgrade never touches Express, so nothing else in
 * the middleware chain runs for it. Two properties here are security
 * properties rather than behaviour: the DNS-rebinding Origin guard applies to
 * EVERY route (it used to live inside the terminal's own decision, and its test
 * moved here with it), and a route's refusal is never silently upgraded into an
 * open socket.
 */

let server: Server;
let port: number;

/** Stand up a server with `routes` attached and return its port. */
async function listen(routes: UpgradeRoute[]): Promise<void> {
  server = createServer((_req, res) => res.end('ok'));
  attachUpgradeRouter(server, routes);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

/** The outcome of one upgrade attempt, from the client's side. */
interface Attempt {
  /** Set when the handshake completed and the socket then closed. */
  closeCode?: number;
  /** Set when the handshake itself was refused, with its HTTP status. */
  httpStatus?: number;
  /** Whether the socket opened at all. */
  opened: boolean;
  /** First text frame received, when one arrived before close. */
  firstFrame?: string;
}

/**
 * How long to let a successfully-opened socket run before reporting.
 *
 * An accepted upgrade never ends on its own, so the settle has to be a timer.
 * It also gives a close-frame refusal — which opens and then immediately closes
 * — time to arrive, so the two outcomes are told apart by what happened rather
 * than by which raced.
 */
const SETTLE_MS = 150;

/** Attempt one upgrade and report how the server answered. */
function attempt(path: string, headers: Record<string, string> = {}): Promise<Attempt> {
  return new Promise((resolve) => {
    const result: Attempt = { opened: false };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    ws.on('open', () => {
      result.opened = true;
      timer = setTimeout(finish, SETTLE_MS);
    });
    ws.on('message', (raw: Buffer) => {
      result.firstFrame ??= raw.toString('utf8');
    });
    // `ws` surfaces a refused handshake here, with the real HTTP response —
    // which is exactly what a browser cannot see, and why durable streams
    // refuse with a close code instead.
    ws.on('unexpected-response', (_req, res) => {
      result.httpStatus = res.statusCode;
      res.resume();
      finish();
    });
    ws.on('close', (code: number) => {
      result.closeCode = code;
      finish();
    });
    ws.on('error', () => {
      // A destroyed socket surfaces as an error with no response; `close`
      // follows and settles. Nothing to record here.
    });
  });
}

/** A route that accepts and immediately sends one frame, so "opened" is observable. */
const acceptingRoute: UpgradeRoute = {
  name: 'accepting',
  pattern: /^\/api\/accept$/,
  credential: 'bearer-of-id',
  authorize: () => ({ ok: true, open: (ws) => ws.send('hello') }),
};

/** A route that refuses over the handshake (the terminal's posture). */
const handshakeRefusalRoute: UpgradeRoute = {
  name: 'handshake-refusal',
  pattern: /^\/api\/refuse-handshake$/,
  credential: 'bearer-of-id',
  authorize: () => ({ ok: false, status: 404, message: 'Not Found' }),
};

/** A route that refuses over a close frame (the durable streams' posture). */
const closeFrameRefusalRoute: UpgradeRoute = {
  name: 'close-frame-refusal',
  pattern: /^\/api\/refuse-close$/,
  credential: 'bearer-of-id',
  authorize: () => ({ ok: false, status: 401, message: 'Unauthorized', deliver: 'close-frame' }),
};

/** A credential-gated route, the posture all three durable streams declare. */
const gatedRoute: UpgradeRoute = {
  name: 'gated',
  pattern: /^\/api\/gated$/,
  credential: 'required',
  authorize: ({ locals }) => ({
    ok: true,
    open: (ws) => ws.send(JSON.stringify(locals)),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.mockResolvedValue({ ok: true, locals: {} });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('attachUpgradeRouter', () => {
  it('routes an upgrade to the first route whose pattern matches the path', async () => {
    await listen([acceptingRoute]);

    const result = await attempt('/api/accept');

    expect(result.opened).toBe(true);
    expect(result.firstFrame).toBe('hello');
  });

  it('destroys an upgrade no route claims, saying nothing', async () => {
    await listen([acceptingRoute]);

    const result = await attempt('/api/nothing-here');

    expect(result.opened).toBe(false);
    // Silence rather than a status: the upgrade is not addressed to us, and
    // answering only tells a scanner what is here. 1006 is the browser/`ws`
    // code for "closed without a close frame".
    expect(result.httpStatus).toBeUndefined();
  });

  it('lets a request with NO Origin through (non-browser clients)', async () => {
    await listen([acceptingRoute]);

    const result = await attempt('/api/accept');

    expect(result.opened).toBe(true);
  });

  it('lets a request with a trusted Origin through', async () => {
    await listen([acceptingRoute]);

    const result = await attempt('/api/accept', { origin: resolveTrustedOrigins()[0]! });

    expect(result.opened).toBe(true);
  });

  it('refuses an untrusted Origin with 403 before the route is consulted', async () => {
    // The DNS-rebinding guard. A WebSocket handshake is NOT CORS-protected: any
    // page can open a socket to any host its user can reach, and the browser
    // attaches that host's cookies. `Origin` is the only thing separating a
    // cockpit tab from a hostile page that rebound onto this port.
    const authorize = vi.fn(() => ({ ok: true as const, open: () => {} }));
    await listen([
      { name: 'guarded', pattern: /^\/api\/accept$/, credential: 'bearer-of-id', authorize },
    ]);

    const result = await attempt('/api/accept', { origin: 'http://evil.example' });

    expect(result.httpStatus).toBe(403);
    expect(result.opened).toBe(false);
    expect(authorize, 'the route never even ran').not.toHaveBeenCalled();
  });

  it('refuses an untrusted Origin on the terminal path', async () => {
    // This case used to live in `terminal-websocket.test.ts`, where the terminal
    // checked Origin itself. It moved here with the check. Keeping it means the
    // guard on the code-execution surface is still pinned by a test that fails
    // if the router stops applying it.
    const terminalish: UpgradeRoute = {
      name: 'terminal',
      pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
      credential: 'bearer-of-id',
      authorize: () => ({ ok: true, open: (ws) => ws.send('pty') }),
    };
    await listen([terminalish]);

    const refused = await attempt('/api/terminal/abc/socket', { origin: 'http://evil.example' });
    expect(refused.httpStatus).toBe(403);

    const allowed = await attempt('/api/terminal/abc/socket', {
      origin: resolveTrustedOrigins()[0]!,
    });
    expect(allowed.opened).toBe(true);
  });

  it("delivers a route's handshake refusal as its HTTP status", async () => {
    await listen([handshakeRefusalRoute]);

    const result = await attempt('/api/refuse-handshake');

    expect(result.httpStatus).toBe(404);
    expect(result.opened).toBe(false);
  });

  it("delivers a route's close-frame refusal as an application close code", async () => {
    // The durable streams need this: a browser cannot read the status of a
    // FAILED handshake, so a refusal delivered that way is indistinguishable
    // from the server being down — and the room stream stops retrying on one
    // and retries forever on the other.
    await listen([closeFrameRefusalRoute]);

    const result = await attempt('/api/refuse-close');

    expect(result.opened, 'the handshake completes so the reason can be sent').toBe(true);
    expect(result.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
    expect(result.httpStatus).toBeUndefined();
  });

  it('refuses with 500 when a route throws rather than leaking the socket open', async () => {
    await listen([
      {
        name: 'exploding',
        pattern: /^\/api\/boom$/,
        credential: 'bearer-of-id',
        authorize: () => {
          throw new Error('authorize exploded');
        },
      },
    ]);

    const result = await attempt('/api/boom');

    expect(result.httpStatus).toBe(500);
    expect(result.opened).toBe(false);
  });

  it('tries routes in registration order and stops at the first match', async () => {
    const second = vi.fn(() => ({ ok: true as const, open: () => {} }));
    await listen([
      acceptingRoute,
      {
        name: 'shadowed',
        pattern: /^\/api\/accept$/,
        credential: 'bearer-of-id',
        authorize: second,
      },
    ]);

    const result = await attempt('/api/accept');

    expect(result.firstFrame).toBe('hello');
    expect(second).not.toHaveBeenCalled();
  });

  describe("the credential gate is the ROUTER's job, not each route's", () => {
    // It lives here because when each route called it, deleting all three calls
    // left the whole server suite green: the gate was tested, its WIRING was
    // not — and the wiring is the part an exploit uses.

    it('runs the gate for a `required` route and hands it the resolved identity', async () => {
      gate.mockResolvedValue({
        ok: true,
        locals: { user: { userId: 'user-1', credential: 'cookie' } },
      });
      await listen([gatedRoute]);

      const result = await attempt('/api/gated');

      expect(gate).toHaveBeenCalledTimes(1);
      expect(result.opened).toBe(true);
      expect(JSON.parse(result.firstFrame!), 'the route acts as whoever the gate resolved').toEqual(
        { user: { userId: 'user-1', credential: 'cookie' } }
      );
    });

    it('REFUSES a `required` route when the gate says no, without consulting it', async () => {
      gate.mockResolvedValue({ ok: false, status: 401, message: 'Unauthorized' });
      const authorize = vi.fn(() => ({ ok: true as const, open: () => {} }));
      await listen([
        { name: 'gated', pattern: /^\/api\/gated$/, credential: 'required', authorize },
      ]);

      const result = await attempt('/api/gated');

      expect(authorize, 'the route never ran').not.toHaveBeenCalled();
      // Over a close frame, because a browser cannot read a failed handshake.
      expect(result.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
    });

    it('does NOT run the gate for a `bearer-of-id` route', async () => {
      // The terminal authenticates by holding an unguessable id; gating it again
      // would change a shipped contract (ADR 260708-185521).
      await listen([acceptingRoute]);

      await attempt('/api/accept');

      expect(gate).not.toHaveBeenCalled();
    });
  });

  describe('origin policy beyond loopback', () => {
    // The first version of this guard was `resolveTrustedOrigins().includes()`,
    // which is loopback + tunnel only. Every non-loopback deployment 403'd on
    // every socket while HTTP kept working — and the cockpit showed nothing,
    // because a browser cannot read a failed handshake. These pin the branches
    // that fix it.

    it('accepts an Origin that matches the request Host it was reached on', async () => {
      // The reverse-proxy / LAN-IP / https case: the operator lists the host in
      // DORKOS_TRUSTED_HOSTS (as the proxy docs already say), and same-origin
      // then covers every scheme and port without enumerating them.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);
        const result = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
        });
        expect(result.opened).toBe(true);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });

    it('accepts an Origin the operator listed in DORKOS_CORS_ORIGIN', async () => {
      // The HTTP path already honours this; a socket refusing what a request
      // accepts is the inconsistency that made the outage silent.
      process.env.DORKOS_CORS_ORIGIN = 'https://cockpit.example.com,https://other.example';
      try {
        await listen([acceptingRoute]);
        const result = await attempt('/api/accept', { origin: 'https://cockpit.example.com' });
        expect(result.opened).toBe(true);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });

    it('still REFUSES a rebound Origin whose Host this instance does not answer to', async () => {
      // The DNS-rebinding case the same-origin branch would otherwise admit:
      // evil.com resolves to 127.0.0.1, so Origin and Host agree — and the host
      // allowlist is what rejects it, exactly as `hostGuard` does for requests.
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', {
        origin: 'http://evil.example',
        host: 'evil.example',
      });

      expect(result.httpStatus).toBe(403);
      expect(result.opened).toBe(false);
    });
  });
});
