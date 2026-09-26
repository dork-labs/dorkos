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
    const fetchMock = answerWith({ packages: [] });
    const methods = createMarketplaceMethods('/api');

    await methods.listInstalledPackages();
    await methods.listInstalledPackages(undefined, { verify: true });
    await methods.listInstalledPackages('/Users/me/my repo', { verify: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/marketplace/installed',
      '/api/marketplace/installed?verify=true',
      '/api/marketplace/installed?projectPath=%2FUsers%2Fme%2Fmy+repo&verify=true',
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
