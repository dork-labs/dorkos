/** @vitest-environment jsdom */
/**
 * Every "Confirm it's you" call carries the stamp the server wrote into this
 * page (DOR-5026), so the server can tell a page loaded after a mini app risk
 * cleared from one loaded before it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cancelHeldAction, confirmWithPassword, readHeldAction } from '../model/confirm-action';

const fetchSpy = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ ok: true, status: 200, result: {} }), { status: 200 })
);

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
});

function stampSent(call: number): string | null {
  return new Headers(fetchSpy.mock.calls[call]?.[1]?.headers).get('x-dorkos-page-stamp');
}

describe('the page stamp on step-up calls', () => {
  it('goes with reads, confirms and cancels, beside the JSON body', async () => {
    document.head.innerHTML = '<meta name="dorkos-page-stamp" content="v1.made-up.stamp">';
    await readHeldAction('held-1', '/api');
    await confirmWithPassword('held-1', 'pw', '/api');
    await cancelHeldAction('held-1', '/api');
    expect([stampSent(0), stampSent(1), stampSent(2)]).toEqual([
      'v1.made-up.stamp',
      'v1.made-up.stamp',
      'v1.made-up.stamp',
    ]);
    expect(new Headers(fetchSpy.mock.calls[1]?.[1]?.headers).get('Content-Type')).toBe(
      'application/json'
    );
  });

  it('is left off when the page has none (the dev server)', async () => {
    await confirmWithPassword('held-1', 'pw', '/api');
    expect(stampSent(0)).toBeNull();
  });
});
