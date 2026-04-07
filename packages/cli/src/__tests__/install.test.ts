import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { parseInstallArgs, runInstall } from '../commands/install.js';

/**
 * Build a fetch `Response`-like object that the api-client can consume.
 * Returns a tuple of (status, json) so each test can specify what the
 * mocked endpoint should yield.
 */
function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'mock',
    json: async () => body,
  } as unknown as Response;
}

const PREVIEW_BODY = {
  manifest: { name: 'demo-pkg', version: '1.2.3' },
  packagePath: '/tmp/demo-pkg',
  preview: {
    fileChanges: [{ path: 'foo.ts', action: 'create' as const }],
    extensions: [],
    tasks: [],
    secrets: [],
    externalHosts: [],
    requires: [],
    conflicts: [],
  },
};

const INSTALL_BODY = {
  ok: true,
  packageName: 'demo-pkg',
  version: '1.2.3',
  type: 'plugin',
  installPath: '/home/user/.dork/plugins/demo-pkg',
  warnings: [],
};

describe('parseInstallArgs', () => {
  it('parses a bare name with no options', () => {
    const args = parseInstallArgs(['demo-pkg']);
    expect(args.name).toBe('demo-pkg');
    expect(args.force).toBe(false);
    expect(args.yes).toBe(false);
  });

  it('parses --force, --yes, --project, --marketplace, --source', () => {
    const args = parseInstallArgs([
      'demo-pkg',
      '--force',
      '--yes',
      '--project',
      '/tmp/web',
      '--marketplace',
      'dorkos-community',
      '--source',
      'https://github.com/example/repo',
    ]);
    expect(args).toEqual({
      name: 'demo-pkg',
      force: true,
      yes: true,
      projectPath: '/tmp/web',
      marketplace: 'dorkos-community',
      source: 'https://github.com/example/repo',
    });
  });

  it('splits <name>@<marketplace> shorthand', () => {
    const args = parseInstallArgs(['demo-pkg@dorkos-community']);
    expect(args.name).toBe('demo-pkg');
    expect(args.marketplace).toBe('dorkos-community');
  });

  it('prefers explicit --marketplace over the @<marketplace> shorthand', () => {
    const args = parseInstallArgs(['demo-pkg@stale', '--marketplace', 'fresh']);
    // Explicit flag wins; the raw @stale segment is left in the name.
    expect(args.marketplace).toBe('fresh');
    expect(args.name).toBe('demo-pkg@stale');
  });

  it('throws on missing name', () => {
    expect(() => parseInstallArgs([])).toThrow(/Missing required <name>/);
  });

  it('throws on unknown option', () => {
    expect(() => parseInstallArgs(['demo-pkg', '--nope'])).toThrow(
      /Unknown option for 'install': --nope/
    );
  });
});

describe('runInstall', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.unstubAllGlobals();
  });

  it('happy path: previews, prompts via --yes, installs, prints summary', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, PREVIEW_BODY))
      .mockResolvedValueOnce(mockResponse(200, INSTALL_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runInstall({ name: 'demo-pkg', yes: true });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [previewUrl] = fetchMock.mock.calls[0];
    const [installUrl] = fetchMock.mock.calls[1];
    expect(previewUrl).toContain('/api/marketplace/packages/demo-pkg/preview');
    expect(installUrl).toContain('/api/marketplace/packages/demo-pkg/install');

    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('demo-pkg@1.2.3');
    expect(allLogs).toContain('Installed demo-pkg@1.2.3 to /home/user/.dork/plugins/demo-pkg');
  });

  it('non-TTY without --yes treats the prompt as a decline and cancels', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, PREVIEW_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runInstall({ name: 'demo-pkg' });

    expect(code).toBe(0);
    // Only the preview call — install was never made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allLogs).toContain('Install cancelled.');
  });

  it('blocks install on error-level conflicts unless --force', async () => {
    const previewWithConflict = {
      ...PREVIEW_BODY,
      preview: {
        ...PREVIEW_BODY.preview,
        conflicts: [
          {
            level: 'error' as const,
            type: 'package-name',
            description: 'Already installed',
            conflictingPackage: 'demo-pkg',
          },
        ],
      },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(mockResponse(200, previewWithConflict));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runInstall({ name: 'demo-pkg', yes: true });

    expect(code).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('blocked by error-level conflicts');
  });

  it('proceeds past error-level conflicts when --force is set', async () => {
    const previewWithConflict = {
      ...PREVIEW_BODY,
      preview: {
        ...PREVIEW_BODY.preview,
        conflicts: [
          {
            level: 'error' as const,
            type: 'package-name',
            description: 'Already installed',
          },
        ],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, previewWithConflict))
      .mockResolvedValueOnce(mockResponse(200, INSTALL_BODY));
    vi.stubGlobal('fetch', fetchMock);

    const code = await runInstall({ name: 'demo-pkg', yes: true, force: true });

    expect(code).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('renders structured conflicts on HTTP 409 from install endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, PREVIEW_BODY))
      .mockResolvedValueOnce(
        mockResponse(409, {
          error: 'Conflict detected',
          conflicts: [{ description: 'slot already bound to other-pkg' }],
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const code = await runInstall({ name: 'demo-pkg', yes: true });

    expect(code).toBe(1);
    const allErr = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(allErr).toContain('Conflict detected');
    expect(allErr).toContain('slot already bound to other-pkg');
  });

  it('forwards --project, --marketplace, --force in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(200, PREVIEW_BODY))
      .mockResolvedValueOnce(mockResponse(200, INSTALL_BODY));
    vi.stubGlobal('fetch', fetchMock);

    await runInstall({
      name: 'demo-pkg',
      yes: true,
      force: true,
      marketplace: 'dorkos-community',
      projectPath: '/tmp/web',
    });

    const [, previewInit] = fetchMock.mock.calls[0];
    const body = JSON.parse(previewInit.body);
    expect(body).toEqual({
      marketplace: 'dorkos-community',
      force: true,
      yes: true,
      projectPath: '/tmp/web',
    });
  });
});
