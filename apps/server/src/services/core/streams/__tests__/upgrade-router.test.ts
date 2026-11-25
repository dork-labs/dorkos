import { MainRequestAdmission } from '../../lifecycle/main-request-admission.js';
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
  // Login (`auth`) off; Remote Access (`remoteAccess`) on, as it ships (DOR-3650).
  configManager: {
    get: vi.fn((key: string) => ({ enabled: key === 'remoteAccess' })),
  },
}));

// Only the credential check is stubbed: `upgradeFacts` stays real, so the
// router's host pairing reads the same facts the gate does.
vi.mock('../stream-upgrade-auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stream-upgrade-auth.js')>()),
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
import { env } from '../../../../env.js';
import { configManager } from '../../config-manager.js';
import { markIngress, setManagedUpgradeListener } from '../../remote/ingress-mark.js';
import {
  closeRemoteStreams,
  resetRemoteStreamsForTests,
} from '../../../../middleware/remote-access-switch.js';

const gate = vi.mocked(authorizeStreamUpgrade);
const loginEnabled = (enabled: boolean): void => {
  vi.mocked(configManager.get).mockImplementation(
    (key: string) => ({ enabled: key === 'remoteAccess' ? true : enabled }) as never
  );
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

let server: Server;
let port: number;

/** Stand up a server with `routes` attached and return its port. */
async function listen(routes: UpgradeRoute[]): Promise<void> {
  server = createServer((_req, res) => res.end('ok'));
  attachUpgradeRouter(server, routes, new MainRequestAdmission());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}

/** The outcome of one upgrade attempt, from the client's side. */
interface Attempt {
  /** Close code once an opened socket closed. */
  closeCode?: number;
  /** HTTP status of a refused handshake. */
  httpStatus?: number;
  opened: boolean;
  firstFrame?: string;
}

/** How long an opened socket runs before reporting, so a close-frame refusal can arrive. */
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

/** A page that rebound DNS to this computer: Origin and Host agree, on a name we do not serve. */
const REBOUND = { origin: 'http://evil.example', host: 'evil.example' };

/** A terminal-shaped route: authorized by holding an unguessable id. */
const bearerRoute: UpgradeRoute = {
  name: 'terminal',
  pattern: /^\/api\/terminal\/([^/]+)\/socket$/,
  credential: 'bearer-of-id',
  authorize: () => ({ ok: true, open: (ws) => ws.send('PTY') }),
};

/** Run `fn` with `DORKOS_TRUSTED_HOSTS` set to the one name these tests serve. */
async function withTrustedHost(fn: () => Promise<void>): Promise<void> {
  mutableEnv.DORKOS_TRUSTED_HOSTS = 'dorkos.example.com';
  try {
    await fn();
  } finally {
    mutableEnv.DORKOS_TRUSTED_HOSTS = undefined;
  }
}

// This file stands in for `sessionGate` and CORS on the socket path. The origin
// policy itself is pinned in `lib/__tests__/trusted-origins-browser.test.ts`;
// here, only the router's wiring of it, and that a refusal never opens a socket.
describe('attachUpgradeRouter', () => {
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

    expect(result.opened).toBe(true);
    expect(result.firstFrame).toBe('hello');
    expect(second).not.toHaveBeenCalled();
    // A `bearer-of-id` route (the terminal, ADR 260708-185521) skips the credential gate.
    expect(gate).not.toHaveBeenCalled();
  });

  it('destroys an upgrade no route claims, saying nothing', async () => {
    await listen([acceptingRoute]);

    const result = await attempt('/api/nothing-here');

    expect(result.opened).toBe(false);
    // Silence rather than a status: answering only tells a scanner what is here.
    expect(result.httpStatus).toBeUndefined();
  });

  it('refuses an untrusted Origin with 403 before the route is consulted', async () => {
    // The DNS-rebinding guard. A WebSocket handshake is NOT CORS-protected, so
    // `Origin` is the only thing separating an app tab from a hostile page.
    const authorize = vi.fn(() => ({ ok: true as const, open: () => {} }));
    await listen([
      { name: 'guarded', pattern: /^\/api\/accept$/, credential: 'bearer-of-id', authorize },
    ]);

    const result = await attempt('/api/accept', { origin: 'http://evil.example' });

    expect(result.httpStatus).toBe(403);
    expect(result.opened).toBe(false);
    expect(authorize, 'the route never even ran').not.toHaveBeenCalled();
    expect((await attempt('/api/accept')).opened, 'no Origin is a non-browser client').toBe(true);
  });

  it("delivers a route's handshake refusal as its HTTP status", async () => {
    await listen([handshakeRefusalRoute]);

    const result = await attempt('/api/refuse-handshake');

    expect(result.httpStatus).toBe(404);
    expect(result.opened).toBe(false);
  });

  it("delivers a route's close-frame refusal as an application close code", async () => {
    // A browser cannot read the status of a FAILED handshake, so the durable
    // streams need the reason over a close frame.
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

  describe("the credential gate is the ROUTER's job, not each route's", () => {
    // When each route called it, deleting all three calls left every test green.
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
      expect(result.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
    });
  });

  describe('managed remote access counts an upgrade only once it is accepted', () => {
    afterEach(() => setManagedUpgradeListener(null));

    it('hears an accepted managed upgrade and its client input, never a refused one', async () => {
      const heard: string[] = [];
      const messages: string[] = [];
      setManagedUpgradeListener((req, socket) => {
        heard.push(req.url ?? '');
        socket.on('message', () => messages.push(req.url ?? ''));
      });
      gate.mockImplementation(async (req) =>
        req.headers['x-test-signed-out']
          ? { ok: false, status: 401, message: 'Unauthorized' }
          : { ok: true, locals: {} }
      );
      await listen([acceptingRoute, closeFrameRefusalRoute, gatedRoute]);
      // Stand in for the managed ingress, which marks before handing upgrades on.
      server.prependListener('upgrade', (req) => markIngress(req, 'managed'));

      expect((await attempt('/api/accept')).opened).toBe(true);
      expect((await attempt('/api/refuse-close')).closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
      expect((await attempt('/api/gated', { 'x-test-signed-out': '1' })).closeCode).toBe(
        STREAM_CLOSE_CODE_BASE + 401
      );
      expect(heard).toEqual(['/api/accept']);

      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/gated`);
      await new Promise((resolve) => ws.once('open', resolve));
      ws.send('keystroke');
      await vi.waitFor(() => expect(messages).toEqual(['/api/gated']));
      ws.close();
    });
  });

  describe('the Remote Access switch (DOR-3650)', () => {
    /** Remote Access off, login off. */
    const remoteAccessOff = (): void => {
      vi.mocked(configManager.get).mockImplementation(() => ({ enabled: false }) as never);
    };
    afterEach(() => {
      loginEnabled(false);
      resetRemoteStreamsForTests();
    });

    it.each(['own-tunnel', 'managed', 'wifi'] as const)(
      'turned off, refuses a %s upgrade before any route runs',
      async (via) => {
        const authorize = vi.fn(() => ({ ok: true as const, open: () => {} }));
        await listen([
          { name: 'guarded', pattern: /^\/api\/accept$/, credential: 'bearer-of-id', authorize },
        ]);
        server.prependListener('upgrade', (req) => markIngress(req, via));
        expect((await attempt('/api/accept')).opened).toBe(true);

        remoteAccessOff();
        const result = await attempt('/api/accept');
        expect(result.httpStatus).toBe(403);
        expect(authorize).toHaveBeenCalledTimes(1);
      }
    );

    it('turning off closes a socket another device already holds, and keeps this computer’s', async () => {
      await listen([acceptingRoute]);
      // Only upgrades carrying this header arrive as the own tunnel.
      server.prependListener('upgrade', (req) => {
        if (req.headers['x-test-tunnel']) markIngress(req, 'own-tunnel');
      });
      /** Open a socket and keep it, reporting its close code once it closes. */
      const hold = async (headers: Record<string, string>) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/api/accept`, { headers });
        let code: number | undefined;
        ws.on('close', (c) => (code = c));
        await new Promise((resolve) => ws.once('open', resolve));
        return { ws, code: () => code };
      };
      const remote = await hold({ 'x-test-tunnel': '1' });
      const local = await hold({});

      remoteAccessOff();
      expect(closeRemoteStreams()).toBe(1);

      await vi.waitFor(() => expect(remote.code()).toBe(STREAM_CLOSE_CODE_BASE + 403));
      expect(local.code()).toBeUndefined();
      local.ws.close();
    });
  });

  describe('the inputs the router hands the origin policy', () => {
    it('accepts an Origin the operator listed in DORKOS_CORS_ORIGIN', async () => {
      process.env.DORKOS_CORS_ORIGIN = ' https://a.example , https://b.example ';
      try {
        await listen([acceptingRoute]);
        const result = await attempt('/api/accept', { origin: 'https://b.example' });
        expect(result.opened).toBe(true);
      } finally {
        delete process.env.DORKOS_CORS_ORIGIN;
      }
    });

    it('REFUSES a rebound Origin whose Host this instance does not answer to', async () => {
      // evil.example resolves to 127.0.0.1, so Origin and Host agree — and the
      // host allowlist is what rejects it, exactly as `hostGuard` does.
      await listen([acceptingRoute]);

      const result = await attempt('/api/accept', REBOUND);

      expect(result.httpStatus).toBe(403);
      expect(result.opened).toBe(false);
    });

    it('pins the scheme to X-Forwarded-Proto for a DORKOS_TRUSTED_HOSTS name', () =>
      withTrustedHost(async () => {
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
      }));

    it('defaults to the connection scheme when no proxy names one (DOR-932)', () =>
      withTrustedHost(async () => {
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
      }));

    it('REFUSES Origin: null on the terminal even with DORKOS_PUBLIC_URL set to the typo', async () => {
      // `DORKOS_PUBLIC_URL=dorkos:4242` parses `dorkos:` as the SCHEME and
      // serializes to origin "null"; it once opened the terminal to any
      // sandboxed page. It is no longer a trust branch at all.
      mutableEnv.DORKOS_PUBLIC_URL = 'dorkos:4242';
      try {
        await listen([bearerRoute]);

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

    it('ACCEPTS an IP-literal Host only under the container flag, which rebinding cannot forge', async () => {
      await listen([acceptingRoute]);
      const ipLiteral = { origin: 'http://192.168.1.50:4242', host: '192.168.1.50:4242' };

      expect((await attempt('/api/accept', ipLiteral)).httpStatus).toBe(403);
      await inContainer(async () => {
        expect((await attempt('/api/accept', ipLiteral)).opened).toBe(true);
      })();
    });
  });

  describe('the host pairing does not stand down for the container flag', () => {
    // `DORKOS_ALLOW_INSECURE_BIND` is set by BOTH Dockerfile targets, and it
    // used to make the same-origin branch inert — so in the shipped image a page
    // that rebinds DNS to the published address had a shell on the host.

    it.each([false, true])(
      'REFUSES a rebound origin on the TERMINAL in the shipped container (login on: %s)',
      (login) =>
        inContainer(async () => {
          // A `bearer-of-id` route skips the credential gate entirely, so login
          // being on changes nothing for it.
          loginEnabled(login);
          await listen([bearerRoute]);

          const result = await attempt('/api/terminal/abc/socket', REBOUND);

          expect(result.httpStatus).toBe(403);
          expect(result.opened, 'no shell for a rebound page').toBe(false);
        })()
    );

    it(
      'REFUSES a rebound origin on a durable stream in the container, login off: it is another device, so the gate asks it to sign in',
      inContainer(async () => {
        loginEnabled(false);
        gate.mockResolvedValue({ ok: false, status: 401, message: 'Unauthorized' });
        await listen([gatedRoute]);

        const result = await attempt('/api/gated', REBOUND);

        expect(gate).toHaveBeenCalled();
        expect(result.closeCode).toBe(STREAM_CLOSE_CODE_BASE + 401);
      })
    );

    it(
      'still serves the container its OWN origin — the flag must not break Docker',
      inContainer(async () => {
        loginEnabled(false);
        await listen([acceptingRoute]);

        const result = await attempt('/api/accept', {
          origin: 'http://localhost:4242',
          host: 'localhost:4242',
        });

        expect(result.opened).toBe(true);
      })
    );

    it.each([false, true])(
      'stands down ONLY for a credential-gated route whose gate asks this request for a credential (password on this computer: %s)',
      async (askOnThisComputer) => {
        // A rebound `Host` is another device, which the gate always asks for a
        // credential (ADR 261015-125850 rule 2), so this holds with the
        // this-computer password off too.
        loginEnabled(askOnThisComputer);
        await listen([gatedRoute]);

        const result = await attempt('/api/gated', REBOUND);

        expect(result.opened, 'the credential gate is what stops this one').toBe(true);
        expect(gate).toHaveBeenCalledTimes(1);
      }
    );
  });
});
