/**
 * A remote Community the computer cannot reach is unavailable, never a crash (DOR-3230).
 *
 * The server shut down twice on `connect EHOSTUNREACH` to a Community's IPv6 address while the
 * computer briefly had no IPv6 route. The pinned lookup answered at once, so a connect that failed
 * at once emitted its error before the request had attached a handler, and it reached
 * `uncaughtException`. Vitest fails a run on any such uncaught error, so each case below would
 * fail on that alone even before its own assertion.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// A Community's NAME resolves, as a real one does: an IP literal skips the socket lookup
// altogether, and the lookup is where the crash was.
const dns = vi.hoisted(() => ({ answer: { address: '100::1', family: 6 } }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [dns.answer]),
}));

import { PinnedOriginError, pinnedJson, pinnedLookup, pinnedSse } from '../pinned-origin.js';

/**
 * A Community whose name resolves to a discard-only IPv6 address (RFC 6666) that the
 * private-address list does not refuse. Where the computer has no IPv6 route the connect fails at
 * once (`EHOSTUNREACH` or `ENETUNREACH`); where it has one, nothing answers and the short
 * deadline below ends the call.
 */
const UNREACHABLE = new URL('https://unreachable.example');

/** A deadline well under the request's own 10 s bound. */
const deadline = () => AbortSignal.timeout(2_000);

describe('pinnedLookup', () => {
  it('never answers synchronously, so a request attaches its error handler first', async () => {
    const lookup = pinnedLookup({ address: '100::1', family: 6 });
    const answers: unknown[] = [];
    lookup('example.test', { all: true }, (_error, addresses) => answers.push(addresses));
    lookup('example.test', {}, (_error, address) => answers.push(address));
    expect(answers).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(answers).toEqual([[{ address: '100::1', family: 6 }], '100::1']);
  });
});

afterEach(() => {
  dns.answer = { address: '100::1', family: 6 };
});

describe('an unreachable Community', () => {
  it('rejects a JSON call with REMOTE_UNAVAILABLE and keeps the process alive', async () => {
    await expect(
      pinnedJson(UNREACHABLE, '/api/v1/community', undefined, deadline())
    ).rejects.toEqual(new PinnedOriginError('REMOTE_UNAVAILABLE'));
  });

  it('rejects a stream with REMOTE_UNAVAILABLE and keeps the process alive', async () => {
    const stream = pinnedSse(
      UNREACHABLE,
      '/api/v1/channels/x/events',
      'token',
      undefined,
      deadline()
    );
    await expect(stream.next()).rejects.toEqual(new PinnedOriginError('REMOTE_UNAVAILABLE'));
  });
});

describe('the pin is exactly as strict', () => {
  it.each([
    ['a private IPv4 address', { address: '10.0.0.5', family: 4 }],
    ['loopback', { address: '127.0.0.1', family: 4 }],
    ['a link-local IPv6 address', { address: 'fe80::1', family: 6 }],
    ['an IPv4-mapped private address', { address: '::ffff:192.168.1.1', family: 6 }],
  ])('still refuses %s before any socket opens', async (_name, answer) => {
    dns.answer = answer;
    await expect(
      pinnedJson(UNREACHABLE, '/api/v1/community', undefined, deadline())
    ).rejects.toEqual(new PinnedOriginError('UNSAFE_ADDRESS'));
    await expect(
      pinnedSse(UNREACHABLE, '/api/v1/channels/x/events', 'token', undefined, deadline()).next()
    ).rejects.toEqual(new PinnedOriginError('UNSAFE_ADDRESS'));
  });
});
