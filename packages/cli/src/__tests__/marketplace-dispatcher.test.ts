import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { runMarketplaceDispatcher } from '../commands/marketplace-dispatcher.js';

/** Build a fetch `Response`-like object that the api-client can consume. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

/** Everything printed through a console spy, one string. */
function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('runMarketplaceDispatcher', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
  let writeSpy: MockInstance<typeof process.stdout.write>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    writeSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('lists every package and source subcommand in its help', async () => {
    // Purpose: `dorkos marketplace --help` is where a person finds package
    // management; every verb has to be named there (DOR-2193 acceptance).
    expect(await runMarketplaceDispatcher('--help', [])).toBe(0);

    const help = printed(logSpy);
    for (const verb of [
      'install <name>',
      'update [<name>]',
      'uninstall <name>',
      'installed',
      'outdated',
      'add <url>',
      'remove <name>',
      'list',
      'refresh',
      'validate <path-or-url>',
    ]) {
      expect(help).toContain(verb);
    }
    expect(help).toMatch(/dorkos install.*shorthand/is);
  });

  it.each(['install', 'update', 'uninstall', 'installed', 'outdated'])(
    'prints help for `%s --help` without calling the server',
    async (verb) => {
      // Purpose: each package verb documents itself under its canonical name.
      expect(await runMarketplaceDispatcher(verb, ['--help'])).toBe(0);

      expect(printed(logSpy)).toContain(`Usage: dorkos marketplace ${verb}`);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('documents the outdated exit codes in its help', async () => {
    await runMarketplaceDispatcher('outdated', ['-h']);

    const help = printed(logSpy);
    expect(help).toMatch(/0\s+Every installed package is up to date/);
    expect(help).toMatch(/1\s+At least one package has an update/);
    expect(help).toMatch(/2\s+Could not tell/);
  });

  it('routes `installed` to GET /installed', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { packages: [] }));

    expect(await runMarketplaceDispatcher('installed', [])).toBe(0);

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/marketplace\/installed$/);
  });

  it('routes `outdated` to GET /updates and passes its exit code through', async () => {
    // Purpose: the dispatcher must not flatten outdated's 1 (stale) into a
    // generic success or failure.
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, {
        checks: [
          {
            packageName: 'flow',
            installedVersion: '0.7.2',
            latestVersion: '0.7.3',
            hasUpdate: true,
            marketplace: 'dorkos-community',
            status: 'update-available',
            installPath: '/home/u/.dork/plugins/flow',
            type: 'plugin',
            scope: 'global',
          },
        ],
      })
    );

    expect(await runMarketplaceDispatcher('outdated', [])).toBe(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/api\/marketplace\/updates$/);
  });

  it('exits 2, not 1, when outdated is given a bad option', async () => {
    // Purpose: a usage mistake is "could not tell" (2); exiting 1 would tell a
    // script that something is stale.
    expect(await runMarketplaceDispatcher('outdated', ['--nope'])).toBe(2);
    expect(printed(errSpy)).toMatch(/Unknown option for 'marketplace outdated': --nope/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes `update <name>` to the per-package door', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { checks: [], applied: [] }));

    expect(await runMarketplaceDispatcher('update', ['flow'])).toBe(0);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/marketplace\/packages\/flow\/update$/);
    expect(JSON.parse(String(init.body))).toEqual({ apply: false });
  });

  it('routes `uninstall <name>` to the uninstall door', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { ok: true, packageName: 'flow', removedFiles: 3, preservedData: [] })
    );

    expect(await runMarketplaceDispatcher('uninstall', ['flow'])).toBe(0);

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(
      /\/api\/marketplace\/packages\/flow\/uninstall$/
    );
  });

  it('names the canonical command when a package verb gets a bad option', async () => {
    expect(await runMarketplaceDispatcher('install', ['flow', '--nope'])).toBe(1);
    expect(printed(errSpy)).toMatch(/Unknown option for 'marketplace install': --nope/);
  });

  it('lists every subcommand when given an unknown one', async () => {
    expect(await runMarketplaceDispatcher('upgrade', [])).toBe(1);

    const err = printed(errSpy);
    expect(err).toContain('Unknown marketplace subcommand: upgrade');
    expect(err).toContain('install|update|uninstall|installed|outdated');
  });
});
