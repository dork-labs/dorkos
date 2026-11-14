import { expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { createBackgroundPage } from '../chat/background-page.js';

it('creates a background target in the owned context without reading personal pages', async () => {
  const parent = {} as Page;
  const child = { url: vi.fn(), title: vi.fn() } as unknown as Page;
  let predicate!: (page: Page) => Promise<boolean>;
  const send = vi.fn(async (method: string) =>
    method === 'Target.createTarget'
      ? { targetId: 'child' }
      : { targetInfo: { browserContextId: 'owned-context' } }
  );
  const detach = vi.fn(async () => undefined);
  const context = {
    newPage: vi.fn(),
    pages: vi.fn(),
    newCDPSession: vi.fn(async (page: Page) =>
      page === parent
        ? { send, detach }
        : { send: vi.fn(async () => ({ targetInfo: { targetId: 'child' } })), detach }
    ),
    waitForEvent: vi.fn(async (_name: string, options: { predicate: typeof predicate }) => {
      predicate = options.predicate;
      expect(await predicate(child)).toBe(true);
      return child;
    }),
  } as unknown as BrowserContext;
  expect(await createBackgroundPage(context, parent)).toBe(child);
  expect(send).toHaveBeenCalledWith('Target.createTarget', {
    url: 'about:blank',
    browserContextId: 'owned-context',
    background: true,
  });
  expect(context.pages).not.toHaveBeenCalled();
  expect(context.newPage).not.toHaveBeenCalled();
  expect(child.url).not.toHaveBeenCalled();
  expect(child.title).not.toHaveBeenCalled();
});
