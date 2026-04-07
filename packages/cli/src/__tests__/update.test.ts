import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseUpdateArgs, runUpdate } from '../commands/update.js';

/**
 * Build a fetch `Response`-like object that the api-client can consume.
 */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const ADVISORY_RESULT = {
  checks: [
    {
      packageName: 'demo-pkg',
      installedVersion: '1.2.0',
      latestVersion: '1.3.0',
      hasUpdate: true,
      marketplace: 'dorkos-community',
    },
  ],
  applied: [],
};

describe('parseUpdateArgs', () => {
  it('parses a bare invocation with no args', () => {
    const args = parseUpdateArgs([]);
    expect(args).toEqual({ name: undefined, apply: false, projectPath: undefined });
  });

  it('parses a single name', () => {
    const args = parseUpdateArgs(['demo-pkg']);
    expect(args.name).toBe('demo-pkg');
  });

  it('parses --apply and --project', () => {
    const args = parseUpdateArgs(['demo-pkg', '--apply', '--project', '/tmp/web']);
    expect(args).toEqual({ name: 'demo-pkg', apply: true, projectPath: '/tmp/web' });
  });

  it('throws on unknown option', () => {
    expect(() => parseUpdateArgs(['--nope'])).toThrow(/Unknown option for 'update': --nope/);
  });
});

describe('runUpdate', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('checks a single package and prints the advisory line', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, ADVISORY_RESULT));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({ name: 'demo-pkg', apply: false });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/packages/demo-pkg/update');
    expect(JSON.parse(init.body)).toEqual({ apply: false });

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('demo-pkg: 1.2.0 → 1.3.0');
    expect(allLogs).toContain('--apply');
  });

  it('--apply sends apply: true and renders the applied list', async () => {
    const appliedResult = {
      checks: ADVISORY_RESULT.checks,
      applied: [
        {
          ok: true,
          packageName: 'demo-pkg',
          version: '1.3.0',
          installPath: '/home/user/.dork/plugins/demo-pkg',
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, appliedResult));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({ name: 'demo-pkg', apply: true });

    expect(code).toBe(0);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ apply: true });

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Applied:');
    expect(allLogs).toContain('demo-pkg@1.3.0');
    // No --apply hint when we actually applied.
    expect(allLogs).not.toContain('(run with --apply');
  });

  it('without a name: GETs installed list, then iterates each', async () => {
    const fetchMock = vi
      .fn()
      // First call: GET installed
      .mockResolvedValueOnce(
        mockResponse(200, { packages: [{ name: 'pkg-a' }, { name: 'pkg-b' }] })
      )
      // Then one update call per package.
      .mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            {
              packageName: 'pkg-a',
              installedVersion: '1.0.0',
              latestVersion: '1.0.1',
              hasUpdate: true,
              marketplace: 'm',
            },
          ],
          applied: [],
        })
      )
      .mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            {
              packageName: 'pkg-b',
              installedVersion: '2.0.0',
              latestVersion: '2.0.0',
              hasUpdate: false,
              marketplace: 'm',
            },
          ],
          applied: [],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({});

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain('/api/marketplace/installed');
    expect(fetchMock.mock.calls[1][0]).toContain('/api/marketplace/packages/pkg-a/update');
    expect(fetchMock.mock.calls[2][0]).toContain('/api/marketplace/packages/pkg-b/update');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('pkg-a: 1.0.0 → 1.0.1');
    expect(allLogs).toContain('1 package(s) already up to date.');
  });

  it('without a name and zero installed packages: prints "No installed packages"', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, { packages: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({});

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('No installed packages to check.');
  });

  it('returns 1 and prints an error when the API call fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(500, { error: 'Marketplace cache unreadable' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({ name: 'demo-pkg' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Marketplace cache unreadable');
  });

  it('reports up-to-date when no checks return hasUpdate: true', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        checks: [
          {
            packageName: 'demo-pkg',
            installedVersion: '1.0.0',
            latestVersion: '1.0.0',
            hasUpdate: false,
            marketplace: 'm',
          },
        ],
        applied: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({ name: 'demo-pkg' });

    expect(code).toBe(0);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('All 1 package(s) up to date.');
  });
});
