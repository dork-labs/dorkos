import { describe, it, expect, afterEach } from 'vitest';
import type { Request } from 'express';
import { env } from '../../env.js';
import { forwardedForIsTrusted, rateLimitKey } from '../rate-limit-key.js';

/**
 * The bucket key, tested where it is DECIDED.
 *
 * `auth-rate-limit.test.ts` drives the same rule through a real server and a
 * real limiter, which is the right level for "does a guesser actually run out of
 * attempts". It is the wrong level for the shapes that decide correctness and
 * that a loopback supertest connection can never produce: an IPv6 client, the
 * `::ffff:` form a dual-stack listener reports, a torn-down socket. Each of
 * those is a way one caller could have become many buckets.
 */

/** A request as the key generator reads it: a socket peer and Express's `req.ip`. */
function req(peer: string | undefined, forwarded = '203.0.113.1'): Request {
  return { ip: forwarded, socket: { remoteAddress: peer } } as unknown as Request;
}

const mutableEnv = env as { DORKOS_TRUST_PROXY: boolean };

afterEach(() => {
  mutableEnv.DORKOS_TRUST_PROXY = false;
});

describe('rateLimitKey', () => {
  describe('untrusted (the default): the socket peer decides', () => {
    it('ignores the forwarded address entirely', () => {
      // The whole point: `req.ip` here is 203.0.113.1, written by whoever sent
      // the request, and it must not reach the key.
      expect(rateLimitKey(req('198.51.100.4'))).toBe('198.51.100.4');
    });

    it('gives two spoofed X-Forwarded-For values from one socket ONE key', () => {
      const a = rateLimitKey(req('198.51.100.4', '203.0.113.1'));
      const b = rateLimitKey(req('198.51.100.4', '203.0.113.2'));
      expect(a).toBe(b);
    });

    it('says so through `forwardedForIsTrusted`', () => {
      expect(forwardedForIsTrusted()).toBe(false);
    });
  });

  describe('the tunnel path', () => {
    /**
     * DorkOS's ngrok tunnel runs IN this process (`@ngrok/ngrok`'s
     * `forward({ addr: port })`) and forwards to the local port, so a request
     * that arrives through it has a LOOPBACK peer. Every tunnel client
     * therefore shares one bucket, which is the trade this default makes on
     * purpose: a remote caller can no longer buy unlimited buckets with a
     * header, and for a single-operator system one shared bucket is not a
     * ceiling anybody meets. Per-client buckets are still available, explicitly.
     */
    it('collapses tunnel traffic onto the loopback peer rather than the forwarded IP', () => {
      const phone = rateLimitKey(req('127.0.0.1', '203.0.113.1'));
      const laptop = rateLimitKey(req('127.0.0.1', '198.51.100.9'));
      expect(phone).toBe('127.0.0.1');
      expect(laptop).toBe('127.0.0.1');
    });

    it('hands the same key whichever shape Node reports the loopback peer in', () => {
      // A dual-stack listener reports an IPv4 peer as `::ffff:127.0.0.1`. Two
      // spellings of one client must not be two budgets.
      expect(rateLimitKey(req('::ffff:127.0.0.1'))).toBe(rateLimitKey(req('127.0.0.1')));
    });

    it('gives per-client buckets back when the operator turns the flag on', () => {
      mutableEnv.DORKOS_TRUST_PROXY = true;
      expect(rateLimitKey(req('127.0.0.1', '203.0.113.1'))).not.toBe(
        rateLimitKey(req('127.0.0.1', '198.51.100.9'))
      );
      expect(forwardedForIsTrusted()).toBe(true);
    });
  });

  describe('shapes that would otherwise be an escape hatch', () => {
    it('masks an IPv6 peer to its /56 network', () => {
      // An IPv6 client is routinely handed far more addresses than it needs. If
      // the full address were the key, rotating through them would be the same
      // unlimited-buckets trick a forged header used to be.
      const a = rateLimitKey(req('2001:db8:abcd:0012::1'));
      const b = rateLimitKey(req('2001:db8:abcd:0012:ffff:ffff:ffff:ffff'));
      expect(a).toBe(b);
    });

    it('separates two different IPv6 networks', () => {
      expect(rateLimitKey(req('2001:db8:abcd:0012::1'))).not.toBe(
        rateLimitKey(req('2001:db8:ffff:0012::1'))
      );
    });

    it('drops a link-local %zone suffix, which is a route and not an identity', () => {
      expect(rateLimitKey(req('fe80::1%en0'))).toBe(rateLimitKey(req('fe80::1')));
    });

    it('falls back to one shared bucket when there is no address at all', () => {
      // A socket already torn down. "Unknown" is not a client, and a limiter
      // that opens up when it cannot identify anyone has an off switch.
      expect(rateLimitKey(req(undefined))).toBe('unknown');
    });
  });
});
