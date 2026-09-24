import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { parseUninstallArgs, runUninstall } from '../commands/uninstall.js';

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

describe('parseUninstallArgs', () => {
  it('parses a bare name', () => {
    const args = parseUninstallArgs(['demo-pkg']);
    expect(args).toEqual({ name: 'demo-pkg', purge: false, projectPath: undefined });
  });

  it('parses --purge', () => {
    const args = parseUninstallArgs(['demo-pkg', '--purge']);
    expect(args.purge).toBe(true);
  });

  it('parses --project', () => {
    const args = parseUninstallArgs(['demo-pkg', '--project', '/tmp/web']);
    expect(args.projectPath).toBe('/tmp/web');
  });

  it('throws on missing name', () => {
    expect(() => parseUninstallArgs([])).toThrow(/Missing required <name>/);
  });

  it('throws on unknown option', () => {
    expect(() => parseUninstallArgs(['demo-pkg', '--nope'])).toThrow(
      /Unknown option for 'marketplace uninstall': --nope/
    );
  });
});

describe('runUninstall', () => {
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

  it('happy path: calls uninstall, prints summary', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        ok: true,
        packageName: 'demo-pkg',
        removedFiles: 12,
        preservedData: ['/home/user/.dork/plugins/demo-pkg/.dork/data'],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUninstall({ name: 'demo-pkg' });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/marketplace/packages/demo-pkg/uninstall');
    // No purge flag was set so the body should be empty.
    expect(JSON.parse(init.body)).toEqual({});

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Uninstalled demo-pkg (12 entries removed)');
    expect(allLogs).toContain('Kept the files you and your agents added or changed:');
    expect(allLogs).toContain('/home/user/.dork/plugins/demo-pkg/.dork/data');
  });

  it('--purge sends `purge: true` and skips the preserved-data block', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        ok: true,
        packageName: 'demo-pkg',
        removedFiles: 15,
        preservedData: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUninstall({ name: 'demo-pkg', purge: true });

    expect(code).toBe(0);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ purge: true });

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).not.toContain('Kept the files');
  });

  // Purpose (DOR-2245): uninstalling an agent package says it left the team,
  // what that took away, and that a reinstall does not restore it.
  it('says what removing an agent took away', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(
        mockResponse(200, {
          ok: true,
          packageName: 'bot',
          removedFiles: 3,
          preservedData: [],
          agentRemoved: { id: '01A', directoryDenied: true, removed: ['rooms', 'mcp-sign-ins'] },
        })
      )
    );
    await runUninstall({ name: 'bot' });
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain(
      'Removed the agent from your team. That also took away its rooms, its sign-ins; reinstalling does not bring them back.'
    );
    expect(allLogs).toContain('git tracks its settings file');
  });

  it('--project forwards projectPath in the body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        ok: true,
        packageName: 'demo-pkg',
        removedFiles: 1,
        preservedData: [],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await runUninstall({ name: 'demo-pkg', projectPath: '/tmp/web' });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ projectPath: '/tmp/web' });
  });

  it('returns 1 and prints an error on HTTP 404', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(404, { error: 'Package not installed: demo-pkg' }));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUninstall({ name: 'demo-pkg' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Package not installed: demo-pkg');
  });

  it('prints the canonical retry command and exits 1 when a person must approve', async () => {
    // Purpose: nothing was removed, so a script must not read success, and the
    // retry line must name the canonical `dorkos marketplace uninstall`.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      mockResponse(200, {
        status: 'approval_required',
        approvalId: 'appr_1',
        approvalToken: 'appr_tok_1',
        message: 'Removing demo-pkg needs your approval.',
        retry: { instructions: 'Approve it in DorkOS, then retry.' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runUninstall({ name: 'demo-pkg' });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain(
      'Retry with: dorkos marketplace uninstall demo-pkg --approval appr_tok_1'
    );
    expect(logSpy).not.toHaveBeenCalled();
  });
});
