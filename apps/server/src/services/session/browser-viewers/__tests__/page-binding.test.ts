import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_ORIGIN, CLOUD_WEBSITE } from '@dorkos/shared/cloud-origin';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
const principal = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup(url = 'https://example.com') {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate(url);
  const view = await f.service.viewerPages.resolve('chat-a', principal, 'viewer');
  return { ...f, page, view };
}
describe('broker-backed viewer binding', () => {
  it.each([
    ['https://example.com', 'https://other.example.org'],
    ['https://example.com', 'http://example.com'],
    ['https://example.com', 'about:blank'],
    ['https://example.com', CLOUD_WEBSITE],
    ['https://example.com', CLOUD_ORIGIN],
    ['https://alice.github.io', 'https://bob.github.io'],
    ['http://localhost:3000', 'http://localhost:4000'],
    ['https://example.com', 'https://example.com./'],
  ])('ends the captured watch on site drop %s → %s', async (from, to) => {
    const f = await setup(from);
    f.page.navigate(to);
    expect(() => f.view.assertLive()).toThrow('viewer_unavailable');
    expect(f.view.signal.aborted).toBe(true);
    f.page.navigate(from);
    expect(() => f.view.assertLive()).toThrow('viewer_unavailable');
    await f.view.close();
  });
  it('retains same-site subdomains without changing the server Page binding', async () => {
    const f = await setup(),
      binding = f.view.binding;
    f.page.navigate('https://shop.example.com/next');
    await expect(f.view.assertCurrent()).resolves.toBeUndefined();
    expect(f.view.binding).toBe(binding);
    expect(f.view.signal.aborted).toBe(false);
    await f.view.close();
  });
  it.each([
    ['first', 'unknown'],
    ['renewed', 'unknown'],
    ['first', 'sign-in refusal'],
    ['renewed', 'sign-in refusal'],
  ] as const)(
    'ends a failed %s safety watch on %s; existing Resume works without a lease',
    async (when, reason) => {
      const address = reason === 'unknown' ? 'https://example.com' : 'https://accounts.google.com';
      const f = await setup(address);
      if (when === 'renewed') await f.view.takeControl();
      const attach = vi.mocked(f.contexts[0].context.newCDPSession),
        original = attach.getMockImplementation()!;
      attach.mockImplementation(async (page) => {
        const session = await original(page);
        const send = vi.mocked(session.send),
          base = send.getMockImplementation()!;
        send.mockImplementation((async (method: string, params: Record<string, unknown>) =>
          method === 'Runtime.evaluate'
            ? {
                result: {
                  value:
                    reason === 'unknown'
                      ? { title: 'Page', text: 'ordinary', extra: true }
                      : { title: 'Sign in', text: 'This browser or app may not be secure' },
                },
              }
            : (base as (method: string, params: Record<string, unknown>) => Promise<unknown>)(
                method,
                params
              )) as never);
        return session;
      });
      if (when === 'first') await expect(f.view.takeControl()).rejects.toBeDefined();
      else f.page.navigate(`${address}/next`);
      await vi.waitFor(() => expect(f.view.signal.aborted).toBe(true));
      await expect(f.observe('chat-a')).rejects.toBeDefined();
      await f.service.personSession('chat-a').handover.resume();
      await expect(f.observe('chat-a')).resolves.toBeDefined();
      await f.view.close();
    }
  );

  it('captures distinct viewer authority over the same full server binding', async () => {
    const f = await setup();
    const next = await f.service.viewerPages.resolve(
      'chat-a',
      { ...principal, clientId: 'second' },
      'second'
    );
    expect(next).not.toBe(f.view);
    expect(next.binding).toEqual(f.view.binding);
    expect(Object.keys(f.view.binding)).toEqual(
      expect.arrayContaining([
        'sessionId',
        'profileId',
        'connectionId',
        'profileConnectionGeneration',
        'leaseId',
        'tabId',
      ])
    );
    expect(f.view.identity.chatId).toBe('chat-a');
    expect(Object.isFrozen(f.view.binding)).toBe(true);
    await f.view.close();
    await expect(next.assertCurrent()).resolves.toBeUndefined();
    await next.close();
  });
  it('rechecks profile access around awaited delivery', async () => {
    const f = await setup();
    const access = vi.fn(async () => {
      throw Error('private detail');
    });
    f.service.useProfileAccess(access, () => true);
    await expect(f.view.assertCurrent()).rejects.toThrow('viewer_unavailable');
    expect(f.view.signal.aborted).toBe(true);
    await f.view.close();
  });
  it.each([CLOUD_WEBSITE, CLOUD_ORIGIN, 'http://localhost:4242'])(
    'preserves synchronous protected-origin refusal without a page read: %s',
    async (address) => {
      const f = await setup();
      const url = vi.spyOn(f.page.page, 'url').mockReturnValue(address);
      try {
        expect(() => f.view.assertLive()).toThrow('viewer_unavailable');
        expect(f.view.signal.aborted).toBe(true);
        expect(f.page.page.locator).toBeDefined();
      } finally {
        url.mockRestore();
        await f.view.close();
      }
    }
  );
  it('retains current Page authority while advancing same-address navigation metadata', async () => {
    const f = await setup();
    const before = f.view.facts().navigationGeneration;
    f.page.navigate('https://example.com');
    expect(f.view.signal.aborted).toBe(false);
    expect(f.view.facts().navigationGeneration).toBeGreaterThan(before);
    await expect(f.view.assertCurrent()).resolves.toBeUndefined();
    await f.view.close();
  });
  it('revokes a held viewer synchronously when its grant ends', async () => {
    const f = await setup();
    await f.service.personSession('chat-a').handToPerson();
    const revoked = f.service.revokeProfileAccess('agent-atlas');
    expect(f.view.signal.aborted).toBe(true);
    await revoked;
    await f.view.close();
  });
});
