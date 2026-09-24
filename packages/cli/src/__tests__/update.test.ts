import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

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

/** One server check result; defaults describe an available update. */
function check(overrides: Record<string, unknown> = {}) {
  return {
    packageName: 'demo-pkg',
    installedVersion: '1.2.0',
    latestVersion: '1.3.0',
    hasUpdate: true,
    marketplace: 'dorkos-community',
    status: 'update-available',
    installedVersionSource: 'package',
    latestVersionSource: 'package',
    ...overrides,
  };
}

const ADVISORY_RESULT = { checks: [check()], applied: [] };

/** Everything printed to stdout, one string. */
function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

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
    expect(() => parseUpdateArgs(['--nope'])).toThrow(
      /Unknown option for 'marketplace update': --nope/
    );
  });
});

describe('runUpdate', () => {
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

  it('prints one line per check in each of the three kinds', async () => {
    // Purpose: an update, a current package and an unknown one each read
    // differently, and a commit-identified version prints as a short commit.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        checks: [
          check({ packageName: 'flow', installedVersion: '0.7.2', latestVersion: '0.7.3' }),
          check({
            packageName: 'same',
            installedVersion: '1.0.0',
            latestVersion: '1.0.0',
            hasUpdate: false,
            status: 'current',
          }),
          check({
            packageName: 'offline',
            latestVersion: '',
            hasUpdate: false,
            marketplace: '',
            status: 'unknown',
            note: "couldn't reach github.com",
          }),
          check({
            packageName: 'by-commit',
            installedVersion: 'abc1234def5678abc1234def5678abc1234def56',
            latestVersion: 'fedcba9876543210fedcba9876543210fedcba98',
            installedVersionSource: 'commit',
            latestVersionSource: 'commit',
            marketplace: '',
          }),
        ],
        applied: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUpdate({ name: 'flow' });

    expect(code).toBe(0);
    const out = printed(logSpy);
    expect(out).toContain('flow  0.7.2 → 0.7.3  (dorkos-community)');
    expect(out).toContain('same  up to date (1.0.0)');
    expect(out).toContain("offline  could not check: couldn't reach github.com");
    expect(out).toContain('by-commit  commit abc1234 → commit fedcba9');
  });

  it('prints the spec example for one available update in advisory mode', async () => {
    // Purpose: the exact line a person sees, including how to install it.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            check({ packageName: 'flow', installedVersion: '0.7.2', latestVersion: '0.7.3' }),
          ],
          applied: [],
        })
      )
    );

    await runUpdate({ name: 'flow', projectPath: '/p' });

    expect(printed(logSpy)).toContain('1 update available. Run again with --apply to install it.');
  });

  it('never says everything is up to date while a package could not be checked', async () => {
    // Purpose: the old summary said "All N up to date" about a set that
    // silently excluded the packages it could not check.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            check({ hasUpdate: false, status: 'current', latestVersion: '1.2.0' }),
            check({
              packageName: 'flow',
              status: 'unknown',
              hasUpdate: false,
              latestVersion: '',
              note: "couldn't reach github.com",
            }),
          ],
          applied: [],
        })
      )
    );

    const code = await runUpdate({ name: 'demo-pkg' });

    expect(code).toBe(0);
    const out = printed(logSpy);
    expect(out).not.toMatch(/All \d+/);
    expect(out).toContain('1 up to date, 1 could not be checked.');
  });

  it('exits 1 when a named package is installed nowhere', async () => {
    // Purpose: `dorkos update <typo>` must fail loudly for a script, as it did
    // before the per-target isolation turned the 404 into a printed line.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(mockResponse(404, { error: 'Package not installed: flwo' }))
    );

    const code = await runUpdate({ name: 'flwo' });

    expect(code).toBe(1);
    expect(printed(logSpy)).toContain('flwo  could not check: Package not installed: flwo');
  });

  it('exits 1 when a requested apply fails', async () => {
    // Purpose: a script running `--apply` must be able to tell that an
    // update did not land.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(mockResponse(500, { error: 'install failed' }))
    );

    const code = await runUpdate({ name: 'demo-pkg', apply: true });

    expect(code).toBe(1);
    expect(printed(logSpy)).toContain('demo-pkg  could not check: install failed');
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
    const out = printed(logSpy);
    expect(out).toContain('Applied:');
    expect(out).toContain('demo-pkg@1.3.0');
    // No --apply hint when we actually applied.
    expect(out).not.toContain('Run again with --apply');
  });

  describe('without a name: the all-packages door', () => {
    /** One installation's check; defaults describe a global update. */
    function installation(overrides: Record<string, unknown> = {}) {
      return {
        ...check({ packageName: 'flow', installedVersion: '0.7.2', latestVersion: '0.7.3' }),
        installPath: '/home/me/.dork/plugins/flow',
        type: 'plugin',
        scope: 'global',
        ...overrides,
      };
    }

    it('checks every installation with one request, naming where each non-global one lives', async () => {
      // Purpose: a name-less run used to list installs and then send one
      // request per package; the same package in two places must still read
      // as two different lines.
      const fetchMock = vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            installation({ hasUpdate: false, status: 'current', latestVersion: '0.7.2' }),
            installation({
              scope: 'override',
              agentPath: '/work/alpha',
              agentName: 'Alpha',
              installPath: '/work/alpha/.dork/plugins/flow',
            }),
            installation({
              scope: 'agent-local',
              agentPath: '/work/beta',
              installPath: '/work/beta/.dork/plugins/flow',
              status: 'unknown',
              hasUpdate: false,
              latestVersion: '',
              marketplace: '',
              note: "couldn't reach github.com",
            }),
          ],
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const code = await runUpdate({});

      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/marketplace\/updates$/);
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
      const out = printed(logSpy);
      expect(out).toContain('flow  up to date (0.7.2)');
      expect(out).toContain('flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)');
      expect(out).toContain("flow [/work/beta]  could not check: couldn't reach github.com");
      expect(out).toContain('1 update available, 1 up to date, 1 could not be checked.');
    });

    it("checks one project's view with --project", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, { checks: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await runUpdate({ projectPath: '/work/my app' });

      expect(fetchMock.mock.calls[0][0]).toContain(
        `/api/marketplace/updates?projectPath=${encodeURIComponent('/work/my app')}`
      );
    });

    it('says so when nothing is installed', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockResponse(200, { checks: [] })));

      const code = await runUpdate({});

      expect(code).toBe(0);
      expect(printed(logSpy)).toContain('No installed packages to check.');
    });

    it('--apply sends one POST and lists what it reinstalled, by place', async () => {
      // Purpose: applying is one request too, and the output says which copy
      // of a package was updated.
      const fetchMock = vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          checks: [
            installation({
              scope: 'override',
              agentPath: '/work/alpha',
              agentName: 'Alpha',
              applied: {
                ok: true,
                packageName: 'flow',
                version: '0.7.3',
                installPath: '/work/alpha/.dork/plugins/flow',
              },
            }),
          ],
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const code = await runUpdate({ apply: true, projectPath: '/work/alpha' });

      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/marketplace\/updates$/);
      expect(fetchMock.mock.calls[0][1].method).toBe('POST');
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
        apply: true,
        projectPath: '/work/alpha',
      });
      const out = printed(logSpy);
      expect(out).toContain('Applied:');
      expect(out).toContain('  flow [Alpha]@0.7.3 → /work/alpha/.dork/plugins/flow');
      expect(out).not.toContain('Run again with --apply');
    });

    it('exits 1 and says why when a reinstall failed, after listing the ones that landed', async () => {
      // Purpose: a script running --apply must be able to tell that an update
      // did not land, and a person must see which one and why.
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce(
          mockResponse(200, {
            checks: [
              installation({
                applied: { ok: true, packageName: 'flow', version: '0.7.3', installPath: '/p' },
              }),
              installation({
                packageName: 'broken',
                scope: 'agent-local',
                agentPath: '/work/alpha',
                agentName: 'Alpha',
                applyError: 'disk full',
              }),
            ],
          })
        )
      );

      const code = await runUpdate({ apply: true });

      expect(code).toBe(1);
      const out = printed(logSpy);
      expect(out).toContain('  flow@0.7.3 → /p');
      expect(out).toContain('Could not update:');
      expect(out).toContain('  broken [Alpha]: disk full');
    });

    it('exits 1 with the server’s reason when the request itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse(403, { error: 'Access denied: projectPath outside boundary' })
          )
      );

      const code = await runUpdate({ projectPath: '/etc' });

      expect(code).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Access denied: projectPath outside boundary'
      );
    });
  });

  it('exits 1 with the "Cannot reach" message when the server is unreachable', async () => {
    // Purpose: failing to reach the server at all is the one error that
    // still ends the run.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const code = await runUpdate({ name: 'demo-pkg' });

    expect(code).toBe(1);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Cannot reach DorkOS server'
    );
  });
});
