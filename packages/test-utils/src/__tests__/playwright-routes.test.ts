import { describe, expect, it, vi } from 'vitest';
import { interceptNext, type FallbackRoute } from '../playwright-routes.js';

interface FakeRoute extends FallbackRoute {
  method: string;
  fallback: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

/** A stand-in page that records the one handler registered and never unregisters it. */
function fakePage() {
  const registered: Array<(route: FakeRoute) => unknown> = [];
  const page = {
    route: vi.fn(async (_url: string | RegExp, handler: (route: FakeRoute) => unknown) => {
      registered.push(handler);
    }),
  };
  const send = async (method = 'GET') => {
    const route: FakeRoute = { method, fallback: vi.fn(async () => {}) };
    await registered[0]!(route);
    return route;
  };
  return { page, registered, send };
}

describe('interceptNext', () => {
  it('handles the first request, then passes every later one through while staying registered', async () => {
    const { page, registered, send } = fakePage();
    const handle = vi.fn();
    await interceptNext(page, '**/claim', handle);

    const first = await send();
    const second = await send();
    const third = await send();

    expect(page.route).toHaveBeenCalledTimes(1);
    expect(page.route).toHaveBeenCalledWith('**/claim', expect.any(Function));
    expect(registered).toHaveLength(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(first);
    expect(first.fallback).not.toHaveBeenCalled();
    expect(second.fallback).toHaveBeenCalledTimes(1);
    expect(third.fallback).toHaveBeenCalledTimes(1);
  });

  it('intercepts exactly `count` requests', async () => {
    const { page, send } = fakePage();
    const handle = vi.fn();
    await interceptNext(page, '**/settings', handle, { count: 2 });

    const routes = [await send(), await send(), await send()];

    expect(handle).toHaveBeenCalledTimes(2);
    expect(routes.map((route) => route.fallback.mock.calls.length)).toEqual([0, 0, 1]);
  });

  it('lets filtered-out requests through without spending the count', async () => {
    const { page, send } = fakePage();
    const handle = vi.fn();
    await interceptNext(page, '**/settings', handle, {
      filter: (route) => route.method === 'GET',
    });

    const write = await send('PATCH');
    const read = await send('GET');
    const laterRead = await send('GET');

    expect(write.fallback).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(handle).toHaveBeenCalledWith(read);
    expect(laterRead.fallback).toHaveBeenCalledTimes(1);
  });

  it('rejects a count that could never intercept anything', () => {
    const { page } = fakePage();
    expect(() => interceptNext(page, '**/x', vi.fn(), { count: 0 })).toThrow(RangeError);
    expect(() => interceptNext(page, '**/x', vi.fn(), { count: 1.5 })).toThrow(RangeError);
    expect(page.route).not.toHaveBeenCalled();
  });
});
