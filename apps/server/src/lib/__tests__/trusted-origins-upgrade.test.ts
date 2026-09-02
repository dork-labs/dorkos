import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import { isTrustedUpgradeOrigin, type UpgradeOriginFacts } from '../trusted-origins.js';

/**
 * The upgrade origin policy, tested as the pure predicate it is.
 *
 * `upgrade-router.test.ts` drives this through a real server, which is the right
 * level for "does the router consult it, and how is a refusal delivered". It is
 * the WRONG level for some of the inputs that matter most: `ws` always sets a
 * `Host` header from the URL, so a missing one is unreachable from there, and a
 * defence-in-depth guard whose case is also caught downstream reads as green
 * whether or not it exists.
 *
 * Both gaps were real. A review's mutation table found that deleting the
 * `Origin: null` refusal and making a missing `Host` return `true` each left the
 * whole suite green. These tests exist so those two mutations are not silent,
 * and they are checked against exactly that.
 */

/** Facts for a request that reaches a bare, unconfigured instance. */
function facts(overrides: Partial<UpgradeOriginFacts> = {}): UpgradeOriginFacts {
  return {
    origin: undefined,
    hostHeader: 'localhost:4242',
    hostAllowed: true,
    configuredOrigins: undefined,
    forwardedProto: undefined,
    // A plain socket, which is what the server always binds — TLS is terminated
    // upstream, so `req.socket.encrypted` is falsy in production too.
    connectionEncrypted: false,
    hostCheckInert: false,
    ownsNetworkBoundary: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isTrustedUpgradeOrigin', () => {
  describe('absent vs opaque — they read alike and mean opposite things', () => {
    it('trusts a request with NO Origin (a non-browser client)', () => {
      expect(isTrustedUpgradeOrigin(facts({ origin: undefined }))).toBe(true);
    });

    it('REFUSES the literal `null` origin', () => {
      // A sandboxed iframe, a `data:` document, a `file://` page. An opaque
      // origin is by definition one to trust with nothing.
      expect(isTrustedUpgradeOrigin(facts({ origin: 'null' }))).toBe(false);
    });

    it('REFUSES `null` even when an operator listed it in DORKOS_CORS_ORIGIN', () => {
      // This is where the guard EARNS its place. Everywhere else `null` fails
      // the same-origin comparison anyway, so the refusal looks redundant —
      // but a config list is a string match, and `URL.origin` serializes any
      // unparseable URL to exactly this word. That is how an unvalidated
      // `DORKOS_PUBLIC_URL=dorkos:4242` once handed out the terminal.
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'null', configuredOrigins: 'https://ok.example,null' })
        )
      ).toBe(false);
    });

    it('REFUSES `null` in any casing or padding', () => {
      for (const spelling of ['NULL', ' null ', 'Null']) {
        expect(
          isTrustedUpgradeOrigin(facts({ origin: spelling, configuredOrigins: spelling })),
          spelling
        ).toBe(false);
      }
    });

    it('REFUSES an empty Origin header', () => {
      expect(isTrustedUpgradeOrigin(facts({ origin: '' }))).toBe(false);
    });
  });

  describe('a missing Host fails closed', () => {
    it('REFUSES when the Host header is absent', () => {
      // HTTP/1.1 requires one. "No host" must never read as "any host" — the
      // same-origin branch has nothing to compare against.
      expect(
        isTrustedUpgradeOrigin(facts({ origin: 'https://a.example', hostHeader: undefined }))
      ).toBe(false);
    });

    it('REFUSES when the Host header is blank', () => {
      expect(
        isTrustedUpgradeOrigin(facts({ origin: 'https://a.example', hostHeader: '   ' }))
      ).toBe(false);
    });
  });

  describe('the same-origin comparison', () => {
    it('accepts an exact match on host and port', () => {
      // Plain socket, no proxy: the default scheme is `http`, so an `http` origin
      // on the matching host and port is the same origin.
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'http://box.example:8443', hostHeader: 'box.example:8443' })
        )
      ).toBe(true);
    });

    it('normalizes case on both sides', () => {
      expect(
        isTrustedUpgradeOrigin(facts({ origin: 'http://box.example', hostHeader: 'Box.Example' }))
      ).toBe(true);
    });

    it('REFUSES a different port on the same hostname', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'http://box.example:9999', hostHeader: 'box.example:4242' })
        )
      ).toBe(false);
    });

    it('pins the scheme to X-Forwarded-Proto when a proxy names it', () => {
      const base = { hostHeader: 'box.example' } as const;
      // The proxy says https; only the https origin on that host matches.
      expect(
        isTrustedUpgradeOrigin(
          facts({ ...base, origin: 'https://box.example', forwardedProto: 'https' })
        )
      ).toBe(true);
      expect(
        isTrustedUpgradeOrigin(
          facts({ ...base, origin: 'http://box.example', forwardedProto: 'https' })
        )
      ).toBe(false);
      // The proxy says http; now it is the http origin that matches.
      expect(
        isTrustedUpgradeOrigin(
          facts({ ...base, origin: 'http://box.example', forwardedProto: 'http' })
        )
      ).toBe(true);
      expect(
        isTrustedUpgradeOrigin(
          facts({ ...base, origin: 'https://box.example', forwardedProto: 'http' })
        )
      ).toBe(false);
    });

    it('defaults the scheme to the connection’s own when no proxy names it', () => {
      // No `X-Forwarded-Proto`, so the scheme falls back to this connection's
      // encryption instead of accepting both. This closes DOR-932: on a bare
      // host the two schemes are different servers, so accepting either widened
      // the reverse-proxy case. The server always binds plain HTTP.
      const base = { origin: 'http://box.example', hostHeader: 'box.example' } as const;
      // Plain socket (the production default): only http is this origin.
      expect(isTrustedUpgradeOrigin(facts(base))).toBe(true);
      expect(
        isTrustedUpgradeOrigin(facts({ ...base, origin: 'https://box.example' })),
        'https is a different server; a plaintext page must not open a secure stream'
      ).toBe(false);
      // A TLS socket (not reachable in this server, but the fact is honoured):
      // the default flips to https.
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'https://box.example',
            hostHeader: 'box.example',
            connectionEncrypted: true,
          })
        )
      ).toBe(true);
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'http://box.example',
            hostHeader: 'box.example',
            connectionEncrypted: true,
          })
        )
      ).toBe(false);
    });

    it('does not run at all when the host is not allowed', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'http://evil.example', hostHeader: 'evil.example', hostAllowed: false })
        )
      ).toBe(false);
    });
  });

  describe('DORKOS_CORS_ORIGIN', () => {
    it('accepts a listed origin', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'https://a.example', configuredOrigins: 'https://a.example' })
        )
      ).toBe(true);
    });

    it('makes the list exhaustive — no same-origin fallback under it', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'https://box.example',
            hostHeader: 'box.example',
            configuredOrigins: 'https://other.example',
          })
        )
      ).toBe(false);
    });

    it('does NOT honour the wildcard, which has no ACAO backstop on a socket', () => {
      expect(
        isTrustedUpgradeOrigin(facts({ origin: 'https://evil.example', configuredOrigins: '*' }))
      ).toBe(false);
    });

    it('treats the wildcard as NO LIST, so same-origin still decides', () => {
      // The cockpit's own origin must keep working under a documented,
      // supported value — `*` must not black out every socket.
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'http://box.example', hostHeader: 'box.example', configuredOrigins: '*' })
        )
      ).toBe(true);
    });

    it('a PADDED wildcard reads as the wildcard, on this surface and in buildCors', () => {
      // Both surfaces trim before the `=== '*'` check, so `" * "` is the
      // wildcard: no list at all, and the other branches still decide. A
      // stranger is refused because nothing else admits it; the app's own
      // origin is admitted by the same-origin branch, which is what an
      // untrimmed read used to suppress — blacking out this socket while
      // `buildCors` (which does trim) kept serving the same page over HTTP.
      const padded = { configuredOrigins: ' * ' } as const;
      expect(
        isTrustedUpgradeOrigin(facts({ origin: 'https://evil.example', ...padded })),
        'a stranger is refused'
      ).toBe(false);
      expect(
        isTrustedUpgradeOrigin(
          facts({ origin: 'http://box.example', hostHeader: 'box.example', ...padded })
        ),
        "and the app's own origin still connects"
      ).toBe(true);
    });
  });

  describe('DORKOS_ALLOW_INSECURE_BIND buys an IP-literal Host, and nothing else', () => {
    it('accepts an IPv4 literal', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'http://192.168.1.50:4242',
            hostHeader: '192.168.1.50:4242',
            hostAllowed: false,
            ownsNetworkBoundary: true,
          })
        )
      ).toBe(true);
    });

    it('accepts an IPv6 literal in its bracketed form', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'http://[fd00::1]:4242',
            hostHeader: '[fd00::1]:4242',
            hostAllowed: false,
            ownsNetworkBoundary: true,
          })
        )
      ).toBe(true);
    });

    it('REFUSES a DNS NAME, which is the rebinding case', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'http://evil.example',
            hostHeader: 'evil.example',
            hostAllowed: false,
            ownsNetworkBoundary: true,
          })
        )
      ).toBe(false);
    });

    it('REFUSES an IP literal when the flag is not set', () => {
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'http://192.168.1.50:4242',
            hostHeader: '192.168.1.50:4242',
            hostAllowed: false,
            ownsNetworkBoundary: false,
          })
        )
      ).toBe(false);
    });
  });
});
