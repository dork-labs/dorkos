import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

import {
  type BrowserOriginFacts,
  type BrowserOriginPolicy,
  isTrustedBrowserOrigin,
} from '../trusted-origins.js';

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
function facts(overrides: Partial<BrowserOriginFacts> = {}): BrowserOriginFacts {
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

/**
 * The three surfaces' policies, spelled out here so a change to any of them
 * fails a test rather than a deployment. They are copies of the constants at the
 * mounts (`UPGRADE_ORIGIN_POLICY` in `services/core/streams/upgrade-router.ts`,
 * `MCP_ORIGIN_POLICY` in `middleware/mcp-origin.ts`, `CORS_ORIGIN_POLICY` in
 * `app.ts`) on purpose: a test that imported them could not notice one of them
 * changing.
 */
const UPGRADE_POLICY: BrowserOriginPolicy = { allowNoOrigin: true, pairSameOriginWithHost: true };
const MCP_POLICY: BrowserOriginPolicy = { allowNoOrigin: true, pairSameOriginWithHost: true };
const CORS_POLICY: BrowserOriginPolicy = { allowNoOrigin: true, pairSameOriginWithHost: false };

/** The predicate as the WebSocket upgrade asks it. */
function isTrustedUpgradeOrigin(f: BrowserOriginFacts): boolean {
  return isTrustedBrowserOrigin(f, UPGRADE_POLICY);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isTrustedBrowserOrigin, as the WebSocket upgrade asks it', () => {
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

    /**
     * The list ADDS to the policy; it does not replace it (DOR-1711 round 2).
     *
     * This pair used to be a single test asserting the opposite — "makes the
     * list exhaustive, no same-origin fallback under it" — and after the
     * semantics changed it kept passing for a reason that had nothing to do
     * with the list: its origin was `https://` while the connection resolved to
     * `http://`, so branch 4 refused it on the SCHEME. A test that survives the
     * behaviour it pins being deleted is not pinning it, so the scheme is
     * matched here and the two directions are separated.
     */
    it('lets an UNLISTED origin through when it is same-origin with the request', () => {
      // A container published on a remapped port, a LAN IP, a reverse-proxied
      // host: all same-origin with themselves and none of them named by a list
      // that names the public origin. Refusing these was measured as a 500 on
      // every write while reads kept working.
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'https://box.example',
            hostHeader: 'box.example',
            forwardedProto: 'https',
            configuredOrigins: 'https://other.example',
          })
        )
      ).toBe(true);
    });

    it('still refuses an unlisted origin that is NOT same-origin', () => {
      // The other direction, so "additive" cannot quietly become "anything
      // goes": a stranger is admitted by no branch at all.
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'https://evil.example',
            hostHeader: 'box.example',
            forwardedProto: 'https',
            configuredOrigins: 'https://other.example',
          })
        )
      ).toBe(false);
    });

    it('still pairs the fallthrough with the host allowlist, so rebinding stays refused', () => {
      // Falling through must not hand a DNS-rebound page the branch the list
      // used to shadow: Origin and Host agree by construction there, so the
      // pairing is the only thing refusing it.
      expect(
        isTrustedUpgradeOrigin(
          facts({
            origin: 'https://evil.example',
            hostHeader: 'evil.example',
            hostAllowed: false,
            forwardedProto: 'https',
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

/**
 * The rows DOR-1711 unified: one predicate, three surfaces, and the ONE thing
 * that legitimately differs between them stated as a policy rather than as three
 * implementations.
 *
 * Every case below was a disagreement before the merge, not a hypothetical. The
 * `/mcp` mounts carried their own 43-line allowlist of `http://localhost:PORT`
 * and `http://127.0.0.1:PORT` plus the tunnel — no same-origin branch, no
 * `DORKOS_CORS_ORIGIN`, no `[::1]` — so each of these origins was accepted by
 * `/api` and refused by `/mcp` on the same instance.
 */
describe('one policy, three surfaces (DOR-1711)', () => {
  /** Every surface, so a case can assert they now agree. */
  const SURFACES: ReadonlyArray<readonly [string, BrowserOriginPolicy]> = [
    ['upgrade', UPGRADE_POLICY],
    ['mcp', MCP_POLICY],
    ['cors', CORS_POLICY],
  ];

  describe('the no-Origin pass is a stated option, not an accident', () => {
    it('is what every surface asks for — MCP clients send no Origin', () => {
      // The MCP TypeScript SDK's HTTP transport sets Authorization,
      // mcp-session-id, mcp-protocol-version, Accept and content-type, and
      // Node's fetch adds no Origin. DorkOS's own in-process MCP clients (the
      // Codex canvas stub, the Nango proxy) ride the same branch.
      for (const [name, policy] of SURFACES) {
        expect(
          isTrustedBrowserOrigin(facts({ origin: undefined }), policy),
          `${name} refused a request with no Origin`
        ).toBe(true);
      }
    });

    it('is the OPTION deciding it, so a surface that said false would refuse', () => {
      // Proves the branch reads the policy rather than returning a constant —
      // without this, flipping `allowNoOrigin` anywhere would be silent.
      expect(
        isTrustedBrowserOrigin(facts({ origin: undefined }), {
          allowNoOrigin: false,
          pairSameOriginWithHost: true,
        })
      ).toBe(false);
    });

    it('never extends to the literal `null`, whatever the policy says', () => {
      // Absent means "no browser"; `null` means "a browser, from a sandboxed
      // iframe / data: / file:" — an origin trusted with nothing.
      for (const [name, policy] of SURFACES) {
        expect(
          isTrustedBrowserOrigin(facts({ origin: 'null' }), policy),
          `${name} admitted an opaque origin`
        ).toBe(false);
      }
    });
  });

  describe('rows where /mcp used to disagree with /api', () => {
    it('accepts the IPv6 loopback literal on every surface (DOR-553, absorbed)', () => {
      // `[::1]` is not on the static list and must not be — nothing binds it,
      // and an origin the server never serves is one an attacker can forge
      // (DOR-554). It passes here as the request's OWN origin: the Host is
      // loopback, so the pairing holds, and the origin matches it exactly.
      const ipv6 = facts({
        origin: 'http://[::1]:4242',
        hostHeader: '[::1]:4242',
        hostAllowed: true,
      });
      for (const [name, policy] of SURFACES) {
        expect(isTrustedBrowserOrigin(ipv6, policy), `${name} refused [::1]`).toBe(true);
      }
    });

    it('accepts a remapped host port on every surface (docker run -p 4300:4242)', () => {
      const remapped = facts({
        origin: 'http://localhost:4300',
        hostHeader: 'localhost:4300',
        hostAllowed: true,
      });
      for (const [name, policy] of SURFACES) {
        expect(isTrustedBrowserOrigin(remapped, policy), `${name} refused a port remap`).toBe(true);
      }
    });

    it("honours the operator's DORKOS_CORS_ORIGIN list on every surface", () => {
      const configured = facts({
        origin: 'https://dorkos.example.com',
        configuredOrigins: 'https://dorkos.example.com',
      });
      for (const [name, policy] of SURFACES) {
        expect(
          isTrustedBrowserOrigin(configured, policy),
          `${name} ignored the operator's allowlist`
        ).toBe(true);
      }
    });

    it('refuses a stranger on every surface', () => {
      const evil = facts({ origin: 'https://evil.example', hostHeader: 'localhost:4242' });
      for (const [name, policy] of SURFACES) {
        expect(isTrustedBrowserOrigin(evil, policy), `${name} admitted a stranger`).toBe(false);
      }
    });
  });

  describe('the host pairing is the one difference, and it is load-bearing', () => {
    /** A page that rebound `evil.example` onto this port: same-origin to the browser. */
    const rebound = facts({
      origin: 'http://evil.example',
      hostHeader: 'evil.example',
      hostAllowed: false,
    });

    it('refuses a DNS-rebound page wherever nothing else checks Host', () => {
      // These two mounts have no `hostGuard` in front of them. If the pairing
      // did not run here, the same-origin branch would admit the attack by
      // construction — the browser makes Origin and Host agree.
      expect(isTrustedBrowserOrigin(rebound, UPGRADE_POLICY)).toBe(false);
      expect(isTrustedBrowserOrigin(rebound, MCP_POLICY)).toBe(false);
    });

    it('leaves it to hostGuard on the CORS mount, which is where it lives', () => {
      // Not a weaker posture — the SAME pairing, mounted separately: `app.ts`
      // puts `hostGuard` on `/api` a few lines after this handler, and it
      // answers this exact request with a 403. Duplicating it here would also
      // refuse the shipped container reached at a name, whose `hostGuard`
      // stands down for DORKOS_ALLOW_INSECURE_BIND without putting that name on
      // any allowlist.
      expect(isTrustedBrowserOrigin(rebound, CORS_POLICY)).toBe(true);
    });
  });
});
