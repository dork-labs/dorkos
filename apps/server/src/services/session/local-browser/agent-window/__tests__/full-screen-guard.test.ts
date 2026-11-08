/** The full screen guard, with a fake DevTools session. Nothing here launches a browser. */
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { FullScreenGuard, withFullScreenRefused, type GuardSession } from '../full-screen-guard.js';

type Handler = (event: Record<string, unknown>) => void;

function fakeSession(fullScreen: unknown = false) {
  const handlers = new Map<string, Handler>();
  const send = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f1' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Runtime.evaluate') return { result: { value: fullScreen } };
    return {};
  });
  const session = {
    send,
    on: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)),
  } as unknown as GuardSession;
  return { session, send, handlers };
}
const page = (closed = false) => ({ isClosed: () => closed }) as unknown as Page;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the header', () => {
  it('keeps every header the site sent, in order, and adds the refusal last', () => {
    const site = [
      { name: 'Content-Security-Policy', value: "default-src 'self'" },
      { name: 'Permissions-Policy', value: 'camera=(), fullscreen=*' },
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' },
    ];
    expect(withFullScreenRefused(site)).toEqual([
      ...site,
      { name: 'Permissions-Policy', value: 'fullscreen=()' },
    ]);
  });

  it('is added to a document as it arrives, for documents only', async () => {
    const { session, send, handlers } = fakeSession();
    new FullScreenGuard(async () => session).watch(page());
    await settle();
    expect(send).toHaveBeenCalledWith('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }],
    });
    handlers.get('Fetch.requestPaused')!({
      requestId: 'r1',
      responseStatusCode: 200,
      responseStatusText: 'OK',
      responseHeaders: [{ name: 'X-Site', value: 'kept' }],
    });
    await settle();
    expect(send).toHaveBeenCalledWith('Fetch.continueResponse', {
      requestId: 'r1',
      responseCode: 200,
      responsePhrase: 'OK',
      responseHeaders: [
        { name: 'X-Site', value: 'kept' },
        { name: 'Permissions-Policy', value: 'fullscreen=()' },
      ],
    });
  });

  it('lets a redirect through untouched', async () => {
    const { session, send, handlers } = fakeSession();
    new FullScreenGuard(async () => session).watch(page());
    await settle();
    handlers.get('Fetch.requestPaused')!({ requestId: 'r2', responseStatusCode: 302 });
    await settle();
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'r2' });
    expect(send).not.toHaveBeenCalledWith('Fetch.continueResponse', expect.anything());
  });

  it('never leaves a page hanging when the header can’t be added', async () => {
    const { session, send, handlers } = fakeSession();
    const original = send.getMockImplementation()!;
    send.mockImplementation(async (method, params) => {
      if (method === 'Fetch.continueResponse') throw new Error('gone');
      return original(method, params);
    });
    new FullScreenGuard(async () => session).watch(page());
    await settle();
    handlers.get('Fetch.requestPaused')!({ requestId: 'r3', responseStatusCode: 200 });
    await settle();
    expect(send).toHaveBeenCalledWith('Fetch.continueRequest', { requestId: 'r3' });
  });
});

describe('reading full screen', () => {
  it('reads from an isolated world, not the page’s own', async () => {
    const { session, send } = fakeSession(false);
    const guard = new FullScreenGuard(async () => session);
    const target = page();
    guard.watch(target);
    await expect(guard.inFullScreen(target)).resolves.toBe(false);
    expect(send).toHaveBeenCalledWith('Runtime.evaluate', {
      expression: 'document.fullscreenElement !== null',
      contextId: 7,
      returnByValue: true,
    });
  });

  it('says yes when a page is in full screen', async () => {
    const { session } = fakeSession(true);
    const guard = new FullScreenGuard(async () => session);
    const target = page();
    guard.watch(target);
    await expect(guard.inFullScreen(target)).resolves.toBe(true);
  });

  it('fails closed: unwatched, no session, a failed read, or a strange answer', async () => {
    await expect(
      new FullScreenGuard(async () => fakeSession().session).inFullScreen(page())
    ).resolves.toBe(true);

    const refused = new FullScreenGuard(async () => {
      throw new Error('no session');
    });
    const one = page();
    refused.watch(one);
    await expect(refused.inFullScreen(one)).resolves.toBe(true);

    const broken = fakeSession();
    broken.send.mockRejectedValue(new Error('closed'));
    const failing = new FullScreenGuard(async () => broken.session);
    const two = page();
    failing.watch(two);
    await expect(failing.inFullScreen(two)).resolves.toBe(true);

    const odd = new FullScreenGuard(async () => fakeSession('maybe').session);
    const three = page();
    odd.watch(three);
    await expect(odd.inFullScreen(three)).resolves.toBe(true);
  });
});

describe('refusing an agent', () => {
  it('passes with nothing watched, as in the Mac app’s panel', async () => {
    await expect(new FullScreenGuard().requireNone()).resolves.toBeUndefined();
  });

  it('refuses when any watched page is in full screen, and forgets closed ones', async () => {
    const calm = fakeSession(false).session;
    const full = fakeSession(true).session;
    const sessions = [calm, full];
    const guard = new FullScreenGuard(async () => sessions.shift()!);
    guard.watch(page());
    guard.watch(page());
    await expect(guard.requireNone()).rejects.toMatchObject({ code: 'full_screen' });
    const closed = new FullScreenGuard(async () => full);
    closed.watch(page(true));
    await expect(closed.requireNone()).resolves.toBeUndefined();
  });
});
