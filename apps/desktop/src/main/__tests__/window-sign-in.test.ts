import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));

import { signInWindow, SIGN_IN_CODE_TIMEOUT_MS } from '../sign-in/window-sign-in';

/**
 * A server process that answers the mint message the way `server-entry.ts`
 * does, or not at all.
 */
function fakeServer(answer: string | null | 'silent' | 'junk') {
  const handlers: ((msg: unknown) => void)[] = [];
  const sent: unknown[] = [];
  return {
    sent,
    child: {
      on: (_event: 'message', handler: (msg: unknown) => void) => void handlers.push(handler),
      send: (msg: unknown) => {
        sent.push(msg);
        if (answer === 'silent') return;
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler({ type: 'ready' });
            handler(
              answer === 'junk'
                ? { type: 'sign-in-code', code: 42 }
                : { type: 'sign-in-code', code: answer }
            );
          }
        });
      },
    } as never,
  };
}

describe('the desktop window signing in by itself', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('asks the server for a code over the process channel, and posts it through the window`s session', async () => {
    const { child, sent } = fakeServer('the-code');
    const fetch = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    expect(await signInWindow({ child, port: 51234, fetch })).toBe('signed-in');
    expect(sent).toEqual([{ type: 'mint-sign-in-code' }]);
    expect(fetch).toHaveBeenCalledWith('http://localhost:51234/api/desktop/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'the-code' }),
    });
  });

  it('does nothing when nobody has an account yet', async () => {
    const fetch = vi.fn();
    expect(await signInWindow({ ...fakeServer(null), port: 1, fetch })).toBe('no-owner');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives up, without throwing, when the server never answers or answers nonsense', async () => {
    const fetch = vi.fn();
    const silent = signInWindow({ ...fakeServer('silent'), port: 1, fetch });
    await vi.advanceTimersByTimeAsync(SIGN_IN_CODE_TIMEOUT_MS);
    expect(await silent).toBe('failed');
    const junk = signInWindow({ ...fakeServer('junk'), port: 1, fetch });
    await vi.advanceTimersByTimeAsync(SIGN_IN_CODE_TIMEOUT_MS);
    expect(await junk).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a refused or failed post, without throwing', async () => {
    const refused = vi.fn(async () => new Response('{}', { status: 401 }));
    expect(await signInWindow({ ...fakeServer('c'), port: 1, fetch: refused })).toBe('failed');
    const broken = vi.fn(async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED');
    });
    expect(await signInWindow({ ...fakeServer('c'), port: 1, fetch: broken })).toBe('failed');
  });
});
