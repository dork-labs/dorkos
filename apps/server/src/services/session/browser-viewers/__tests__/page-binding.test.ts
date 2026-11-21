import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaseFixture } from '../../local-browser/__tests__/page-leases-fixture.js';
const principal = { ownerId: 'owner', sessionId: 'app', clientId: 'client' };
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  const view = await f.service.viewerPages.resolve('chat-a', principal, 'viewer');
  return { ...f, page, view };
}
describe('broker-backed viewer binding', () => {
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
  it('preserves synchronous protected-origin refusal without a page read', async () => {
    const f = await setup();
    const url = vi.spyOn(f.page.page, 'url').mockReturnValue('https://dorkos.ai');
    try {
      expect(() => f.view.assertLive()).toThrow('viewer_unavailable');
      expect(f.view.signal.aborted).toBe(true);
      expect(f.page.page.locator).toBeDefined();
    } finally {
      url.mockRestore();
      await f.view.close();
    }
  });
  it('ends a watch on navigation, including same-address reload', async () => {
    const f = await setup();
    f.page.navigate('https://example.com');
    expect(f.view.signal.aborted).toBe(true);
    await expect(f.view.assertCurrent()).rejects.toThrow('viewer_unavailable');
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
