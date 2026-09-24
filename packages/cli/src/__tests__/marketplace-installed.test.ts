import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import {
  parseMarketplaceInstalledArgs,
  renderInstalledTable,
  runMarketplaceInstalled,
} from '../commands/marketplace-installed.js';

/** Build a fetch `Response`-like object that the api-client can consume. */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const GLOBAL_FLOW = {
  name: 'flow',
  version: '0.7.3',
  type: 'plugin' as const,
  installPath: '/home/u/.dork/plugins/flow',
  scope: 'global' as const,
};

const ALPHA_FLOW = {
  name: 'flow',
  version: '0.7.2',
  type: 'plugin' as const,
  installPath: '/work/alpha/.dork/plugins/flow',
  scope: 'agent-local' as const,
  agentPath: '/work/alpha',
  agentId: 'a1',
  agentName: 'Alpha',
};

/** Everything printed to stdout through console.log, one string. */
function printed(spy: MockInstance<typeof console.log>): string {
  return spy.mock.calls.map((c) => String(c[0])).join('\n');
}

describe('parseMarketplaceInstalledArgs', () => {
  it('defaults to every scope and human output', () => {
    expect(parseMarketplaceInstalledArgs([])).toEqual({ projectPath: undefined, json: false });
  });

  it('parses --project and --json', () => {
    expect(parseMarketplaceInstalledArgs(['--project', '/work/alpha', '--json'])).toEqual({
      projectPath: '/work/alpha',
      json: true,
    });
  });

  it('names the command on an unknown option', () => {
    expect(() => parseMarketplaceInstalledArgs(['--all'])).toThrow(
      /Unknown option for 'marketplace installed': --all/
    );
  });
});

describe('renderInstalledTable', () => {
  it('shows each installation on its own row, with where it lives', () => {
    // Purpose: the same package in two scopes is two rows, told apart by
    // place: `global`, or the agent's name.
    const lines = renderInstalledTable([GLOBAL_FLOW, ALPHA_FLOW]).split('\n');

    expect(lines[0]).toMatch(/^NAME\s+VERSION\s+TYPE\s+WHERE$/);
    expect(lines[2]).toMatch(/^flow\s+0\.7\.3\s+plugin\s+global$/);
    expect(lines[3]).toMatch(/^flow\s+0\.7\.2\s+plugin\s+Alpha$/);
  });

  it("falls back to the project path when an install's agent has no name", () => {
    const { agentName: _drop, ...unnamed } = ALPHA_FLOW;

    expect(renderInstalledTable([unnamed])).toMatch(/plugin\s+\/work\/alpha$/m);
  });

  it('flags linked, overriding and incomplete installs in a NOTES column', () => {
    // Purpose: a linked working copy is never updated in place, so the listing
    // must say which installs are linked (DOR-2193).
    const table = renderInstalledTable([
      { ...GLOBAL_FLOW, name: 'dev', linked: true },
      { ...ALPHA_FLOW, scope: 'override' },
      { ...GLOBAL_FLOW, name: 'mcp-thing', dependencyWarnings: ['npm install failed'] },
    ]);

    expect(table.split('\n')[0]).toMatch(/WHERE\s+NOTES$/);
    expect(table).toMatch(/^dev\s+.*global\s+linked$/m);
    expect(table).toMatch(/^flow\s+.*Alpha\s+overrides global$/m);
    expect(table).toMatch(/^mcp-thing\s+.*global\s+libraries incomplete$/m);
  });

  it('leaves the NOTES column out when no row has a note', () => {
    expect(renderInstalledTable([GLOBAL_FLOW])).not.toContain('NOTES');
  });
});

describe('runMarketplaceInstalled', () => {
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

  it('lists every scope from GET /installed and exits 0', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { packages: [GLOBAL_FLOW, ALPHA_FLOW] }));

    const code = await runMarketplaceInstalled({ json: false });

    expect(code).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/marketplace\/installed$/);
    expect(init.method).toBe('GET');
    expect(printed(logSpy)).toMatch(/flow\s+0\.7\.2\s+plugin\s+Alpha/);
  });

  it("forwards --project as the projectPath query, for that project's view", async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { packages: [] }));

    await runMarketplaceInstalled({ projectPath: '/work/my app', json: false });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/api\/marketplace\/installed\?projectPath=%2Fwork%2Fmy%20app$/);
  });

  it('explains a linked install beneath the table', async () => {
    fetchMock.mockResolvedValueOnce(
      mockResponse(200, { packages: [{ ...GLOBAL_FLOW, linked: true }] })
    );

    await runMarketplaceInstalled({ json: false });

    expect(printed(logSpy)).toMatch(/linked:.*update .*source/i);
  });

  it('says so when nothing is installed', async () => {
    fetchMock.mockResolvedValueOnce(mockResponse(200, { packages: [] }));

    const code = await runMarketplaceInstalled({ json: false });

    expect(code).toBe(0);
    expect(printed(logSpy)).toContain('No packages installed.');
  });

  it('--json writes the server rows untouched and nothing else', async () => {
    // Purpose: the JSON shape is the API's own installed list, for scripts.
    fetchMock.mockResolvedValueOnce(mockResponse(200, { packages: [GLOBAL_FLOW, ALPHA_FLOW] }));

    const code = await runMarketplaceInstalled({ json: true });

    expect(code).toBe(0);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(writeSpy.mock.calls[0]?.[0]))).toEqual([GLOBAL_FLOW, ALPHA_FLOW]);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('exits 1 with the reason on stderr when the server cannot be reached', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const code = await runMarketplaceInstalled({ json: true });

    expect(code).toBe(1);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
      /Cannot reach DorkOS server/
    );
  });
});
