import { it, expect, vi, afterEach } from 'vitest';
import {
  createEgressPolicy,
  EgressPolicyError,
  type EgressPolicyCode,
  type DestinationResolver,
} from '../index.js';

const context = {
  ownerId: 'owner-a',
  workspaceId: 'workspace-a',
  browserId: 'browser-a',
  browserGeneration: 7,
};
const empty = { a: [], aaaa: [], cname: [] };
const global = { a: ['8.8.8.8', '1.1.1.1'], aaaa: ['2606:4700:4700::1111'], cname: [] };
const publicUrl = 'https://public.fixture.invalid/path';
function policy(
  resolver: DestinationResolver,
  extra: Partial<Parameters<typeof createEgressPolicy>[0]> = {}
) {
  return createEgressPolicy({
    revision: 11,
    adminAuthorities: [
      'https://admin.fixture.invalid',
      'http://127.0.0.1:4242',
      'https://alias.fixture.invalid',
    ],
    privateAdminEndpoints: [{ address: '192.168.1.5', port: 4242 }],
    hostInterfaces: ['9.9.9.9'],
    resolver,
    ...extra,
  });
}
afterEach(() => vi.useRealTimers());

it('pins every validated A/AAAA endpoint, snapshots revision and never re-resolves an existing decision', async () => {
  const resolve = vi
    .fn<DestinationResolver>()
    .mockResolvedValueOnce(global)
    .mockResolvedValueOnce({ a: ['127.0.0.1'], aaaa: [], cname: [] });
  const engine = policy(resolve);
  const first = await engine.authorize({ url: publicUrl, context });
  expect(first.endpoints).toEqual([
    { address: '8.8.8.8', family: 4, port: 443 },
    { address: '1.1.1.1', family: 4, port: 443 },
    { address: '2606:4700:4700::1111', family: 6, port: 443 },
  ]);
  expect(first.revision).toBe(11);
  expect(first.binding).toEqual(context);
  expect(Object.isFrozen(first.endpoints[0])).toBe(true);
  await expect(engine.authorize({ url: publicUrl, context })).rejects.toMatchObject({
    code: 'ADDRESS_DENIED',
  });
  expect(first.endpoints[0]!.address).toBe('8.8.8.8');
  expect(resolve).toHaveBeenCalledTimes(2);
});
it.each([
  { a: ['8.8.8.8', '127.0.0.1'], aaaa: [], cname: [] },
  { a: ['8.8.8.8'], aaaa: ['::ffff:7f00:1'], cname: [] },
  { a: ['8.8.8.8'], aaaa: ['fc00::1'], cname: [] },
  { a: ['9.9.9.9'], aaaa: [], cname: [] },
  { a: ['8.8.8.8'], aaaa: ['::ffff:808:808'], cname: [] },
])(
  'rejects a whole mixed/mapped/interface answer before any endpoint selection %#',
  async (answer) => {
    await expect(
      policy(async () => answer).authorize({ url: publicUrl, context })
    ).rejects.toMatchObject({ code: 'ADDRESS_DENIED' });
  }
);
it('rechecks every CNAME authority before lookup and does not blanket-deny shared CDN IPs', async () => {
  const resolve = vi.fn<DestinationResolver>(async (host) =>
    host === 'public.fixture.invalid' ? { ...empty, cname: ['ALIAS.FIXTURE.INVALID.'] } : global
  );
  await expect(policy(resolve).authorize({ url: publicUrl, context })).rejects.toMatchObject({
    code: 'ADMIN_DENIED',
  });
  expect(resolve).toHaveBeenCalledTimes(1);
  const shared = policy(async () => global);
  expect(
    (await shared.authorize({ url: 'https://unrelated.fixture.invalid/', context })).endpoints
  ).toHaveLength(3);
  await expect(
    shared.authorize({ url: 'https://admin.fixture.invalid/api/private', context })
  ).rejects.toMatchObject({ code: 'ADMIN_DENIED' });
});
it('retains and validates addresses from every CNAME hop, including mixed answers on an intermediate hop', async () => {
  const resolve = vi.fn<DestinationResolver>(async (host) =>
    host === 'public.fixture.invalid'
      ? { a: ['8.8.8.8'], aaaa: [], cname: ['edge.fixture.invalid'] }
      : { a: ['1.1.1.1'], aaaa: ['2606:4700:4700::1111'], cname: [] }
  );
  expect((await policy(resolve).authorize({ url: publicUrl, context })).endpoints).toHaveLength(3);
  await expect(
    policy(async () => ({ a: ['127.0.0.1'], aaaa: [], cname: ['edge.fixture.invalid'] })).authorize(
      { url: publicUrl, context }
    )
  ).rejects.toMatchObject({ code: 'ADDRESS_DENIED' });
});
it('refuses DNS cycles/depth/answer bounds/empty or malformed observations with fixed errors', async () => {
  const cases: [DestinationResolver, string][] = [
    [async () => ({ ...empty, cname: ['public.fixture.invalid'] }), 'DNS_CYCLE'],
    [async (host) => ({ ...empty, cname: ['next.' + host] }), 'DNS_LIMIT'],
    [async () => ({ ...empty, a: Array(65).fill('8.8.8.8') }), 'DNS_LIMIT'],
    [async () => empty, 'DNS_EMPTY'],
    [async () => ({ a: ['::1'], aaaa: [], cname: [] }), 'DNS_FAILED'],
    [async () => ({ ...empty, cname: ['127.0.0.1'] }), 'DNS_FAILED'],
    [
      async () => ({ ...empty, cname: ['one.fixture.invalid', 'two.fixture.invalid'] }),
      'DNS_LIMIT',
    ],
    [
      async () => {
        throw Error('SECRET_RESOLVER_URL_TOKEN');
      },
      'DNS_FAILED',
    ],
  ];
  for (const [resolver, code] of cases) {
    const error = await policy(resolver)
      .authorize({ url: publicUrl, context })
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain('SECRET_RESOLVER_URL_TOKEN');
  }
});
it('bounds a resolver ignoring abort and refuses its late answer without changing pinned revision', async () => {
  vi.useFakeTimers();
  let finish!: (value: typeof global) => void;
  let signal!: AbortSignal;
  const resolve: DestinationResolver = (_, abort) => {
    signal = abort;
    return new Promise((done) => {
      finish = done;
    });
  };
  const operation = policy(resolve).authorize({ url: publicUrl, context });
  let settled = false;
  const refusal = operation.catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(501);
  expect(settled, 'CALLBACK_DEADLINE_NOT_OBSERVED').toBe(true);
  expect(await refusal).toMatchObject({ code: 'DNS_TIMEOUT' });
  expect(signal.aborted).toBe(true);
  finish(global);
  await Promise.resolve();
  expect((await policy(async () => global).authorize({ url: publicUrl, context })).revision).toBe(
    11
  );
});
it('bounds the total chain even when every individual callback is within its own deadline', async () => {
  vi.useFakeTimers();
  const operation = policy(async (host) => {
    await new Promise((done) => setTimeout(done, 400));
    return { ...empty, cname: ['next.' + host] };
  }).authorize({ url: publicUrl, context });
  const refusal = expect(operation).rejects.toMatchObject({ code: 'ABORTED' });
  await vi.advanceTimersByTimeAsync(2001);
  await refusal;
});
it('honors caller cancellation and never invokes a pre-aborted resolver', async () => {
  const abort = new AbortController();
  abort.abort();
  const resolve = vi.fn(async () => global);
  await expect(
    policy(resolve).authorize({ url: publicUrl, context, signal: abort.signal })
  ).rejects.toMatchObject({ code: 'ABORTED' });
  expect(resolve).not.toHaveBeenCalled();
});
it('refuses public adjacent ports before DNS and keeps admin denial before port/grant policy', async () => {
  const resolve = vi.fn(async () => global);
  const engine = policy(resolve);
  await expect(
    engine.authorize({ url: 'https://public.fixture.invalid:444/', context })
  ).rejects.toMatchObject({ code: 'FORBIDDEN_PORT' });
  await expect(engine.authorize({ url: 'http://127.0.0.1:4242/', context })).rejects.toMatchObject({
    code: 'ADMIN_DENIED',
  });
  expect(resolve).not.toHaveBeenCalled();
});
it('issues only exact literal short-lived owner/workspace/browser-generation grants and refuses copied handles', async () => {
  let now = 1000;
  const resolve = vi.fn(async () => global);
  const engine = policy(resolve, { now: () => now });
  const url = 'http://127.0.0.1:9001/';
  const grant = engine.issueLocalGrant(context, url, 301000);
  expect(await engine.authorize({ url, context, grant })).toMatchObject({
    scope: 'local',
    expiresAt: 301000,
    endpoints: [{ address: '127.0.0.1', family: 4, port: 9001 }],
  });
  for (const input of [
    { url: 'http://127.0.0.1:9002/', context, grant },
    { url: 'ws://127.0.0.1:9001/', context, grant },
    { url, context: { ...context, ownerId: 'other' }, grant },
    { url, context: { ...context, workspaceId: 'other' }, grant },
    { url, context: { ...context, browserId: 'other' }, grant },
    { url, context: { ...context, browserGeneration: 8 }, grant },
    { url, context, grant: { ...grant } },
  ])
    await expect(engine.authorize(input)).rejects.toMatchObject({ code: 'GRANT_REFUSED' });
  expect(resolve).not.toHaveBeenCalled();
  now = 301000;
  await expect(engine.authorize({ url, context, grant })).rejects.toMatchObject({
    code: 'GRANT_REFUSED',
  });
});
it('denies grants to named/LAN/mapped/admin targets and excessive or invalid expiries', () => {
  const engine = policy(async () => global, { now: () => 1000 });
  for (const url of [
    'http://localhost:9001/',
    'http://192.168.1.5:9001/',
    'http://[::ffff:127.0.0.1]:9001/',
    'http://127.0.0.1:4242/',
    'http://127.0.0.1:9001/path',
  ])
    expect(() => engine.issueLocalGrant(context, url, 2000)).toThrow();
  for (const expiresAt of [1000, 999, 301001, Infinity, 2000.5])
    expect(() => engine.issueLocalGrant(context, 'http://127.0.0.1:9001/', expiresAt)).toThrow();
});
it('revokes grants immediately, rejects another policy issuer, and rejects clock rollback', async () => {
  let now = 1000;
  const engine = policy(async () => global, { now: () => now });
  const url = 'http://[::1]:9001/';
  const grant = engine.issueLocalGrant(context, url, 2000);
  await expect(
    policy(async () => global, { now: () => now }).authorize({ url, context, grant })
  ).rejects.toMatchObject({ code: 'GRANT_REFUSED' });
  now = 999;
  await expect(engine.authorize({ url, context, grant })).rejects.toMatchObject({
    code: 'GRANT_REFUSED',
  });
  now = 1000;
  engine.revokeLocalGrant(grant);
  await expect(engine.authorize({ url, context, grant })).rejects.toMatchObject({
    code: 'GRANT_REFUSED',
  });
});
it('refuses bad policy/binding and snapshots admin lists rather than trusting later list edits', async () => {
  expect(() =>
    policy(async () => global, { privateAdminEndpoints: [{ address: '8.8.8.8', port: 443 }] })
  ).toThrow();
  expect(() => policy(async () => global, { revision: -1 })).toThrow();
  const adminAuthorities = ['https://admin.fixture.invalid'];
  const engine = policy(async () => global, { adminAuthorities });
  adminAuthorities.length = 0;
  await expect(
    engine.authorize({ url: 'https://admin.fixture.invalid/', context })
  ).rejects.toMatchObject({ code: 'ADMIN_DENIED' });
  await expect(
    engine.authorize({ url: publicUrl, context: { ...context, browserGeneration: NaN } })
  ).rejects.toMatchObject({ code: 'INVALID_BINDING' });
});

it('keeps finite callback slots occupied after timeouts until actual ignored-abort resolvers settle', async () => {
  vi.useFakeTimers();
  const finish: ((value: typeof global) => void)[] = [];
  const resolve = vi.fn<DestinationResolver>(() => new Promise((done) => finish.push(done)));
  const engine = policy(resolve);
  const requests = Array.from({ length: 32 }, () =>
    engine.authorize({ url: publicUrl, context }).catch((error: unknown) => error)
  );
  await vi.advanceTimersByTimeAsync(501);
  for (const result of await Promise.all(requests))
    expect(result).toMatchObject({ code: 'DNS_TIMEOUT' });
  const blocked = engine.authorize({ url: publicUrl, context }).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(501);
  expect(await blocked).toMatchObject({ code: 'DNS_LIMIT' });
  expect(resolve).toHaveBeenCalledTimes(32);
  finish[0]!(global);
  await vi.advanceTimersByTimeAsync(0);
  const fresh = engine.authorize({ url: publicUrl, context });
  await vi.advanceTimersByTimeAsync(0);
  expect(resolve).toHaveBeenCalledTimes(33);
  finish[32]!(global);
  expect((await fresh).revision).toBe(11);
  for (const done of finish.slice(1, 32)) done(global);
});

it('aborts an in-flight resolver without waiting for a non-cooperative callback', async () => {
  const abort = new AbortController();
  let invoked!: () => void;
  const started = new Promise<void>((done) => {
    invoked = done;
  });
  const resolve: DestinationResolver = () => {
    invoked();
    return new Promise(() => {});
  };
  const operation = policy(resolve).authorize({ url: publicUrl, context, signal: abort.signal });
  const refusal = expect(operation).rejects.toMatchObject({ code: 'ABORTED' });
  await started;
  abort.abort();
  await refusal;
});

it('does not allow any local grant to override a configured host interface deny', () => {
  const engine = policy(async () => global, { hostInterfaces: ['127.0.0.1'], now: () => 1000 });
  expect(() => engine.issueLocalGrant(context, 'http://127.0.0.1:9001/', 2000)).toThrow();
});

it.each(['http://8.8.8.8/', 'https://8.8.8.8/', 'ws://8.8.8.8/', 'wss://[2606:4700:4700::1111]/'])(
  'implements every permitted public scheme %s',
  async (url) => {
    const resolve = vi.fn(async () => global);
    expect((await policy(resolve).authorize({ url, context })).scope).toBe('public');
    expect(resolve).not.toHaveBeenCalled();
  }
);
it('permanently denies private admin numeric aliases before local grants even without a named authority match', async () => {
  const engine = policy(async () => global, {
    adminAuthorities: [],
    privateAdminEndpoints: [{ address: '127.0.0.1', port: 9001 }],
    now: () => 1000,
  });
  await expect(engine.authorize({ url: 'http://127.0.0.1:9001/', context })).rejects.toMatchObject({
    code: 'ADMIN_DENIED',
  });
  expect(() => engine.issueLocalGrant(context, 'http://127.0.0.1:9001/', 2000)).toThrowError(
    'ADMIN_DENIED'
  );
});

it('refuses an answer observed beyond its host-monotonic deadline even before the timer callback runs', async () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    const resolve = vi.fn(async () => {
      clock.mockReturnValue(601);
      return global;
    });
    await expect(policy(resolve).authorize({ url: publicUrl, context })).rejects.toMatchObject({
      code: 'DNS_TIMEOUT',
    });
    expect(resolve).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});

it('redacts malformed typed resolver codes and failures of the injected grant clock', async () => {
  const secret = 'SECRET_CLOCK_OR_RESOLVER_TOKEN';
  const error = await policy(async () => {
    throw new EgressPolicyError(secret as EgressPolicyCode);
  })
    .authorize({ url: publicUrl, context })
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: 'INVALID_POLICY' });
  expect(String(error)).not.toContain(secret);
  const engine = policy(async () => global, {
    now: () => {
      throw Error(secret);
    },
  });
  try {
    engine.issueLocalGrant(context, 'http://127.0.0.1:9001/', 2000);
    throw Error('GRANT_UNEXPECTEDLY_ISSUED');
  } catch (refused) {
    expect(refused).toMatchObject({ code: 'GRANT_REFUSED' });
    expect(String(refused)).not.toContain(secret);
  }
});
