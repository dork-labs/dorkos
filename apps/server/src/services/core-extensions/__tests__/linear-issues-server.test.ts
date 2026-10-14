/**
 * The Linear Loop core extension's API (DOR-2859): its three routes, served
 * as a Hono fetch handler, called with `app.request()`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import register, { createApp } from '../../../core-extensions/linear-issues/server.js';

/** A context with the given secret and stored data. */
function ctx(apiKey: string | null, stored: unknown) {
  return {
    secrets: { get: vi.fn(async () => apiKey) },
    storage: { loadData: vi.fn(async () => stored), saveData: vi.fn() },
    settings: { get: vi.fn(async () => null) },
    schedule: vi.fn(),
    emit: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('linear-issues API', () => {
  it('answers /loop with the stored Loop data, and null before the first poll', async () => {
    const loop = { health: { triage: 1 }, categories: {}, updatedAt: 1 };

    const stored = await createApp(ctx('k', { loop }) as never).request('/loop');
    const empty = await createApp(ctx('k', null) as never).request('/loop');

    expect(await stored.json()).toEqual(loop);
    expect(await empty.json()).toBeNull();
  });

  it('answers /cached with the stored data, or an empty record', async () => {
    const stored = await createApp(ctx('k', { data: { a: 1 } }) as never).request('/cached');
    const empty = await createApp(ctx('k', null) as never).request('/cached');

    expect(await stored.json()).toEqual({ data: { a: 1 } });
    expect(await empty.json()).toEqual({ data: null });
  });

  it('answers /issues with 503 when no key is set, without calling Linear', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await createApp(ctx(null, null) as never).request('/issues');

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Linear API key not configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers /issues with what Linear sent, and 502 when Linear fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ data: { viewer: { assignedIssues: { nodes: [] } } } }))
    );
    const ok = await createApp(ctx('k', null) as never).request('/issues');
    expect(await ok.json()).toEqual({ data: { viewer: { assignedIssues: { nodes: [] } } } });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 }))
    );
    const failed = await createApp(ctx('k', null) as never).request('/issues');
    expect(failed.status).toBe(502);
  });

  it('answers a path it does not serve with a JSON 404', async () => {
    const res = await createApp(ctx('k', null) as never).request('/nothing');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('serves its API as a fetch handler and adds nothing to the old router', async () => {
    const router = { get: vi.fn(), post: vi.fn(), put: vi.fn(), use: vi.fn() };
    const context = ctx('k', { loop: null });

    const result = (await register(router as never, context as never)) as {
      fetch: (request: Request) => Promise<Response>;
    };

    expect(Object.values(router).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(context.schedule).toHaveBeenCalledTimes(1);
    expect((await result.fetch(new Request('http://x/loop'))).status).toBe(200);
  });
});
