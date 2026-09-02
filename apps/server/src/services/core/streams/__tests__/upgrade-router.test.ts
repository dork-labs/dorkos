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
  env: {
    DORKOS_TRUSTED_HOSTS: undefined,
    DORKOS_PUBLIC_URL: undefined,
    DORKOS_PORT: 4242,
    DORKOS_ALLOW_INSECURE_BIND: false,
  },
}));

import { attachUpgradeRouter, type UpgradeRoute } from '../upgrade-router.js';
import { authorizeStreamUpgrade } from '../stream-upgrade-auth.js';
import { resolveTrustedOrigins } from '../../../../lib/trusted-origins.js';
import { env } from '../../../../env.js';
import { configManager } from '../../config-manager.js';

const gate = vi.mocked(authorizeStreamUpgrade);
const loginEnabled = (enabled: boolean): void => {
  vi.mocked(configManager.get).mockReturnValue({ enabled } as never);
};
const mutableEnv = env as {
  DORKOS_TRUSTED_HOSTS?: string;
  DORKOS_PUBLIC_URL?: string;
  DORKOS_ALLOW_INSECURE_BIND?: boolean;
};

/** Stand the suite up as the shipped container does: the flag on. */
const inContainer = (fn: () => Promise<void>): (() => Promise<void>) => {
  return async () => {
    mutableEnv.DORKOS_ALLOW_INSECURE_BIND = true;
    try {
      await fn();
    } finally {
      mutableEnv.DORKOS_ALLOW_INSECURE_BIND = false;
    }
  };
};

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
  loginEnabled(false);
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
      // then covers the port without enumerating it. A TLS-terminating proxy
      // sets `X-Forwarded-Proto`, which pins the scheme to what the browser saw.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);
        const result = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
          'x-forwarded-proto': 'https',
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

  describe('same-origin means the WHOLE origin, not just the hostname', () => {
    // A hostname-only comparison shipped briefly and was a real hole on a
    // default zero-config install: ANY other process on this machine serving a
    // page — a project's dev server, a docs preview, a notebook — has the same
    // hostname as DorkOS and a different port. It would have been handed the
    // global stream, which carries every session's id and cwd, and could then
    // have read the transcripts. Login does not close it: cookies ignore port.
    //
    // Nothing else in this suite pins the comparison, which is exactly how the
    // laxness survived. These do.

    it('REFUSES a page served by another process on the same host, different port', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', {
        origin: 'http://localhost:9999',
        host: 'localhost:4242',
      });

      expect(result.httpStatus, 'a different port is a different origin').toBe(403);
      expect(result.opened).toBe(false);
    });

    it('REFUSES a loopback page on another port, by IP', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', {
        origin: 'http://127.0.0.1:31337',
        host: '127.0.0.1:4242',
      });

      expect(result.httpStatus).toBe(403);
    });

    it('REFUSES an origin carrying credentials that would fool a hostname parse', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', {
        origin: 'http://user:pass@localhost:9999',
        host: 'localhost:4242',
      });

      expect(result.httpStatus).toBe(403);
    });

    it('ACCEPTS the exact origin the request was reached on, port and all', async () => {
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);

        // The proxy terminated TLS and names the scheme it served the browser.
        const result = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
          'x-forwarded-proto': 'https',
        });

        expect(result.opened).toBe(true);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });

    it('pins the scheme to X-Forwarded-Proto when a proxy sets it', async () => {
      // The upgrade's equivalent of `trust proxy: 1`. With the proxy naming the
      // scheme it terminated, the other one stops being accepted.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);

        const matching = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
          'x-forwarded-proto': 'https',
        });
        expect(matching.opened).toBe(true);

        const mismatched = await attempt('/api/accept', {
          origin: 'http://dorkos.example.com',
          host: 'dorkos.example.com',
          'x-forwarded-proto': 'https',
        });
        expect(mismatched.httpStatus, 'the proxy said https; http is not that origin').toBe(403);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });

    it('defaults to the connection scheme when no proxy names one (DOR-932)', async () => {
      // The server binds plain HTTP, so the socket is unencrypted and the scheme
      // defaults to `http`. Without this, an accept-either fallback let an
      // `https` origin — a different server on the same name — open the stream a
      // plaintext page never should. Same single scheme `buildCors` pins.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);

        const plaintext = await attempt('/api/accept', {
          origin: 'http://dorkos.example.com',
          host: 'dorkos.example.com',
        });
        expect(plaintext.opened, 'the plain scheme the socket actually served').toBe(true);

        const secure = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
        });
        expect(secure.httpStatus, 'https on a plaintext socket is a different origin').toBe(403);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });
  });

  describe('the host pairing does not stand down for the container flag', () => {
    // The most serious thing found in this change. `DORKOS_ALLOW_INSECURE_BIND`
    // is set by BOTH Dockerfile targets, and it used to make the same-origin
    // branch inert — so in the shipped image nothing checked the origin at all.
    //
    // For the terminal that was a shell on the host: a page that rebinds DNS to
    // the published address is same-origin to the browser, so CORS never fires;
    // `hostGuard` is inert under the same flag and `sessionGate` passes through
    // with login off, so `POST /api/terminal` mints an id, and the upgrade then
    // attaches to it. It was also WIDER than the hard allowlist the terminal
    // enforced before these streams existed.

    /** A terminal-shaped route: authorized by holding an unguessable id. */
    const bearerRoute: UpgradeRoute = {
      name: 'terminal',
      pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
      credential: 'bearer-of-id',
      authorize: () => ({ ok: true, open: (ws) => ws.send('PTY') }),
    };

    it(
      'REFUSES a rebound origin on the TERMINAL in the shipped container, login off',
      inContainer(async () => {
        // The exact reported scenario: Docker (which sets the flag), no login, a
        // page that rebinds DNS to the published address. If this opens, that
        // page has a shell on the host.
        loginEnabled(false);
        await listen([bearerRoute]);

        const result = await attempt('/api/terminal/abc/socket', {
          origin: 'http://evil.example',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
        expect(result.opened, 'no shell for a rebound page').toBe(false);
      })
    );

    it(
      'REFUSES a rebound origin on the TERMINAL in the container even with login ON',
      inContainer(async () => {
        // A `bearer-of-id` route skips the credential gate entirely, so the
        // origin-scoped cookie the exemption reasons about is never checked and
        // cannot be doing the work the exemption assumes.
        loginEnabled(true);
        await listen([bearerRoute]);

        const result = await attempt('/api/terminal/abc/socket', {
          origin: 'http://evil.example',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
      })
    );

    it(
      'REFUSES a rebound origin on a durable stream in the container, login off',
      inContainer(async () => {
        loginEnabled(false);
        await listen([gatedRoute]);

        const result = await attempt('/api/gated', {
          origin: 'http://evil.example',
          host: 'evil.example',
        });

        expect(result.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 403);
      })
    );

    it(
      'still serves the container its OWN origin — the flag must not break Docker',
      inContainer(async () => {
        // The common shape: `docker run -p 4242:4242`, browsed at localhost.
        // `isHostAllowed` accepts loopback with no configuration at all, so the
        // pairing holds without the operator setting anything.
        loginEnabled(false);
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'http://localhost:4242',
          host: 'localhost:4242',
        });

        expect(result.opened).toBe(true);
      })
    );

    it('stands down ONLY for a credential-gated route with login on', async () => {
      // The one case the stated reason covers: the cookie is origin-scoped, so
      // the rebound page cannot present one and the gate turns it away first.
      loginEnabled(true);
      await listen([gatedRoute]);

      const result = await attempt('/api/gated', {
        origin: 'http://evil.example',
        host: 'evil.example',
      });

      expect(result.opened, 'the credential gate is what stops this one').toBe(true);
    });
  });

  describe('DORKOS_CORS_ORIGIN is honoured no more widely than CORS honours it', () => {
    it('does NOT honour the wildcard, which has no ACAO backstop on a socket', async () => {
      // `*` is tolerable on HTTP only because a wildcard ACAO is invalid for
      // credentialed requests, so browsers reject it whatever the server says.
      // A handshake has no such backstop: cookies attach automatically.
      process.env.DORKOS_CORS_ORIGIN = '*';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', { origin: 'http://evil.example' });

        expect(result.httpStatus).toBe(403);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });

    it('falls back to the other branches under a wildcard rather than refusing everything', async () => {
      // Treating `*` as "no list" must not lock the cockpit out of its own
      // origin — the wildcard is a documented, supported value.
      process.env.DORKOS_CORS_ORIGIN = '*';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', { origin: resolveTrustedOrigins()[0]! });

        expect(result.opened).toBe(true);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });

    it('treats an explicit list as EXHAUSTIVE, with no same-origin fallback', async () => {
      // `buildCors` switches to a static allowlist and drops its own same-origin
      // branch; falling through to branch 4 here would be wider than CORS.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      process.env.DORKOS_CORS_ORIGIN = 'https://only-this.example';
      try {
        await listen([acceptingRoute]);

        const listed = await attempt('/api/accept', { origin: 'https://only-this.example' });
        expect(listed.opened).toBe(true);

        const sameOrigin = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'dorkos.example.com',
        });
        expect(sameOrigin.httpStatus, 'the list is the whole policy').toBe(403);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });

    it('splits and trims exactly as buildCors does', async () => {
      process.env.DORKOS_CORS_ORIGIN = ' https://a.example , https://b.example ';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', { origin: 'https://b.example' });

        expect(result.opened).toBe(true);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });

    it('a padded wildcard denies a stranger, matching HTTP rather than inverting it', async () => {
      // Both surfaces trim before the `=== '*'` check, so `" * "` is read as
      // the wildcard and the wildcard is no list at all. A stranger is still
      // refused — nothing else admits it — and, per the predicate test beside
      // this one, the app's own origin keeps its socket, which an untrimmed
      // read used to take away while HTTP kept working.
      process.env.DORKOS_CORS_ORIGIN = ' * ';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', { origin: 'http://evil.example' });

        expect(result.httpStatus).toBe(403);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });
  });

  describe('opaque origins, and the branch that used to trust them', () => {
    // `Origin: null` is what a browser sends from a sandboxed iframe, a `data:`
    // document or a `file://` page. It is the value most likely to slip through
    // a comparison written for real origins, because `URL.origin` serializes an
    // unparseable URL to the literal string "null" — so a branch built from
    // operator config can hand it a match. One did: `DORKOS_PUBLIC_URL` was
    // consulted unvalidated and unpaired, and `DORKOS_PUBLIC_URL=dorkos:4242`
    // (a plausible typo — `dorkos:` parses as the SCHEME) opened the TERMINAL
    // to any sandboxed page that could reach the port.

    it('REFUSES Origin: null outright', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', { origin: 'null' });

      expect(result.httpStatus).toBe(403);
      expect(result.opened).toBe(false);
    });

    it('REFUSES Origin: null on the terminal even with DORKOS_PUBLIC_URL set to the typo', async () => {
      // The exact reported shape. `DORKOS_PUBLIC_URL` is no longer a trust
      // branch at all, so no value of it can widen anything.
      mutableEnv.DORKOS_PUBLIC_URL = 'dorkos:4242';
      try {
        await listen([
          {
            name: 'terminal',
            pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
            credential: 'bearer-of-id',
            authorize: () => ({ ok: true, open: (ws) => ws.send('PTY') }),
          },
        ]);

        const result = await attempt('/api/terminal/abc/socket', {
          origin: 'null',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
        expect(result.firstFrame, 'no PTY for an opaque origin').toBeUndefined();
      } finally {
        mutableEnv.DORKOS_PUBLIC_URL = undefined;
      }
    });

    it('does NOT trust an origin just because DORKOS_PUBLIC_URL names it', async () => {
      // It outranked the operator's own CORS list and was never paired with
      // `Host`. An operator who needs a name uses DORKOS_TRUSTED_HOSTS.
      mutableEnv.DORKOS_PUBLIC_URL = 'https://public.example';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'https://public.example',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
      } finally {
        mutableEnv.DORKOS_PUBLIC_URL = undefined;
      }
    });

    it('still passes a request with NO Origin — absent and null are opposites', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept');

      expect(result.opened).toBe(true);
    });
  });

  describe('the container reaches itself at its LAN address', () => {
    // The other half of the container decision. `hostGuard` stands down for the
    // flag, so REST works at any Host — and requiring `isHostAllowed` on the
    // socket meant a NAS/homelab/VPS running the shipped image had a cockpit
    // that rendered, ran turns, and never showed a reply. The earlier container
    // test only exercised `localhost`, the one address that already worked.

    it('ACCEPTS an IP-literal Host under the flag, which rebinding cannot forge', async () => {
      mutableEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      try {
        loginEnabled(false);
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'http://192.168.1.50:4242',
          host: '192.168.1.50:4242',
        });

        expect(result.opened).toBe(true);
      } finally {
        mutableEnv.DORKOS_ALLOW_INSECURE_BIND = false;
      }
    });

    it('ACCEPTS the bind-address spelling too', async () => {
      mutableEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'http://0.0.0.0:4242',
          host: '0.0.0.0:4242',
        });

        expect(result.opened).toBe(true);
      } finally {
        mutableEnv.DORKOS_ALLOW_INSECURE_BIND = false;
      }
    });

    it('still REFUSES a NAME under the flag — that is the rebinding case', async () => {
      mutableEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'http://evil.example',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
      } finally {
        mutableEnv.DORKOS_ALLOW_INSECURE_BIND = false;
      }
    });

    it('REFUSES an IP-literal Host when the flag is NOT set', async () => {
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', {
        origin: 'http://192.168.1.50:4242',
        host: '192.168.1.50:4242',
      });

      expect(result.httpStatus).toBe(403);
    });

    it('REFUSES a name-based Host on the TERMINAL under the flag', async () => {
      mutableEnv.DORKOS_ALLOW_INSECURE_BIND = true;
      try {
        await listen([
          {
            name: 'terminal',
            pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
            credential: 'bearer-of-id',
            authorize: () => ({ ok: true, open: (ws) => ws.send('PTY') }),
          },
        ]);

        const result = await attempt('/api/terminal/abc/socket', {
          origin: 'http://evil.example',
          host: 'evil.example',
        });

        expect(result.httpStatus).toBe(403);
      } finally {
        mutableEnv.DORKOS_ALLOW_INSECURE_BIND = false;
      }
    });
  });

  describe('the comparison is normalized, and a missing Host fails closed', () => {
    // Gaps the review's mutation table found: each of these stayed green when
    // the behaviour was removed, which means nothing was pinning it.

    it('REFUSES when the Host header is missing entirely', async () => {
      // HTTP/1.1 requires one; a request without it cannot be same-origin with
      // anything, and "no host" must not read as "any host".
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);

        // `ws` always sets Host from the URL, so the empty value is forced.
        const result = await attempt('/api/accept', {
          origin: 'http://dorkos.example.com',
          host: '',
        });

        expect(result.opened).toBe(false);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });

    it('matches an uppercase Host against a lower-case Origin', async () => {
      // A browser lower-cases `Origin`; `Host` carries whatever was typed.
      // Without normalization the legitimate deployment silently 403s.
      mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
      try {
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'https://dorkos.example.com',
          host: 'DorkOS.Example.COM',
          'x-forwarded-proto': 'https',
        });

        expect(result.opened).toBe(true);
      } finally {
        mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
      }
    });
  });
});
