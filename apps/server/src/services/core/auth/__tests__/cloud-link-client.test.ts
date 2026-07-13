import { describe, it, expect, vi } from 'vitest';
import {
  DEVICE_GRANT_TYPE,
  INSTANCE_CLIENT_ID,
  buildInstanceDescriptor,
  pollForToken,
  requestDeviceCode,
  revokeInstanceKey,
  sendHeartbeat,
  type InstanceDescriptor,
} from '../cloud-link-client.js';

const BASE = 'https://cloud.test';
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
function sequenceFetch(sequence: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const step = sequence[Math.min(i, sequence.length - 1)];
    i += 1;
    return new Response(JSON.stringify(step.body), { status: step.status });
  });
}

describe('requestDeviceCode', () => {
  it('posts the client id + descriptor scope and returns the parsed codes', async () => {
    const fetchImpl = vi.fn(
      async () =>
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
        )
    );

    const codes = await requestDeviceCode({ baseUrl: BASE, descriptor: DESCRIPTOR, fetchImpl });

    expect(codes.user_code).toBe('ABCD1234');
    expect(codes.verification_uri).toContain('/activate');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/auth/device/code`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.client_id).toBe(INSTANCE_CLIENT_ID);
    expect(JSON.parse(body.scope)).toEqual(DESCRIPTOR);
  });

  it('throws on a non-2xx device-code response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    await expect(
      requestDeviceCode({ baseUrl: BASE, descriptor: DESCRIPTOR, fetchImpl })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('serializes telemetryInstanceId into the scope only when the descriptor carries it', async () => {
    const okResponse = () =>
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

    // Present: the id rides in the scope (the app-side opt-in signal).
    const withId = vi.fn(okResponse);
    await requestDeviceCode({
      baseUrl: BASE,
      descriptor: { ...DESCRIPTOR, telemetryInstanceId: 'inst-uuid-1' },
      fetchImpl: withId,
    });
    const scopeWith = JSON.parse(
      JSON.parse((withId.mock.calls[0][1] as RequestInit).body as string).scope
    );
    expect(scopeWith.telemetryInstanceId).toBe('inst-uuid-1');

    // Absent: the wire shape is exactly the three base fields, no key at all.
    const withoutId = vi.fn(okResponse);
    await requestDeviceCode({ baseUrl: BASE, descriptor: DESCRIPTOR, fetchImpl: withoutId });
    const scopeWithout = JSON.parse(
      JSON.parse((withoutId.mock.calls[0][1] as RequestInit).body as string).scope
    );
    expect(scopeWithout).toEqual(DESCRIPTOR);
    expect('telemetryInstanceId' in scopeWithout).toBe(false);
  });
});

describe('buildInstanceDescriptor', () => {
  it('omits telemetryInstanceId when no id is passed', () => {
    const descriptor = buildInstanceDescriptor();
    expect('telemetryInstanceId' in descriptor).toBe(false);
    expect(descriptor.name).toBeTruthy();
    expect(descriptor.platform).toBe(process.platform);
  });

  it('includes telemetryInstanceId when one is passed (the opt-in path)', () => {
    const descriptor = buildInstanceDescriptor('inst-uuid-2');
    expect(descriptor.telemetryInstanceId).toBe('inst-uuid-2');
  });
});

describe('pollForToken', () => {
  it('returns approved with the access token on success', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: { access_token: 'dork_inst_abc', token_type: 'Bearer', scope: 'instance' },
      },
    ]);

    const result = await pollForToken({
      baseUrl: BASE,
      deviceCode: 'dev-123',
      interval: 5,
      expiresIn: 1800,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result).toEqual({ status: 'approved', accessToken: 'dork_inst_abc' });
    // Sends the RFC 8628 grant on each poll.
    const firstBody = JSON.parse(fetchImpl.mock.calls[0][1]!.body as string);
    expect(firstBody.grant_type).toBe(DEVICE_GRANT_TYPE);
  });

  it('returns denied when the user denies (access_denied)', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([{ status: 400, body: { error: 'access_denied' } }]);
    const result = await pollForToken({
      baseUrl: BASE,
      deviceCode: 'dev-123',
      interval: 5,
      expiresIn: 1800,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: 'denied' });
  });

  it('returns expired when the cloud reports expired_token', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([{ status: 400, body: { error: 'expired_token' } }]);
    const result = await pollForToken({
      baseUrl: BASE,
      deviceCode: 'dev-123',
      interval: 5,
      expiresIn: 1800,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: 'expired' });
  });

  it('returns expired once the local deadline passes', async () => {
    const clock = makeClock();
    // Always pending; deadline is 8s, interval 5s → expires on the second wake.
    const fetchImpl = sequenceFetch([{ status: 400, body: { error: 'authorization_pending' } }]);
    const result = await pollForToken({
      baseUrl: BASE,
      deviceCode: 'dev-123',
      interval: 5,
      expiresIn: 8,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: 'expired' });
    // Polled once (t=5000), then woke at t=10000 >= 8000 and stopped without polling.
    expect(fetchImpl.mock.calls.length).toBe(1);
  });

  it('increases the poll interval by 5s after slow_down', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'dork_inst_xyz' } },
    ]);
    const result = await pollForToken({
      baseUrl: BASE,
      deviceCode: 'dev-123',
      interval: 5,
      expiresIn: 1800,
      fetchImpl,
      sleep: clock.sleep,
      now: clock.now,
    });
    expect(result).toEqual({ status: 'approved', accessToken: 'dork_inst_xyz' });
    // First wait 5s, then (after slow_down) 10s.
    expect(clock.recorded).toEqual([5000, 10000]);
  });

  it('throws on an unrecognized token error rather than looping forever', async () => {
    const clock = makeClock();
    const fetchImpl = sequenceFetch([{ status: 400, body: { error: 'teapot' } }]);
    await expect(
      pollForToken({
        baseUrl: BASE,
        deviceCode: 'dev-123',
        interval: 5,
        expiresIn: 1800,
        fetchImpl,
        sleep: clock.sleep,
        now: clock.now,
      })
    ).rejects.toThrow(/teapot/);
  });
});

describe('sendHeartbeat', () => {
  it('returns ok with instanceId + lastSeenAt on 200', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, instanceId: 'inst-1', lastSeenAt: '2026-07-03T00:00:00Z' }),
          {
            status: 200,
          }
        )
    );
    const result = await sendHeartbeat({
      baseUrl: BASE,
      accessToken: 'dork_inst_abc',
      descriptor: DESCRIPTOR,
      fetchImpl,
    });
    // No `accountLabel` in the response → normalized to null.
    expect(result).toEqual({
      ok: true,
      instanceId: 'inst-1',
      lastSeenAt: '2026-07-03T00:00:00Z',
      accountLabel: null,
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE}/api/instances/heartbeat`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer dork_inst_abc' });
  });

  it('parses the accountLabel the cloud returns', async () => {
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
    const result = await sendHeartbeat({
      baseUrl: BASE,
      accessToken: 'dork_inst_abc',
      descriptor: DESCRIPTOR,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, accountLabel: 'owner@dork.test' });
  });

  it('flags 401 as unauthorized (the unlink signal)', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    const result = await sendHeartbeat({
      baseUrl: BASE,
      accessToken: 'dead-key',
      descriptor: DESCRIPTOR,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, unauthorized: true });
  });

  it('reports a transient error on other non-2xx without unauthorizing', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 }));
    const result = await sendHeartbeat({
      baseUrl: BASE,
      accessToken: 'dork_inst_abc',
      descriptor: DESCRIPTOR,
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, unauthorized: false, error: 'HTTP 503' });
  });
});

describe('revokeInstanceKey', () => {
  it('returns true when the cloud acknowledges', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await expect(
      revokeInstanceKey({ baseUrl: BASE, accessToken: 'dork_inst_abc', fetchImpl })
    ).resolves.toBe(true);
  });

  it('swallows failures and returns false (best-effort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      revokeInstanceKey({ baseUrl: BASE, accessToken: 'dork_inst_abc', fetchImpl })
    ).resolves.toBe(false);
  });
});
