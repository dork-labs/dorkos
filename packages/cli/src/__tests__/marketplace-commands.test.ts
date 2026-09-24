import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import {
  deriveDefaultName,
  parseMarketplaceAddArgs,
  runMarketplaceAdd,
} from '../commands/marketplace-add.js';
import {
  parseMarketplaceRemoveArgs,
  runMarketplaceRemove,
} from '../commands/marketplace-remove.js';
import {
  parseMarketplaceListArgs,
  renderSourcesTable,
  runMarketplaceList,
} from '../commands/marketplace-list.js';
import {
  parseMarketplaceRefreshArgs,
  runMarketplaceRefresh,
} from '../commands/marketplace-refresh.js';

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

describe('parseMarketplaceAddArgs', () => {
  it('parses a bare URL with no name flag', () => {
    const args = parseMarketplaceAddArgs(['https://github.com/dorkos/marketplace']);
    expect(args).toEqual({ url: 'https://github.com/dorkos/marketplace', name: undefined });
  });

  it('parses --name', () => {
    const args = parseMarketplaceAddArgs([
      'https://github.com/dorkos/marketplace',
      '--name',
      'community',
    ]);
    expect(args.name).toBe('community');
  });

  it('throws on missing url', () => {
    expect(() => parseMarketplaceAddArgs([])).toThrow(/Missing required <url>/);
  });

  it('throws on unknown option', () => {
    expect(() => parseMarketplaceAddArgs(['https://example.com/repo', '--nope'])).toThrow(
      /Unknown option for 'marketplace add': --nope/
    );
  });
});

describe('deriveDefaultName', () => {
  it('uses the last path segment for github URLs', () => {
    expect(deriveDefaultName('https://github.com/dorkos/marketplace')).toBe('marketplace');
  });

  it('strips .git suffix', () => {
    expect(deriveDefaultName('https://github.com/anthropics/claude-plugins-official.git')).toBe(
      'claude-plugins-official'
    );
  });

  it('lowercases the result', () => {
    expect(deriveDefaultName('https://github.com/Acme/Plugins')).toBe('plugins');
  });

  it('falls back to "marketplace" for hostname-only URLs', () => {
    expect(deriveDefaultName('https://example.com/')).toBe('marketplace');
  });

  it('handles SSH-style git URLs by treating the whole string as a path', () => {
    expect(deriveDefaultName('git@github.com:dorkos/marketplace.git')).toBe('marketplace');
  });

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

  it('says the listing is ready and how many packages it names (DOR-2304)', async () => {
    // Purpose: the operator learns in plain words that they can install now.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse(201, { ...SOURCE_FIXTURE_A, listing: { fetched: true, packageCount: 12 } })
        )
    );

    const code = await runMarketplaceAdd({ url: 'https://github.com/dorkos/marketplace' });

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Fetched its listing: 12 packages.');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('says the listing could not be fetched yet, why, and how to retry — and still exits 0 (DOR-2304)', async () => {
    // Purpose: the add worked, so the exit code says so; the warning names
    // the reason and the exact refresh command to run later.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(201, {
          ...SOURCE_FIXTURE_A,
          listing: {
            fetched: false,
            reason: "the marketplace server didn't answer within 15 seconds",
          },
        })
      )
    );

    const code = await runMarketplaceAdd({ url: 'https://github.com/dorkos/marketplace' });

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain("Added marketplace 'dorkos-community'");
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain(
      "Couldn't fetch its listing yet: the marketplace server didn't answer within 15 seconds."
    );
    expect(allErr).toContain('dorkos marketplace refresh dorkos-community');
  });

  it('uses --name when supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(201, SOURCE_FIXTURE_A));
    vi.stubGlobal('fetch', fetchMock);

    await runMarketplaceAdd({
      url: 'https://github.com/dorkos/marketplace',
      name: 'dorkos-community',
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.name).toBe('dorkos-community');
  });

  it('renders a friendly hint on HTTP 409 duplicate name', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(409, { error: 'Source already exists' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceAdd({
      url: 'https://github.com/dorkos/marketplace',
      name: 'dorkos-community',
    });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain("'dorkos-community' already exists");
    expect(allErr).toContain('--name');
  });

  it('prints what to do next when the server refuses an agent (DOR-502)', async () => {
    // An AGENT running this verb is the caller the server refuses, so the CLI
    // has to print the half of the refusal that says "ask the person", not just
    // the one-line "no".
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(403, {
        error: 'Only the person running DorkOS can add a package source',
        code: 'operator_only_marketplace_source',
        message: 'DorkOS added nothing. Ask them to run `dorkos marketplace add <url> --name <n>`.',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceAdd({ url: 'https://attacker.example/marketplace' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Only the person running DorkOS can add a package source');
    expect(allErr).toContain('Ask them to run');
  });
});

describe('parseMarketplaceRemoveArgs', () => {
  it('parses a bare name', () => {
    expect(parseMarketplaceRemoveArgs(['dorkos-community'])).toEqual({ name: 'dorkos-community' });
  });

  it('throws on missing name', () => {
    expect(() => parseMarketplaceRemoveArgs([])).toThrow(/Missing required <name>/);
  });

  it('throws on unknown option', () => {
    expect(() => parseMarketplaceRemoveArgs(['dorkos-community', '--force'])).toThrow(
      /Unknown option for 'marketplace remove': --force/
    );
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

  it('renders a friendly error on HTTP 404', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(404, { error: 'Not found' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRemove({ name: 'missing' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain("'missing' not found");
  });

  it('prints what to do next when the server refuses an agent (DOR-502)', async () => {
    // The sibling of the `runMarketplaceAdd` case above, and it needs its own
    // test rather than inheriting that one's coverage: the two handlers have
    // separate error ladders, so a 403 branch present in one says nothing about
    // the other. Without this the `remove` branch could be deleted outright and
    // the suite would stay green.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(403, {
        error: 'Only the person running DorkOS can remove a package source',
        code: 'operator_only_marketplace_source',
        message:
          'DorkOS removed nothing. Ask them to run `dorkos marketplace remove <name>` themselves.',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRemove({ name: 'dorkos-community' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Only the person running DorkOS can remove a package source');
    expect(allErr).toContain('Ask them to run');
  });
});

describe('parseMarketplaceListArgs', () => {
  it('accepts no arguments', () => {
    expect(() => parseMarketplaceListArgs([])).not.toThrow();
  });

  it('throws on unknown option', () => {
    expect(() => parseMarketplaceListArgs(['--nope'])).toThrow(
      /Unknown option for 'marketplace list': --nope/
    );
  });
});

describe('renderSourcesTable', () => {
  it('renders header + rows aligned to widest cell', () => {
    const table = renderSourcesTable([SOURCE_FIXTURE_A, SOURCE_FIXTURE_B]);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/^NAME\s+SOURCE\s+ENABLED\s+PACKAGES$/);
    expect(lines[1]).toContain('dorkos-community');
    expect(lines[1]).toContain('https://github.com/dorkos/marketplace');
    expect(lines[1]).toContain('yes');
    expect(lines[2]).toContain('claude-plugins-official');
  });

  it('renders disabled state as "no"', () => {
    const table = renderSourcesTable([{ ...SOURCE_FIXTURE_A, enabled: false }]);
    expect(table).toContain(' no');
  });

  it('truncates very long source URLs', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(120);
    const table = renderSourcesTable([{ ...SOURCE_FIXTURE_A, source: longUrl }]);
    expect(table).toContain('...');
    // Truncated cell should be at most MAX_COLUMN_WIDTH (60) chars wide.
    const sourceCellMaxWidth = 60;
    const lines = table.split('\n');
    // Header row first; data row second. The source cell sits between two
    // other columns separated by two spaces — verify the data row contains
    // the truncated form.
    expect(lines[1]).toMatch(/https:\/\/example\.com\/a+\.\.\./);
    const truncatedSegment = lines[1].match(/https:\/\/example\.com\/a+\.\.\./);
    expect(truncatedSegment?.[0].length).toBeLessThanOrEqual(sourceCellMaxWidth);
  });
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

  it('prints empty-state hint when no sources are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, { sources: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceList();

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('No marketplaces configured');
  });
});

describe('parseMarketplaceRefreshArgs', () => {
  it('parses no positional', () => {
    expect(parseMarketplaceRefreshArgs([])).toEqual({ name: undefined });
  });

  it('parses an explicit name', () => {
    expect(parseMarketplaceRefreshArgs(['dorkos-community'])).toEqual({
      name: 'dorkos-community',
    });
  });

  it('throws on unknown option', () => {
    expect(() => parseMarketplaceRefreshArgs(['--force'])).toThrow(
      /Unknown option for 'marketplace refresh': --force/
    );
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

  it('falls back to the "packages" field name when "plugins" is absent', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        marketplace: { name: 'dorkos-community', packages: [{}] },
        fetchedAt: '2026-04-06T00:00:00.000Z',
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runMarketplaceRefresh({ name: 'dorkos-community' });

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Refreshed dorkos-community: 1 package.');
  });

  it('refreshes every source in parallel when no name is supplied', async () => {
    const fetchMock = vi
      .fn()
      // GET /sources
      .mockResolvedValueOnce(mockResponse(200, { sources: [SOURCE_FIXTURE_A, SOURCE_FIXTURE_B] }))
      // POST refresh for source A
      .mockResolvedValueOnce(
        mockResponse(200, {
          marketplace: { plugins: new Array(12).fill({}) },
          fetchedAt: '2026-04-06T00:00:00.000Z',
        })
      )
      // POST refresh for source B
      .mockResolvedValueOnce(
        mockResponse(200, {
          marketplace: { plugins: new Array(3).fill({}) },
          fetchedAt: '2026-04-06T00:00:00.000Z',
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRefresh({});

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refreshUrls = fetchMock.mock.calls.slice(1).map((c) => c[0]);
    expect(refreshUrls.some((u) => String(u).includes('dorkos-community/refresh'))).toBe(true);
    expect(refreshUrls.some((u) => String(u).includes('claude-plugins-official/refresh'))).toBe(
      true
    );

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Refreshed dorkos-community: 12 packages.');
    expect(allLogs).toContain('Refreshed claude-plugins-official: 3 packages.');
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
      .mockResolvedValueOnce(mockResponse(502, { error: 'Network timeout' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRefresh({});

    expect(code).toBe(1);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Refreshed dorkos-community: 5 packages.');
    expect(allErr).toContain('Failed claude-plugins-official');
    expect(allErr).toContain('Network timeout');
  });

  it('prints empty-state hint when no sources are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, { sources: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runMarketplaceRefresh({});

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('No marketplaces configured');
  });
});
