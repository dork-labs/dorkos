import { it, expect, vi, afterEach } from 'vitest';
import { createEgressPolicy, type DestinationResolver } from '../index.js';

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
