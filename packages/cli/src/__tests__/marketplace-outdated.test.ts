import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import {
  OUTDATED_EXIT,
  parseMarketplaceOutdatedArgs,
  runMarketplaceOutdated,
} from '../commands/marketplace-outdated.js';

/** Build a fetch `Response`-like object that the api-client can consume. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

/** One installation's check as `GET /api/marketplace/updates` returns it; an update by default. */
function check(overrides: Record<string, unknown> = {}) {
  return {
    packageName: 'flow',
    installedVersion: '0.7.2',
    latestVersion: '0.7.3',
    hasUpdate: true,
    marketplace: 'dorkos-community',
    status: 'update-available',
    installedVersionSource: 'package',
    latestVersionSource: 'package',
    installPath: '/home/u/.dork/plugins/flow',
    type: 'plugin',
    scope: 'global',
    ...overrides,
  };
}

const CURRENT = check({
  packageName: 'review',
  installPath: '/home/u/.dork/plugins/review',
  installedVersion: '1.0.0',
  latestVersion: '1.0.0',
  hasUpdate: false,
  status: 'current',
});

const LINKED = check({
  packageName: 'dev',
  installPath: '/home/u/.dork/plugins/dev',
  latestVersion: '',
  hasUpdate: false,
  marketplace: '',
  status: 'unknown',
  note: 'linked install — update its source instead',
  linked: true,
});

const UNKNOWN = check({
  packageName: 'offline-pkg',
  installPath: '/home/u/.dork/plugins/offline-pkg',
  latestVersion: '',
  hasUpdate: false,
  marketplace: '',
  status: 'unknown',
  note: 'could not reach github.com',
});

/** Everything printed to stdout through console.log, one string. */
function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('parseMarketplaceOutdatedArgs', () => {
  it('defaults to every scope and human output', () => {
    // Purpose: a bare `outdated` asks about every installation, not one project.
    expect(parseMarketplaceOutdatedArgs([])).toEqual({ projectPath: undefined, json: false });
  });

  it('parses --project and --json', () => {
    expect(parseMarketplaceOutdatedArgs(['--project', '/work/alpha', '--json'])).toEqual({
      projectPath: '/work/alpha',
      json: true,
    });
  });

  it('refuses a package name, since outdated always reports every installation', () => {
    // Purpose: `outdated flow` must not silently report everything as if the
    // name had narrowed it.
    expect(() => parseMarketplaceOutdatedArgs(['flow'])).toThrow(/Unexpected argument 'flow'/);
  });

  it('names the command on an unknown option', () => {
    expect(() => parseMarketplaceOutdatedArgs(['--apply'])).toThrow(
      /Unknown option for 'marketplace outdated': --apply/
    );
  });
});

describe('runMarketplaceOutdated', () => {
  let logSpy: MockInstance<typeof console.log>;
  let errSpy: MockInstance<typeof console.error>;
  let writeSpy: MockInstance<typeof process.stdout.write>;
  let fetchMock: ReturnType<typeof vi.fn>;

  /** Answer the one updates request with these checks. */
  function serverAnswers(checks: unknown[]): void {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { checks }));
  }

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

  it('asks the all-packages door exactly once', async () => {
    // Purpose: outdated is one request (DOR-2194 §6), never one per package.
    serverAnswers([check(), CURRENT]);

    await runMarketplaceOutdated({ json: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/marketplace\/updates$/);
    expect(init.method).toBe('GET');
  });

  it('forwards --project as the projectPath query', async () => {
    // Purpose: `--project` must narrow the server's view, not be dropped.
    serverAnswers([]);

    await runMarketplaceOutdated({ projectPath: '/work/my app', json: false });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/api\/marketplace\/updates\?projectPath=%2Fwork%2Fmy%20app$/);
  });

  it('prints only the stale installations, labelled by place, and exits 1', async () => {
    // Purpose: current packages are not listed, an agent's install names its
    // agent, and a script can gate on the stale exit code.
    serverAnswers([
      check(),
      CURRENT,
      check({
        installPath: '/work/alpha/.dork/plugins/flow',
        scope: 'agent-local',
        agentPath: '/work/alpha',
        agentName: 'Alpha',
      }),
    ]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(OUTDATED_EXIT.outdated);
    expect(code).toBe(1);
    const out = printed(logSpy);
    expect(out).toContain('flow  0.7.2 → 0.7.3  (dorkos-community)');
    expect(out).toContain('flow [Alpha]  0.7.2 → 0.7.3  (dorkos-community)');
    expect(out).not.toContain('review');
    expect(out).toContain('2 updates available.');
    expect(out).toContain('dorkos marketplace update --apply');
  });

  it('carries --project into the hint it prints', async () => {
    // Purpose: the suggested command must update the same view that was checked.
    serverAnswers([check()]);

    await runMarketplaceOutdated({ projectPath: '/work/alpha', json: false });

    expect(printed(logSpy)).toContain('dorkos marketplace update --apply --project /work/alpha');
  });

  it('exits 0 and says so when everything is current', async () => {
    serverAnswers([CURRENT]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(OUTDATED_EXIT.current);
    expect(code).toBe(0);
    expect(printed(logSpy)).toContain('Everything is up to date (1 package checked).');
  });

  it('exits 0 when nothing is installed', async () => {
    serverAnswers([]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(0);
    expect(printed(logSpy)).toContain('No installed packages to check.');
  });

  it('exits 2, not 0, when nothing is stale but a package could not be checked', async () => {
    // Purpose: "couldn't check" must never read as "up to date" — a script has
    // to be able to tell the two apart.
    serverAnswers([CURRENT, UNKNOWN]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(OUTDATED_EXIT.unknown);
    expect(code).toBe(2);
    const out = printed(logSpy);
    expect(out).toContain('Could not check:');
    expect(out).toContain('  offline-pkg: could not reach github.com');
    expect(out).not.toContain('up to date');
  });

  it('exits 1 when something is stale even if another package could not be checked', async () => {
    // Purpose: a known stale package is the fact a script acts on; the unknown
    // one is still printed so it is not lost.
    serverAnswers([check(), UNKNOWN]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(1);
    const out = printed(logSpy);
    expect(out).toContain('flow  0.7.2 → 0.7.3');
    expect(out).toContain('offline-pkg: could not reach github.com');
    expect(out).toContain('1 update available, 1 could not be checked.');
  });

  it('sets a linked install apart and leaves it out of the exit code', async () => {
    // Purpose: a linked working copy is never checked, by design. Counting it
    // as "could not check" would make `outdated` exit 2 forever on any machine
    // with a linked package, so a script could never read a clean 0.
    serverAnswers([CURRENT, LINKED]);

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(0);
    const out = printed(logSpy);
    expect(out).toContain('Linked, not checked:');
    expect(out).toContain('  dev: linked install — update its source instead');
    expect(out).not.toContain('Could not check:');
    expect(out).toContain('1 linked, not checked. Everything else is up to date (1 checked).');
  });

  it('still exits 1 for a stale package beside a linked one', async () => {
    serverAnswers([check(), LINKED]);

    expect(await runMarketplaceOutdated({ json: false })).toBe(1);
    expect(printed(logSpy)).toContain('1 update available, 1 linked, not checked.');
  });

  it('prints the caveat note under a stale row', async () => {
    // Purpose: a note on a known answer (a rollback, a default-branch check)
    // must reach the person, indented under its row.
    serverAnswers([check({ note: 'checked the default branch' })]);

    await runMarketplaceOutdated({ json: false });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const row = lines.indexOf('flow  0.7.2 → 0.7.3  (dorkos-community)');
    expect(row).toBeGreaterThanOrEqual(0);
    expect(lines[row + 1]).toBe('  checked the default branch');
  });

  it('quotes a project path in the hint so it pastes back into a shell', async () => {
    serverAnswers([check()]);

    await runMarketplaceOutdated({ projectPath: '/work/my app', json: false });

    expect(printed(logSpy)).toContain("dorkos marketplace update --apply --project '/work/my app'");
  });

  it('exits 2 with the reason on stderr when the server cannot be reached', async () => {
    // Purpose: a failed request is "couldn't check", never "stale" (1) or
    // "current" (0).
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(2);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Cannot reach DorkOS server/
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exits 2 on a server error answer', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(403, { error: 'Access denied: projectPath outside boundary' })
    );

    const code = await runMarketplaceOutdated({ projectPath: '/etc', json: false });

    expect(code).toBe(2);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'Access denied: projectPath outside boundary'
    );
  });

  it('says the server is older than the CLI when it has no updates door', async () => {
    // Purpose: a DorkOS started before this CLI was installed answers 404 for
    // the route; "Not found" alone tells a person nothing they can act on.
    fetchMock.mockResolvedValueOnce(
      mockResponse(404, { error: 'Not found', code: 'API_NOT_FOUND' })
    );

    const code = await runMarketplaceOutdated({ json: false });

    expect(code).toBe(2);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /older than this CLI.*Restart DorkOS/s
    );
  });

  describe('--json', () => {
    /** The single JSON document written to stdout. */
    function written(): unknown {
      expect(writeSpy).toHaveBeenCalledTimes(1);
      return JSON.parse(String(writeSpy.mock.calls[0]?.[0]));
    }

    it('writes the stale, unchecked and linked installations, as the server sent them', async () => {
      // Purpose: the JSON shape is a contract scripts read: three arrays of the
      // server's own check objects, current ones left out.
      const stale = check();
      serverAnswers([stale, CURRENT, UNKNOWN, LINKED]);

      const code = await runMarketplaceOutdated({ json: true });

      expect(code).toBe(1);
      expect(written()).toEqual({ outdated: [stale], unknown: [UNKNOWN], linked: [LINKED] });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('writes empty arrays and exits 0 when everything is current', async () => {
      serverAnswers([CURRENT]);

      const code = await runMarketplaceOutdated({ json: true });

      expect(code).toBe(0);
      expect(written()).toEqual({ outdated: [], unknown: [], linked: [] });
    });

    it('uses the same exit codes as the human output', async () => {
      serverAnswers([UNKNOWN]);

      expect(await runMarketplaceOutdated({ json: true })).toBe(2);
    });

    it('keeps stdout empty when the request fails', async () => {
      // Purpose: a failed run must not hand a pipe half a document.
      fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const code = await runMarketplaceOutdated({ json: true });

      expect(code).toBe(2);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    });
  });
});
