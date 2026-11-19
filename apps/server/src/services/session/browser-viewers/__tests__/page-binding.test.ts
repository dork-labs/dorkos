import { EventEmitter } from 'node:events';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { BrowserViewerBinding } from '../page-binding.js';

function fixture() {
  const events = new EventEmitter();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    mainFrame: () => mainFrame,
    isClosed: () => false,
  } as unknown as Page;
  const identity = {
    chatId: 'chat',
    profileId: 'profile',
    connectionId: 'connection',
    tabId: 'tab',
  };
  let current: { identity: typeof identity; page: Page } | undefined = { identity, page };
  const authorize = vi.fn(async (_chat: string): Promise<void> => undefined);
  const protect = vi.fn(() => undefined);
  const binding = new BrowserViewerBinding(() => current, authorize, protect);
  return {
    binding,
    events,
    mainFrame,
    page,
    identity,
    authorize,
    protect,
    replace: (next: typeof current) => {
      current = next;
      binding.refresh();
    },
  };
}

describe('browser viewer page binding', () => {
  it('shares one immutable binding only for the current holding chat', async () => {
    const f = fixture();
    await expect(f.binding.resolve('another-chat')).rejects.toThrow('viewer_unavailable');
    const page = await f.binding.resolve('chat');
    expect(await f.binding.resolve('chat')).toBe(page);
    expect(page.identity).toEqual(f.identity);
    expect(Object.isFrozen(page.identity)).toBe(true);
    expect(f.authorize).toHaveBeenCalledWith('chat');
  });

  it('rechecks the profile grant on every delivery', async () => {
    const f = fixture();
    const page = await f.binding.resolve('chat');
    f.authorize.mockRejectedValueOnce(Error('private profile detail'));
    await expect(page.assertCurrent()).rejects.toThrow('viewer_unavailable');
    expect(page.signal.aborted).toBe(true);
  });

  it('refuses synchronously when a prepared frame now contains a protected page', async () => {
    const f = fixture();
    const page = await f.binding.resolve('chat');
    f.protect.mockImplementationOnce(() => {
      throw Error('private page detail');
    });
    expect(() => page.assertLive()).toThrow('viewer_unavailable');
    expect(page.signal.aborted).toBe(true);
    expect(f.events.listenerCount('framenavigated')).toBe(0);
  });

  it('fences a holder change while authorization is awaited', async () => {
    const f = fixture();
    let finish!: () => void;
    f.authorize.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.binding.resolve('chat');
    f.replace({ identity: { ...f.identity, chatId: 'other' }, page: f.page });
    finish();
    await expect(pending).rejects.toThrow('viewer_unavailable');
  });

  it.each(['chatId', 'profileId', 'connectionId', 'tabId'] as const)(
    'revokes the old subscription when %s changes',
    async (key) => {
      const f = fixture();
      const page = await f.binding.resolve('chat');
      f.replace({ identity: { ...f.identity, [key]: 'replacement' }, page: f.page });
      expect(page.signal.aborted).toBe(true);
      await expect(page.assertCurrent()).rejects.toThrow('viewer_unavailable');
    }
  );

  it('never inherits a binding when the Page changes with reused ids', async () => {
    const f = fixture();
    const page = await f.binding.resolve('chat');
    f.replace({ identity: f.identity, page: { ...f.page } as Page });
    expect(page.signal.aborted).toBe(true);
    expect(await f.binding.resolve('chat')).not.toBe(page);
  });

  it('revokes on main-frame navigation, including a same-address reload', async () => {
    const f = fixture();
    const page = await f.binding.resolve('chat');
    f.events.emit('framenavigated', {});
    expect(page.signal.aborted).toBe(false);
    f.events.emit('framenavigated', f.mainFrame);
    expect(page.signal.aborted).toBe(true);
    expect(f.events.listenerCount('framenavigated')).toBe(0);
    expect(await f.binding.resolve('chat')).not.toBe(page);
  });

  it('revokes synchronously when the connection closes', async () => {
    const f = fixture();
    const page = await f.binding.resolve('chat');
    f.replace(undefined);
    expect(page.signal.aborted).toBe(true);
    await expect(f.binding.resolve('chat')).rejects.toThrow('viewer_unavailable');
  });
});
