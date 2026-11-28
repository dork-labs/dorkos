import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckFilesResult } from '@dorkos/shared/marketplace-schemas';

import { createMarketplaceMethods } from '../marketplace-methods';

const originalFetch = globalThis.fetch;

/** Install a fetch that answers every call with `body` and records it. */
function answerWith(body: unknown) {
  const fetchMock = vi.fn(
    async (_url: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status: 200 })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => vi.restoreAllMocks());
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createMarketplaceMethods().listInstalledPackages (DOR-2197)', () => {
  // Purpose: verification is opt-in (it reads every shipped file), so a plain
  // list never asks for it, and a verified one says so in the query.
  it('asks for verification only when told to', async () => {
    const fetchMock = answerWith({ packages: [], nextCursor: null });
    const methods = createMarketplaceMethods('/api');

    await methods.listInstalledPackages();
    await methods.listInstalledPackages(undefined, { verify: true });
    await methods.listInstalledPackages('/Users/me/my repo', { verify: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/marketplace/installed?limit=200',
      '/api/marketplace/installed?verify=true&limit=200',
      '/api/marketplace/installed?projectPath=%2FUsers%2Fme%2Fmy+repo&verify=true&limit=200',
    ]);
  });

  // Purpose: the list comes in pages (DOR-4982); the app reads every page and
  // keeps the server's order, so the installs show as they did before paging.
  it('reads every page, in the order the server sent them', async () => {
    const pages = [
      { packages: [{ name: 'zeta' }, { name: 'alpha' }], nextCursor: 'c1' },
      { packages: [{ name: 'mid' }], nextCursor: null },
    ];
    const fetchMock = vi.fn(
      async (_url: unknown) => new Response(JSON.stringify(pages.shift()), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const rows = await createMarketplaceMethods('/api').listInstalledPackages();

    expect(rows.map((row) => row.name)).toEqual(['zeta', 'alpha', 'mid']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/marketplace/installed?limit=200',
      '/api/marketplace/installed?cursor=c1&limit=200',
    ]);
  });
});

describe('createMarketplaceMethods().checkPackageFiles (DOR-2320)', () => {
  // Purpose: the action POSTs the one installation the row names, and returns
  // the server's outcome and sentence untouched.
  it('POSTs the installation to prepare and returns what happened', async () => {
    const result: CheckFilesResult = { outcome: 'rebuilt', message: 'DorkOS now knows.' };
    const fetchMock = answerWith(result);

    const answer = await createMarketplaceMethods('/api').checkPackageFiles('flow', {
      installRoot: '/home/.dork/plugins/flow',
    });

    expect(answer).toEqual(result);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/marketplace/packages/flow/check-files');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      installRoot: '/home/.dork/plugins/flow',
    });
  });
});
