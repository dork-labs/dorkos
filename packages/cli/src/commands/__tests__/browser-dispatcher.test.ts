import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  legacyImports: 0,
  legacyDepsImports: 0,
  resolverImports: 0,
  resolve: vi.fn(),
  install: vi.fn(),
  inspect: vi.fn(),
  legacyDeps: vi.fn(),
  login: vi.fn(),
  status: vi.fn(),
  forget: vi.fn(),
}));

const readiness = { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' };
const missing = {
  schemaVersion: 1,
  pinnedPackageVersion: '1.63.0',
  chromiumRevision: '1243',
  platform: 'darwin',
  arch: 'arm64',
  observation: 'files-only',
  readiness,
  state: 'missing',
  cause: null,
};

describe('browser runtime dispatcher cold branch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture.legacyImports = fixture.legacyDepsImports = fixture.resolverImports = 0;
    // Register fresh manual mocks per case: resetModules alone retains mock exports.
    vi.doMock('../../lib/agent-browser/browser-runtime-deps.js', () => {
      fixture.resolverImports++;
      return { resolveBrowserRuntimeInstallation: fixture.resolve };
    });
    vi.doMock('../../lib/agent-browser/browser-deps.js', () => {
      fixture.legacyDepsImports++;
      return { defaultBrowserDeps: fixture.legacyDeps };
    });
    vi.doMock('../browser-commands.js', () => {
      fixture.legacyImports++;
      return {
        parseBrowserLoginArgs: (args: string[]) => ({ args }),
        parseBrowserStatusArgs: (args: string[]) => ({ args }),
        parseBrowserForgetArgs: (args: string[]) => ({ args }),
        runBrowserLogin: fixture.login,
        runBrowserStatus: fixture.status,
        runBrowserForget: fixture.forget,
      };
    });
    fixture.resolve.mockResolvedValue({
      install: fixture.install,
      inspectExisting: fixture.inspect,
    });
    fixture.inspect.mockResolvedValue(missing);
    fixture.install.mockResolvedValue({
      state: 'refused',
      cause: 'PLATFORM_UNSUPPORTED',
      publicationMayHaveChanged: false,
      readiness,
    });
    fixture.legacyDeps.mockReturnValue({ legacy: true });
    fixture.login.mockResolvedValue(7);
    fixture.status.mockResolvedValue(8);
    fixture.forget.mockResolvedValue(9);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('routes explicit repair to the real handler without loading legacy sign-in dependencies', async () => {
    const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
    expect(await runBrowserDispatcher('install', ['--repair', '--json'])).toBe(1);
    expect(fixture.install).toHaveBeenCalledExactlyOnceWith({ repair: true, signal: undefined });
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
    expect(fixture.resolverImports).toBe(1);
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        state: 'refused',
        cause: 'PLATFORM_UNSUPPORTED',
        publicationMayHaveChanged: false,
        readiness,
      })
    );
    expect(fixture.legacyImports).toBe(0);
    expect(fixture.legacyDepsImports).toBe(0);
    expect(fixture.legacyDeps).not.toHaveBeenCalled();
  });

  it('routes runtime status to inspection once without installing or importing legacy dependencies', async () => {
    const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
    expect(await runBrowserDispatcher('status', ['--json', '--runtime'])).toBe(1);
    expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith({ signal: undefined });
    expect(fixture.install).not.toHaveBeenCalled();
    expect(fixture.resolverImports).toBe(1);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(missing));
    expect(fixture.legacyImports + fixture.legacyDepsImports).toBe(0);
  });

  it.each([
    ['install', ['--repair', '--repair']],
    ['install', ['some-site']],
    ['status', ['--runtime', '--repair']],
  ])(
    'rejects invalid runtime grammar before loading the package resolver: %s %j',
    async (command, args) => {
      const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
      expect(await runBrowserDispatcher(command as string, args as string[])).toBe(1);
      expect(fixture.resolverImports).toBe(0);
      expect(fixture.resolve).not.toHaveBeenCalled();
      expect(fixture.legacyImports + fixture.legacyDepsImports).toBe(0);
    }
  );

  it.each([
    ['login', ['github.com'], 'login', 7],
    ['status', ['--json'], 'status', 8],
    ['forget', ['github.com'], 'forget', 9],
  ] as const)(
    'preserves the legacy %s branch and returned exit code',
    async (command, args, handler, code) => {
      const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
      expect(await runBrowserDispatcher(command, [...args])).toBe(code);
      expect(fixture[handler]).toHaveBeenCalledExactlyOnceWith(
        { args: [...args] },
        { legacy: true }
      );
      expect(fixture.legacyDeps).toHaveBeenCalledTimes(1);
      expect(fixture.legacyImports).toBe(1);
      expect(fixture.legacyDepsImports).toBe(1);
      expect(fixture.resolverImports).toBe(0);
      expect(fixture.resolve).not.toHaveBeenCalled();
    }
  );

  it('keeps a package-resolution exception out of runtime JSON and stderr', async () => {
    fixture.resolve.mockRejectedValue(new Error('secret-token=/private/account-value'));
    const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
    expect(await runBrowserDispatcher('install', ['--json'])).toBe(1);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        schemaVersion: 1,
        state: 'uncertain',
        cause: 'COMMAND_FAILED',
        publicationMayHaveChanged: true,
        readiness,
      })
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(fixture.legacyImports + fixture.legacyDepsImports).toBe(0);
  });

  it('prints help without resolving any browser dependencies', async () => {
    const { runBrowserDispatcher } = await import('../browser-dispatcher.js');
    expect(await runBrowserDispatcher('--help', [])).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('status --runtime'));
    expect(fixture.legacyImports + fixture.legacyDepsImports + fixture.resolverImports).toBe(0);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
});
