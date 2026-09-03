import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 4242, NODE_ENV: 'development' } }));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { url: null } },
}));

import { env } from '../../env.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import {
  getLocalCockpitOrigin,
  getTunnelHost,
  getTunnelOrigin,
  getStaticLocalOrigins,
  isLocalRequest,
  isLoopbackHost,
  isLoopbackHostHeader,
  isLoopbackPeer,
  parseHostname,
} from '../trusted-origins.js';

describe('parseHostname', () => {
  it.each([
    ['localhost:4242', 'localhost'],
    ['localhost', 'localhost'],
    ['EXAMPLE.com:8443', 'example.com'],
    ['[::1]:4242', '::1'],
    ['[::1]', '::1'],
    ['  localhost:4242  ', 'localhost'],
  ])('parses %s to %s', (header, expected) => {
    expect(parseHostname(header)).toBe(expected);
  });

  it.each([undefined, '', '   ', ':4242', '[]'])('returns null for %s', (header) => {
    expect(parseHostname(header)).toBeNull();
  });
});

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '::1', 'LOCALHOST', '  localhost  '])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', 'evil.com', 'localhost.evil.com', '127.0.0.1.evil.com', '::2'])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    }
  );
});

describe('isLoopbackHostHeader', () => {
  it.each(['localhost', 'localhost:4242', '127.0.0.1:9999', '[::1]:4242'])(
    'accepts the Host header %s regardless of port',
    (header) => {
      expect(isLoopbackHostHeader(header)).toBe(true);
    }
  );

  it.each([undefined, '', 'evil.com', 'evil.com:4242', 'localhost.evil.com'])(
    'rejects the Host header %s',
    (header) => {
      expect(isLoopbackHostHeader(header)).toBe(false);
    }
  );

  // DOR-532 review. The predicate takes the RAW header precisely so no
  // `X-Forwarded-*` value can reach it. `req.hostname` would have said
  // "localhost" for this request; passing the real Host keeps it honest.
  it('judges the real Host, so a spoofed X-Forwarded-Host cannot reach it', () => {
    expect(isLoopbackHostHeader('dorkos.example.com')).toBe(false);
  });
});

describe('isLoopbackPeer', () => {
  it.each([
    ['127.0.0.1', 'the usual IPv4 loopback'],
    ['127.0.0.2', 'the rest of the 127.0.0.0/8 block'],
    ['127.255.255.254', 'the top of the block'],
    ['::1', 'IPv6 loopback'],
    ['0:0:0:0:0:0:0:1', 'IPv6 loopback, expanded'],
    ['::ffff:127.0.0.1', 'the v4-mapped form a dual-stack listener reports'],
    ['::FFFF:127.0.0.1', 'v4-mapped, upper case'],
    ['::1%lo0', 'with a zone index'],
  ])('accepts %s (%s)', (address) => {
    expect(isLoopbackPeer(address)).toBe(true);
  });

  it.each([
    ['192.168.86.200', 'a LAN peer — the address that defeated the header-only check'],
    ['10.0.0.5', 'another private range'],
    ['172.17.0.1', "Docker's bridge gateway, which is how the browser reaches a container"],
    ['203.0.113.7', 'a public address'],
    ['128.0.0.1', 'adjacent to the loopback block but outside it'],
    ['27.0.0.1', 'a prefix of the loopback block'],
    ['1270.0.0.1', 'not a valid address at all'],
    ['::2', 'a non-loopback IPv6 address'],
    ['::ffff:192.168.86.200', 'a v4-mapped LAN peer'],
    ['', 'an empty address'],
  ])('rejects %s (%s)', (address) => {
    expect(isLoopbackPeer(address)).toBe(false);
  });

  it('rejects a missing address, so a torn-down socket is never treated as local', () => {
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  // The two signals answer different questions and neither substitutes for the
  // other: a rebound browser is a loopback peer sending a hostile Host, and the
  // LAN attacker is a hostile peer sending a loopback Host.
  it('is independent of the Host header', () => {
    expect(isLoopbackPeer('192.168.86.200') && isLoopbackHostHeader('localhost')).toBe(false);
    expect(isLoopbackPeer('127.0.0.1') && isLoopbackHostHeader('evil.com')).toBe(false);
    expect(isLoopbackPeer('127.0.0.1') && isLoopbackHostHeader('localhost:4242')).toBe(true);
  });
});

describe('isLocalRequest', () => {
  const unflagged = { allowInsecureBind: false };

  it.each<[string | undefined, string | undefined, boolean, string]>([
    ['127.0.0.1', 'localhost:4242', true, 'a person at this machine'],
    ['::1', 'localhost', true, 'the same over IPv6'],
    ['::ffff:127.0.0.1', '127.0.0.1:4242', true, 'the v4-mapped peer form'],
    ['192.168.86.200', 'localhost', false, 'a LAN caller forging a loopback Host'],
    ['172.17.0.1', 'localhost:4242', false, "Docker's bridge gateway, unflagged"],
    ['127.0.0.1', 'evil.example.com', false, 'a DNS-rebound browser'],
    [undefined, 'localhost', false, 'a socket with no address'],
    ['127.0.0.1', undefined, false, 'a request with no Host header'],
  ])('peer=%s host=%s -> %s (%s)', (peer, hostHeader, expected) => {
    expect(isLocalRequest({ ...unflagged, peer, hostHeader })).toBe(expected);
  });

  /**
   * The flag says the surrounding environment owns the network boundary. It is
   * also the only way these actions work inside a container, where the browser's
   * request arrives from the bridge gateway rather than loopback — requiring a
   * loopback peer there would break provisioning for every Docker operator
   * without shrinking a blast radius that image already accepts.
   */
  describe('DORKOS_ALLOW_INSECURE_BIND', () => {
    it.each<[string | undefined, string | undefined, string]>([
      ['172.17.0.1', 'localhost:4242', "Docker's bridge gateway"],
      ['192.168.86.200', 'localhost', 'a LAN peer'],
      ['127.0.0.1', 'evil.example.com', 'a hostile Host'],
      [undefined, undefined, 'nothing identifiable at all'],
    ])('admits peer=%s host=%s (%s) when set', (peer, hostHeader) => {
      expect(isLocalRequest({ peer, hostHeader, allowInsecureBind: true })).toBe(true);
    });

    it.each([
      ['172.17.0.1', 'localhost:4242'],
      ['192.168.86.200', 'localhost'],
    ])('refuses the same request (peer=%s) when not set', (peer, hostHeader) => {
      expect(isLocalRequest({ peer, hostHeader, allowInsecureBind: false })).toBe(false);
    });

    it('does not weaken the genuine-local case either way', () => {
      const local = { peer: '127.0.0.1', hostHeader: 'localhost:4242' };
      expect(isLocalRequest({ ...local, allowInsecureBind: false })).toBe(true);
      expect(isLocalRequest({ ...local, allowInsecureBind: true })).toBe(true);
    });
  });
});

/**
 * The trusted-origin set, pinned where it is DEFINED (DOR-554).
 *
 * `getStaticLocalOrigins()` composes the four origins the server treats as its own
 * and had no direct test anywhere. PR #513 hardened the extension-approve route
 * until every NARROWING mutation of that route dies — but widening this list was
 * caught by nothing: adding `http://[::1]:${port}` and `https://attacker.example`
 * to the returned array left the route suite at 27 passed.
 *
 * It belongs here rather than in a route test because the function has at least
 * four consumers (the extension approve route, the CORS delegate, the host guard,
 * and Better Auth), so pinning it at the definition closes the row for all of them
 * at once. Pinning it downstream is how the DNS-rebinding bug in DOR-516 happened:
 * the route computed its expected origin from something the CALLER controlled
 * instead of from its own configuration.
 *
 * Both inputs are stubbed explicitly. `env.DORKOS_PORT` comes from the module mock
 * at the top of this file, and `VITE_PORT` is read straight off `process.env`
 * (trusted-origins.ts:163, with its own eslint carve-out) rather than through the
 * validated `env` module. That split is why #513's first fix was defeatable: a test
 * mocking `env` still had one ambient port input, so the assertion moved with
 * whatever the developer happened to have exported.
 */
describe('getStaticLocalOrigins', () => {
  const originalVitePort = process.env.VITE_PORT;

  /** Set or clear `VITE_PORT` so neither input is ambient. */
  function setVitePort(value: string | undefined): void {
    if (value === undefined) delete process.env.VITE_PORT;
    else process.env.VITE_PORT = value;
  }

  afterEach(() => {
    setVitePort(originalVitePort);
  });

  it('returns exactly the four loopback dev origins, and nothing else', () => {
    // `toEqual` on purpose, not `toContain`: a fifth origin is the mutation nobody
    // was watching for, and only an exact comparison fails on it.
    setVitePort('4241');
    expect(getStaticLocalOrigins()).toEqual([
      'http://localhost:4242',
      'http://localhost:4241',
      'http://127.0.0.1:4242',
      'http://127.0.0.1:4241',
    ]);
  });

  it('drops the Vite dev origins in PRODUCTION', () => {
    // The dev-server origin is a development affordance: in dev the cockpit is
    // served from a different port than the API. In production the server serves
    // the SPA itself, so nothing legitimate speaks from that port — but anything
    // that happened to listen there would be trusted, and since the durable
    // streams became WebSockets that list gates the embedded terminal too.
    const mutable = env as { NODE_ENV?: string };
    const previous = mutable.NODE_ENV;
    mutable.NODE_ENV = 'production';
    try {
      setVitePort('4241');
      expect(getStaticLocalOrigins()).toEqual(['http://localhost:4242', 'http://127.0.0.1:4242']);
    } finally {
      mutable.NODE_ENV = previous;
    }
  });

  it('points the cockpit link at the Vite dev server outside production', () => {
    // `express.static` is production-only, so in dev NOTHING answers `/` on the
    // API port. A "Back to DorkOS" link built from DORKOS_PORT would be dead
    // exactly for the developers most likely to click it.
    setVitePort('6241');
    expect(getLocalCockpitOrigin()).toBe('http://localhost:6241');
  });

  it('points the cockpit link at the API port in PRODUCTION', () => {
    // There the server serves the SPA itself, and no Vite dev server exists.
    const mutable = env as { NODE_ENV?: string };
    const previous = mutable.NODE_ENV;
    mutable.NODE_ENV = 'production';
    try {
      setVitePort('6241');
      expect(getLocalCockpitOrigin()).toBe('http://localhost:4242');
    } finally {
      mutable.NODE_ENV = previous;
    }
  });

  it('falls back to the default Vite port when VITE_PORT is unset', () => {
    setVitePort(undefined);
    expect(getStaticLocalOrigins()).toEqual([
      'http://localhost:4242',
      'http://localhost:4241',
      'http://127.0.0.1:4242',
      'http://127.0.0.1:4241',
    ]);
  });

  it('follows a custom VITE_PORT on both hosts', () => {
    setVitePort('6241');
    expect(getStaticLocalOrigins()).toEqual([
      'http://localhost:4242',
      'http://localhost:6241',
      'http://127.0.0.1:4242',
      'http://127.0.0.1:6241',
    ]);
  });

  it('trusts no host but localhost and 127.0.0.1, and no scheme but http', () => {
    // Stated separately from the exact list above so a widening failure says WHY.
    // `::1` is deliberately absent: it is loopback, but nothing binds it here, and
    // an origin the server never serves is an origin an attacker can try to forge.
    setVitePort('4241');
    for (const origin of getStaticLocalOrigins()) {
      const { protocol, hostname } = new URL(origin);
      expect(protocol, `${origin} is not plain http`).toBe('http:');
      expect(['localhost', '127.0.0.1'], `${origin} names a host beyond loopback`).toContain(
        hostname
      );
    }
  });
});

/**
 * The tunnel origin, which every `/api` request resolves.
 *
 * These read `tunnelManager.status.url` through the module mock at the top of
 * this file. A string that no longer parses is not hypothetical here: it is
 * whatever `listener.url()` handed back, from a program DorkOS does not control,
 * and it is read on the hot path of CORS, the host guard and Better Auth. An
 * unguarded parse there throws out of the CORS callback and 500s the whole API.
 */
describe('getTunnelOrigin / getTunnelHost', () => {
  /** Point the mocked tunnel manager at a URL, or at nothing. */
  function setTunnelUrl(url: string | null): void {
    (tunnelManager as unknown as { status: { url: string | null } }).status = { url };
  }

  afterEach(() => setTunnelUrl(null));

  it('resolves the origin and host of a live tunnel', () => {
    setTunnelUrl('https://abc123.ngrok.app/some/path');
    expect(getTunnelOrigin()).toBe('https://abc123.ngrok.app');
    expect(getTunnelHost()).toBe('abc123.ngrok.app');
  });

  it('answers null, rather than throwing, for a URL that does not parse', () => {
    setTunnelUrl('not a url at all');
    expect(() => getTunnelOrigin()).not.toThrow();
    expect(getTunnelOrigin()).toBeNull();
    expect(getTunnelHost()).toBeNull();
  });

  it('answers null for a scheme with no origin of its own', () => {
    // `new URL('tcp://1.2.3.4:1234').origin` is the STRING "null", and the
    // literal `null` must never reach an allowlist as an origin.
    setTunnelUrl('tcp://1.2.3.4:1234');
    expect(getTunnelOrigin()).toBeNull();
    expect(getTunnelHost()).toBeNull();
  });

  it('answers null when no tunnel is running', () => {
    setTunnelUrl(null);
    expect(getTunnelOrigin()).toBeNull();
    expect(getTunnelHost()).toBeNull();
  });
});
