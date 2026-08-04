import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFeedbackMethods } from '../feedback-methods';

const originalFetch = globalThis.fetch;

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createFeedbackMethods().sendFeedback', () => {
  it('POSTs to /feedback and relays the honest { ok }', async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const methods = createFeedbackMethods('/api');
    const result = await methods.sendFeedback({ kind: 'bug', message: 'it broke' });

    expect(result).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/feedback');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
  });

  it('resolves { ok: false } (never throws) on a network error', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const methods = createFeedbackMethods('/api');
    await expect(methods.sendFeedback({ kind: 'feedback', message: 'hi' })).resolves.toEqual({
      ok: false,
    });
  });
});

describe('createFeedbackMethods().listMyFeedback', () => {
  it('GETs /feedback/mine and returns the parsed list', async () => {
    const items = [
      {
        id: 'row-1',
        kind: 'bug',
        message: 'it broke',
        status: 'in_progress',
        createdAt: '2026-08-01T00:00:00.000Z',
      },
    ];
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(items), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const methods = createFeedbackMethods('/api');
    const result = await methods.listMyFeedback();

    expect(result).toEqual(items);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/feedback/mine');
  });

  it('rejects (does not swallow) on a non-OK response — the tracking view handles the error itself', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'Could not reach the feedback service' }), {
          status: 502,
        })
    ) as unknown as typeof fetch;

    const methods = createFeedbackMethods('/api');
    await expect(methods.listMyFeedback()).rejects.toThrow();
  });
});
