import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuditMethods } from '../audit-methods';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub `fetch` to answer every request with `body`, and hand back the stub. */
function answer(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('createAuditMethods', () => {
  const methods = createAuditMethods('/api');

  it('reads the audit log with only the filters it was given', async () => {
    const fetchMock = answer({ events: [], nextBeforeSeq: 3 });
    await expect(
      methods.listAuditEvents({ action: 'config.', beforeSeq: 9, limit: 50 })
    ).resolves.toEqual({ events: [], nextBeforeSeq: 3 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/audit?action=config.&beforeSeq=9&limit=50');
  });

  it('reads one account’s timeline, the id escaped into the path', async () => {
    const fetchMock = answer({ events: [] });
    await methods.getAccountTimeline('install:a b', { limit: 50 });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/audit/accounts/install%3Aa%20b/timeline?limit=50'
    );
  });
});
