/**
 * Calls that carry a folder or a name holding `/` or `\` keep it out of the URL
 * path (DOR-4212). Remote Access refuses an encoded `/` or `\` in a path, so a
 * value that lands there fails over the tunnel and works only at the desk. The
 * server's tunnel tests send these same URLs through both remote listeners
 * (`apps/server/src/services/core/remote/__tests__/app-own-routes.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMarketplaceMethods } from '../marketplace-methods';
import { createMeshMethods } from '../mesh-methods';

const originalFetch = globalThis.fetch;

/** Install a fetch that answers every call with `body` at `status`, and records it. */
function answerWith(body: unknown, status = 200) {
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The path half of a URL: what the tunnel filter reads. */
function pathOf(url: unknown): string {
  return String(url).split('?')[0]!;
}

describe('values holding / or \\ ride outside the URL path (DOR-4212)', () => {
  it.each(['/Users/qa/projects/demo-agent', 'C:\\Users\\qa\\projects\\demo-agent'])(
    'Unblock agent sends %s in the query string',
    async (folder) => {
      const fetchMock = answerWith({ success: true });
      await createMeshMethods('/api').clearMeshDenial(folder);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(init?.method).toBe('DELETE');
      expect(url).toBe(`/api/mesh/denied?path=${encodeURIComponent(folder)}`);
      expect(pathOf(url)).not.toMatch(/%2f|%5c/i);
    }
  );

  it('removing a source sends its name in the query string', async () => {
    const fetchMock = answerWith(null, 204);
    await createMarketplaceMethods('/api').removeMarketplaceSource('acme/plugins');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('DELETE');
    expect(url).toBe('/api/marketplace/sources?name=acme%2Fplugins');
  });

  it('refreshing a source sends its name in the query string', async () => {
    const fetchMock = answerWith({ marketplace: {}, fetchedAt: 'now', stale: false });
    await createMarketplaceMethods('/api').refreshMarketplaceSource('acme/plugins');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect(url).toBe('/api/marketplace/sources/refresh?name=acme%2Fplugins');
  });
});
