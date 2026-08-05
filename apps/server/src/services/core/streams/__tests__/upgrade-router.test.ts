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

import { attachUpgradeRouter, type UpgradeRoute } from '../upgrade-router.js';
import { resolveTrustedOrigins } from '../../../../lib/trusted-origins.js';

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
  authorize: () => ({ ok: true, open: (ws) => ws.send('hello') }),
};

/** A route that refuses over the handshake (the terminal's posture). */
const handshakeRefusalRoute: UpgradeRoute = {
  name: 'handshake-refusal',
  pattern: /^\/api\/refuse-handshake$/,
  authorize: () => ({ ok: false, status: 404, message: 'Not Found' }),
};

/** A route that refuses over a close frame (the durable streams' posture). */
const closeFrameRefusalRoute: UpgradeRoute = {
  name: 'close-frame-refusal',
  pattern: /^\/api\/refuse-close$/,
  authorize: () => ({ ok: false, status: 401, message: 'Unauthorized', deliver: 'close-frame' }),
};

beforeEach(() => {
  vi.clearAllMocks();
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
    await listen([{ name: 'guarded', pattern: /^\/api\/accept$/, authorize }]);

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
      { name: 'shadowed', pattern: /^\/api\/accept$/, authorize: second },
    ]);

    const result = await attempt('/api/accept');

    expect(result.firstFrame).toBe('hello');
    expect(second).not.toHaveBeenCalled();
  });
});
