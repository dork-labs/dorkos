import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { deriveDefaultName, runMarketplaceAdd } from '../commands/marketplace-add.js';
import { runMarketplaceRemove } from '../commands/marketplace-remove.js';
import { renderSourcesTable, runMarketplaceList } from '../commands/marketplace-list.js';
import { runMarketplaceRefresh } from '../commands/marketplace-refresh.js';

/**
 * Build a fetch `Response`-like object that the api-client can consume.
 * Mirrors the helper used by `install.test.ts`.
 */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const SOURCE_FIXTURE_A = {
  name: 'dorkos-community',
  source: 'https://github.com/dorkos/marketplace',
  enabled: true,
  addedAt: '2026-04-06T00:00:00.000Z',
};

const SOURCE_FIXTURE_B = {
  name: 'claude-plugins-official',
  source: 'https://github.com/anthropics/claude-plugins-official',
  enabled: true,
  addedAt: '2026-04-06T00:00:00.000Z',
};

describe('deriveDefaultName', () => {
  it.each([
    ['https://github.com/acme/.github', 'github'],
    ['https://github.com/acme/-team_tools', 'team_tools'],
    ['https://example.com/my%20plugins', 'my-plugins'],
    ['file:///Users/me/My Marketplace', 'my-marketplace'],
    ['https://github.com/acme/...', 'marketplace'],
  ])('derives a name the server accepts from %s (DOR-2304)', (url, name) => {
    // Purpose: the server now refuses names that could not key the listing
    // cache, and a name the CLI made up itself must never be one of them.
    expect(deriveDefaultName(url)).toBe(name);
    expect(deriveDefaultName(url)).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/);
  });
});

describe('runMarketplaceAdd', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('POSTs to /sources with the derived name and prints confirmation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(201, SOURCE_FIXTURE_A));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceAdd({ url: 'https://github.com/dorkos/marketplace' });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/sources');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      name: 'marketplace',
      source: 'https://github.com/dorkos/marketplace',
      enabled: true,
    });

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain("Added marketplace 'dorkos-community'");
    expect(allLogs).toContain('https://github.com/dorkos/marketplace');
  });

  it('prints what to do next when the server refuses an agent (DOR-502)', async () => {
    // An AGENT running this verb is the caller the server refuses, so the CLI
    // has to print the half of the refusal that says "ask the person", not just
    // the one-line "no".
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(403, {
        type: 'urn:dorkos:problem:operator_only',
        title: 'Only the person at this computer can do that.',
        status: 403,
        code: 'operator_only',
        detail: 'DorkOS added nothing. Ask them to run `dorkos marketplace add <url> --name <n>`.',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceAdd({ url: 'https://attacker.example/marketplace' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('DorkOS added nothing.');
    expect(allErr).toContain('Ask them to run');
  });

  it('says exactly where in the app to add it when it needs you signed in (DOR-3330)', async () => {
    const message = "Adding a source needs you signed in. Add it in the app's Marketplace sources.";
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(403, {
          type: 'urn:dorkos:problem:person_only',
          title: 'Only a person can do that, not an agent.',
          status: 403,
          code: 'person_only',
          detail: message,
        })
      )
    );

    const code = await runMarketplaceAdd({ url: 'https://example.com/marketplace' });

    expect(code).toBe(1);
    // One line, as written: no "Error:" prefix, no status.
    expect(errSpy.mock.calls.map((c) => String(c[0]))).toEqual([message]);
  });
});

describe('runMarketplaceRemove', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('DELETEs the named source and prints confirmation', async () => {
    // 204 No Content — apiCall returns undefined; the test should still
    // see the confirmation log line and a zero exit code.
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 204,
      statusText: 'No Content',
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRemove({ name: 'dorkos-community' });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/sources/dorkos-community');
    expect(init.method).toBe('DELETE');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain("Removed marketplace 'dorkos-community'");
  });
});

describe('renderSourcesTable', () => {
  it("shows how each source's last fetch went, and why one failed (DOR-2324)", () => {
    // Purpose: the terminal tells the same story as the app's rows: packages
    // ready, never loaded, or an older copy still listed, with the reason.
    const when = new Date('2026-09-20T08:00:00.000Z').toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const table = renderSourcesTable([
      {
        ...SOURCE_FIXTURE_A,
        name: 'ok',
        lastFetch: { state: 'fetched', checkedAt: 'x', packageCount: 12 },
      },
      {
        ...SOURCE_FIXTURE_A,
        name: 'one',
        lastFetch: { state: 'fetched', checkedAt: 'x', packageCount: 1 },
      },
      { ...SOURCE_FIXTURE_A, name: 'new', lastFetch: { state: 'never' } },
      {
        ...SOURCE_FIXTURE_A,
        name: 'broken',
        lastFetch: {
          state: 'failed',
          checkedAt: 'x',
          reason: "there's no marketplace listing at that address",
        },
      },
      {
        ...SOURCE_FIXTURE_A,
        name: 'old',
        lastFetch: {
          state: 'stale',
          checkedAt: 'x',
          reason: 'the server at that address refused the connection',
          copyFetchedAt: '2026-09-20T08:00:00.000Z',
          packageCount: 3,
        },
      },
      { ...SOURCE_FIXTURE_A, name: 'legacy' },
    ]);
    const row = (name: string) => table.split('\n').find((l) => l.startsWith(`${name} `)) ?? '';

    expect(table.split('\n')[0]).toMatch(/^NAME\s+SOURCE\s+ENABLED\s+PACKAGES$/);
    expect(row('ok')).toMatch(/12 packages$/);
    expect(row('one')).toMatch(/1 package$/);
    expect(row('new')).toMatch(/not fetched yet$/);
    expect(row('broken')).toMatch(/didn't load$/);
    expect(row('old')).toMatch(/3 packages \(older copy\)$/);
    expect(row('legacy')).toMatch(/yes$/);
    expect(table).toContain(
      "broken: its packages didn't load: there's no marketplace listing at that address. " +
        'Run `dorkos marketplace refresh broken` to try again.'
    );
    expect(table).toContain(
      "old: couldn't fetch its listing: the server at that address refused the connection. " +
        `Still listing the copy from ${when}.`
    );
  });
});

describe('runMarketplaceList', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('renders seeded sources from the server', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { sources: [SOURCE_FIXTURE_A, SOURCE_FIXTURE_B] }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceList();

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/sources');
    expect(init.method).toBe('GET');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('NAME');
    expect(allLogs).toContain('dorkos-community');
    expect(allLogs).toContain('claude-plugins-official');
  });
});

describe('runMarketplaceRefresh', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('refreshes a single named source and prints the package count', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        marketplace: { name: 'dorkos-community', plugins: new Array(47).fill({}) },
        fetchedAt: '2026-04-06T00:00:00.000Z',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRefresh({ name: 'dorkos-community' });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/sources/dorkos-community/refresh');
    expect(init.method).toBe('POST');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Refreshed dorkos-community: 47 packages.');
  });

  it('says plainly when it could only show the last copy, and exits 1 (DOR-2304)', async () => {
    // Purpose: a refresh is "check now". When the source can't be reached the
    // server answers with its last copy marked stale; printing "Refreshed"
    // would claim a check that did not happen.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          marketplace: { name: 'dorkos-community', plugins: new Array(3).fill({}) },
          fetchedAt: '2026-04-06T09:30:00.000Z',
          stale: true,
          reason: 'the server at that address refused the connection',
        })
      )
    );

    const code = await runMarketplaceRefresh({ name: 'dorkos-community' });

    expect(code).toBe(1);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).not.toContain('Refreshed');
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const when = new Date('2026-04-06T09:30:00.000Z').toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    expect(allErr).toContain(
      `Couldn't reach dorkos-community: the server at that address refused the connection. ` +
        `Still showing the last copy, from ${when} (3 packages).`
    );
  });

  it('reports per-source failures via Promise.allSettled and exits non-zero', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, { sources: [SOURCE_FIXTURE_A, SOURCE_FIXTURE_B] }))
      .mockResolvedValueOnce(
        mockResponse(200, {
          marketplace: { plugins: new Array(5).fill({}) },
          fetchedAt: '2026-04-06T00:00:00.000Z',
        })
      )
      .mockResolvedValueOnce(
        mockResponse(502, {
          title: 'Refused.',
          status: 502,
          code: 'upstream_unavailable',
          detail: 'Network timeout',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRefresh({});

    expect(code).toBe(1);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Refreshed dorkos-community: 5 packages.');
    expect(allErr).toContain('Failed claude-plugins-official');
    expect(allErr).toContain('Network timeout');
  });
});
