import { createHmac } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  DEVICE_GRANT_TYPE,
  INSTANCE_CLIENT_ID,
  buildInstanceDescriptor,
  linkProofForKey,
  pollForToken,
  requestDeviceCode,
  revokeInstanceKey,
  sendHeartbeat,
  type FetchLike,
  type InstanceDescriptor,
} from '../cloud-link-client.js';
import { BASE } from './cloud-link-client/cloud-link-client.fixtures.js';

const DESCRIPTOR: InstanceDescriptor = {
  name: 'kai-mbp',
  platform: 'darwin',
  dorkosVersion: '0.4.2',
};

/** A deterministic clock: `sleep(ms)` advances `now()` by `ms` and records the delay. */
function makeClock() {
  let t = 0;
  const recorded: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      recorded.push(ms);
    },
    recorded,
  };
}

/** A fetch that plays back a fixed sequence of `{ status, body }` responses. */
function sequenceFetch(
  sequence: Array<{ status: number; body: unknown; headers?: Record<string, string> }>
) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return new Response(JSON.stringify(step.body), { status: step.status, headers: step.headers });
  });
}

/** Polls with the deterministic clock and a 5s interval. */
function poll(
  fetchImpl: ReturnType<typeof sequenceFetch>,
  clock: ReturnType<typeof makeClock>,
  expiresIn = 1800
) {
  return pollForToken({
    baseUrl: BASE,
    deviceCode: 'dev-123',
    interval: 5,
    expiresIn,
    fetchImpl,
    sleep: clock.sleep,
    now: clock.now,
  });
}

describe('requestDeviceCode', () => {
  const okResponse = async (_url: string, _init?: RequestInit) =>
    new Response(
      JSON.stringify({
        device_code: 'dev-123',
        user_code: 'ABCD1234',
        verification_uri: `${BASE}/activate`,
        verification_uri_complete: `${BASE}/activate?user_code=ABCD1234`,
        expires_in: 1800,
        interval: 5,
      }),
      { status: 200 }
    );
  const rawScope = (fetchImpl: ReturnType<typeof vi.fn>) =>
    JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string).scope as string;

  it('posts the client id + descriptor scope and returns the parsed codes', async () => {
    const fetchImpl = vi.fn(okResponse);
    const codes = await requestDeviceCode({ baseUrl: BASE, descriptor: DESCRIPTOR, fetchImpl });

    expect(codes.user_code).toBe('ABCD1234');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/auth/device/code`);
    expect(JSON.parse(init.body as string).client_id).toBe(INSTANCE_CLIENT_ID);
    // No telemetry id or relink proof: the exact bytes a first link has always sent.
    expect(rawScope(fetchImpl)).toBe(
      '{"name":"kai-mbp","platform":"darwin","dorkosVersion":"0.4.2"}'
    );
  });

  it('carries telemetryInstanceId and previousLinkProof in the scope only when present', async () => {
    const fetchImpl = vi.fn(okResponse);
    await requestDeviceCode({
      baseUrl: BASE,
      descriptor: { ...DESCRIPTOR, telemetryInstanceId: 'inst-uuid-1', previousLinkProof: 'p' },
      fetchImpl,
    });
    expect(JSON.parse(rawScope(fetchImpl))).toMatchObject({
      telemetryInstanceId: 'inst-uuid-1',
      previousLinkProof: 'p',
    });
  });

  it('throws on a non-2xx device-code response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      requestDeviceCode({ baseUrl: BASE, descriptor: DESCRIPTOR, fetchImpl })
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe('linkProofForKey', () => {
  it('is HMAC-SHA256 keyed by the UTF-8 key over "dorkos-relink-v1", base64url with no padding', () => {
    // Recomputed here AND pinned as a literal below, so a change to either the
    // formula or the implementation fails. A plain SHA-256 of the key would not match.
    const key = 'dork_inst_example';
    expect(linkProofForKey(key)).toBe(
      createHmac('sha256', key).update('dorkos-relink-v1').digest('base64url')
    );
    // Cross-checked with: printf 'dorkos-relink-v1' | openssl dgst -sha256 -hmac 'dork_inst_example' -binary | base64 (then + / -> - _, = dropped).
    expect(linkProofForKey(key)).toBe('N90kR3TE_GnYWhiySlFCBbDkvflsBdA5CrAVDzjrovw');
  });
});

describe('buildInstanceDescriptor', () => {
  it('includes telemetryInstanceId only when one is passed (the opt-in path)', () => {
    expect('telemetryInstanceId' in buildInstanceDescriptor()).toBe(false);
    expect(buildInstanceDescriptor('inst-uuid-2').telemetryInstanceId).toBe('inst-uuid-2');
  });
});

describe('pollForToken', () => {
  it('returns approved with the access token on success', async () => {
    const fetchImpl = sequenceFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'dork_inst_abc', token_type: 'Bearer' } },
    ]);
    const result = await poll(fetchImpl, makeClock());

    expect(result).toEqual({ status: 'approved', accessToken: 'dork_inst_abc' });
    const firstBody = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(firstBody.grant_type).toBe(DEVICE_GRANT_TYPE);
  });

  it.each([
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ])('maps %s to %s', async (error, status) => {
    const result = await poll(sequenceFetch([{ status: 400, body: { error } }]), makeClock());
    expect(result).toEqual({ status });
  });

  it('backs off on a 429 like slow_down and still links (DOR-2496)', async () => {
    // A rate limiter in front of the poll refused a compliant poller; the
    // device code was still good, so the link must not end there.
    const clock = makeClock();
    const fetchImpl = sequenceFetch([
      { status: 429, body: {} },
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: { access_token: 'dork_inst_xyz' } },
    ]);
    const result = await poll(fetchImpl, clock);
    expect(result).toEqual({ status: 'approved', accessToken: 'dork_inst_xyz' });
    expect(clock.recorded).toEqual([5000, 10000, 10000]);
  });

  it('honours Retry-After on a 429, capped at the code expiry, then ends as expired', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([
      { status: 429, body: {}, headers: { 'retry-after': '30' } },
      { status: 429, body: {}, headers: { 'x-retry-after': '9999' } },
    ]);
    const result = await poll(fetchImpl, clock, 60);
    // 5s, then the 30s it asked for, then only the 25s left before expiry.
    expect(clock.recorded).toEqual([5000, 30000, 25000]);
    expect(result).toEqual({ status: 'expired' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws on an unrecognized token error rather than looping forever', async () => {
    const fetchImpl = sequenceFetch([{ status: 400, body: { error: 'teapot' } }]);
    await expect(poll(fetchImpl, makeClock())).rejects.toThrow(/teapot/);
  });
});

describe('sendHeartbeat', () => {
  const beat = (fetchImpl: FetchLike) =>
    sendHeartbeat({
      baseUrl: BASE,
      accessToken: 'dork_inst_abc',
      descriptor: DESCRIPTOR,
      fetchImpl,
    });

  it('returns ok with instanceId, lastSeenAt and accountLabel on 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            instanceId: 'inst-1',
            lastSeenAt: '2026-07-03T00:00:00Z',
            accountLabel: 'owner@dork.test',
          }),
          { status: 200 }
        )
    );
    expect(await beat(fetchImpl)).toEqual({
      ok: true,
      instanceId: 'inst-1',
      lastSeenAt: '2026-07-03T00:00:00Z',
      accountLabel: 'owner@dork.test',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/api/instances/heartbeat`);
    expect(init.headers).toMatchObject({ authorization: 'Bearer dork_inst_abc' });
  });

  it.each([
    [401, { ok: false, unauthorized: true }],
    [503, { ok: false, unauthorized: false, error: 'HTTP 503' }],
  ])('flags only 401 as unauthorized (the unlink signal): %i', async (status, expected) => {
    expect(await beat(vi.fn(async () => new Response('', { status })))).toEqual(expected);
  });
});

describe('revokeInstanceKey', () => {
  it('swallows failures and returns false (best-effort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      revokeInstanceKey({ baseUrl: BASE, accessToken: 'dork_inst_abc', fetchImpl })
    ).resolves.toBe(false);
  });
});
