import { describe, expect, it, vi } from 'vitest';
import type {
  InstallResult,
  RuntimeInstallation,
  RuntimeInstallationStatus,
} from '@dorkos/browser/runtime-installation';
import {
  isBrowserRuntimeInvocation,
  parseBrowserRuntimeArgs,
  runBrowserRuntimeCommand,
  type BrowserRuntimeDeps,
} from '../browser-runtime-commands.js';

const readiness = { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' } as const;
const successful: InstallResult = {
  state: 'verified-installed',
  cause: null,
  installationId: 'installation',
  attemptId: 'attempt',
  generation: 1,
  observedVersion: '153.0.8010.12',
  executableSHA256: 'a'.repeat(64),
  platform: 'darwin',
  arch: 'arm64',
  currentManifestDigest: 'b'.repeat(64),
  journalDigest: 'c'.repeat(64),
  readiness,
};
const installed: RuntimeInstallationStatus = {
  schemaVersion: 1,
  pinnedPackageVersion: '1.63.0',
  chromiumRevision: '1243',
  platform: 'darwin',
  arch: 'arm64',
  observation: 'files-only',
  readiness,
  state: 'installed-files',
  cause: null,
  installationId: 'historical',
  executableSHA256: 'a'.repeat(64),
  currentManifestDigest: 'b'.repeat(64),
  lastFreshVerifiedVersion: '153.0.8010.12',
  historicalAttemptId: 'old-attempt',
  historicalGeneration: 3,
  verificationDigest: 'c'.repeat(64),
};
function fixture() {
  const runtime: RuntimeInstallation = {
    install: vi.fn<RuntimeInstallation['install']>().mockResolvedValue(successful),
    inspectExisting: vi.fn<RuntimeInstallation['inspectExisting']>().mockResolvedValue(installed),
  };
  const deps: BrowserRuntimeDeps = {
    getRuntimeInstallation: vi.fn().mockReturnValue(runtime),
    log: vi.fn(),
    error: vi.fn(),
  };
  return { runtime, deps };
}

describe('explicit runtime command grammar', () => {
  it('keeps bare status and legacy login/forget outside the new dispatcher branch', () => {
    expect(isBrowserRuntimeInvocation('status', ['--json'])).toBe(false);
    expect(isBrowserRuntimeInvocation('login', ['--runtime'])).toBe(false);
    expect(isBrowserRuntimeInvocation('forget', ['--all'])).toBe(false);
    expect(isBrowserRuntimeInvocation('status', ['--runtime', '--json'])).toBe(true);
    expect(isBrowserRuntimeInvocation('install', ['--unknown'])).toBe(true);
  });
  it('parses repair and explicit status without positionals or value coercion', () => {
    expect(parseBrowserRuntimeArgs('install', ['--json', '--repair'])).toEqual({
      command: 'install',
      repair: true,
      json: true,
    });
    expect(parseBrowserRuntimeArgs('status', ['--runtime'])).toEqual({
      command: 'status',
      json: false,
    });
  });
  it.each([
    ['install', ['--repair', '--repair']],
    ['install', ['--runtime']],
    ['install', ['--json=true']],
    ['install', ['site.example']],
    ['install', ['--', '--repair']],
    ['status', ['--json']],
    ['status', ['--runtime', '--repair']],
    ['status', ['--runtime', '--json', '--json']],
    ['unknown', []],
  ])('refuses malformed %s arguments before creating any runtime', async (command, args) => {
    const { deps } = fixture();
    expect(await runBrowserRuntimeCommand(command, args, deps)).toBe(1);
    expect(deps.getRuntimeInstallation).not.toHaveBeenCalled();
  });
});

describe('runtime handlers', () => {
  it('passes explicit repair and cancellation to install once, without status or process exit', async () => {
    const { runtime, deps } = fixture();
    const controller = new AbortController();
    expect(
      await runBrowserRuntimeCommand('install', ['--repair'], {
        ...deps,
        signal: controller.signal,
      })
    ).toBe(0);
    expect(runtime.install).toHaveBeenCalledExactlyOnceWith({
      repair: true,
      signal: controller.signal,
    });
    expect(runtime.inspectExisting).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith('Browser readiness has not been verified.');
  });
  it('emits one complete installation JSON record, including unavailable readiness', async () => {
    const { deps } = fixture();
    expect(await runBrowserRuntimeCommand('install', ['--json'], deps)).toBe(0);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(successful));
    expect(deps.error).not.toHaveBeenCalled();
  });
  it('reports fresh reuse without describing another download or a ready browser', async () => {
    const { runtime, deps } = fixture();
    vi.mocked(runtime.install).mockResolvedValue({ ...successful, state: 'verified-reused' });
    expect(await runBrowserRuntimeCommand('install', [], deps)).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('Existing managed browser files passed a fresh check.');
    expect(deps.log).toHaveBeenCalledWith('Browser readiness has not been verified.');
  });
  it('preserves complete uncertain publication facts and returns failure in JSON mode', async () => {
    const { runtime, deps } = fixture();
    const uncertain: InstallResult = {
      state: 'uncertain',
      cause: 'PUBLICATION_UNCERTAIN',
      publicationMayHaveChanged: true,
      readiness,
    };
    vi.mocked(runtime.install).mockResolvedValue(uncertain);
    expect(await runBrowserRuntimeCommand('install', ['--json'], deps)).toBe(1);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(uncertain));
    expect(deps.error).not.toHaveBeenCalled();
  });
  it('does not suggest automatic repair after uncertain publication', async () => {
    const { runtime, deps } = fixture();
    vi.mocked(runtime.install).mockResolvedValue({
      state: 'uncertain',
      cause: 'CUSTODY_UNCERTAIN',
      publicationMayHaveChanged: false,
      readiness,
    });
    expect(await runBrowserRuntimeCommand('install', [], deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledExactlyOnceWith(
      'Installation could not be confirmed. DorkOS kept the files for inspection.'
    );
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });
  it('keeps a busy installation refusal visible without retrying', async () => {
    const { runtime, deps } = fixture();
    vi.mocked(runtime.install).mockResolvedValue({
      state: 'refused',
      cause: 'PUBLICATION_BUSY',
      publicationMayHaveChanged: false,
      readiness,
    });
    expect(await runBrowserRuntimeCommand('install', [], deps)).toBe(1);
    expect(deps.error).toHaveBeenCalledWith(
      'Another browser installation is in progress. Wait for it to finish.'
    );
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });
  it('status reads historical installation only and never installs or repairs', async () => {
    const { runtime, deps } = fixture();
    expect(await runBrowserRuntimeCommand('status', ['--runtime', '--json'], deps)).toBe(0);
    expect(runtime.inspectExisting).toHaveBeenCalledExactlyOnceWith({ signal: undefined });
    expect(runtime.install).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(installed));
  });
  it('describes the historical version and file-only status in human output', async () => {
    const { deps } = fixture();
    expect(await runBrowserRuntimeCommand('status', ['--runtime'], deps)).toBe(0);
    expect(deps.log).toHaveBeenCalledWith('Last verified browser version: 153.0.8010.12');
    expect(deps.log).toHaveBeenCalledWith(
      'This checks the files only. Browser readiness has not been verified.'
    );
  });
  it.each(['missing', 'invalid', 'unverified', 'unsupported'] as const)(
    'returns failure for %s files without installation',
    async (state) => {
      const { runtime, deps } = fixture();
      const common = {
        schemaVersion: 1,
        pinnedPackageVersion: '1.63.0',
        chromiumRevision: '1243',
        platform: 'darwin',
        arch: 'arm64',
        observation: 'files-only',
        readiness,
      } as const;
      const status: RuntimeInstallationStatus =
        state === 'missing'
          ? { ...common, state, cause: null }
          : state === 'invalid'
            ? { ...common, state, cause: 'INSTALLATION_INVALID' }
            : state === 'unsupported'
              ? { ...common, state, cause: 'PLATFORM_UNSUPPORTED' }
              : { ...common, state, cause: 'VERIFICATION_UNAVAILABLE' };
      vi.mocked(runtime.inspectExisting).mockResolvedValue(status);
      expect(await runBrowserRuntimeCommand('status', ['--runtime', '--json'], deps)).toBe(1);
      expect(deps.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(status));
      expect(runtime.install).not.toHaveBeenCalled();
    }
  );
  it('forwards the original status signal once and preserves the complete historical DTO', async () => {
    const { runtime, deps } = fixture();
    const controller = new AbortController();
    expect(
      await runBrowserRuntimeCommand('status', ['--runtime', '--json'], {
        ...deps,
        signal: controller.signal,
      })
    ).toBe(0);
    expect(runtime.inspectExisting).toHaveBeenCalledExactlyOnceWith({ signal: controller.signal });
    expect(runtime.install).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(installed));
  });
  it('keeps an inspection rejection unverified and secret-free in human and JSON output', async () => {
    for (const json of [false, true]) {
      const { runtime, deps } = fixture();
      vi.mocked(runtime.inspectExisting).mockRejectedValue(new Error('TOKEN=secret /private/key'));
      expect(
        await runBrowserRuntimeCommand(
          'status',
          json ? ['--runtime', '--json'] : ['--runtime'],
          deps
        )
      ).toBe(1);
      expect(runtime.inspectExisting).toHaveBeenCalledTimes(1);
      expect(runtime.install).not.toHaveBeenCalled();
      if (json) {
        expect(deps.log).toHaveBeenCalledExactlyOnceWith(
          JSON.stringify({
            schemaVersion: 1,
            state: 'unverified',
            cause: 'COMMAND_FAILED',
            publicationMayHaveChanged: false,
            readiness,
          })
        );
        expect(deps.error).not.toHaveBeenCalled();
      } else {
        expect(deps.error).toHaveBeenCalledExactlyOnceWith(
          'DorkOS could not check the browser files.'
        );
        expect(deps.log).not.toHaveBeenCalled();
      }
      const output = JSON.stringify([
        vi.mocked(deps.log).mock.calls,
        vi.mocked(deps.error).mock.calls,
      ]);
      expect(output).not.toContain('TOKEN');
      expect(output).not.toContain('/private/key');
    }
  });
  it('keeps an unexpected install rejection uncertain, rather than promising no publication', async () => {
    const { runtime, deps } = fixture();
    vi.mocked(runtime.install).mockRejectedValue(new Error('failure after publication'));
    expect(await runBrowserRuntimeCommand('install', ['--json'], deps)).toBe(1);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({
        schemaVersion: 1,
        state: 'uncertain',
        cause: 'COMMAND_FAILED',
        publicationMayHaveChanged: true,
        readiness,
      })
    );
    expect(runtime.install).toHaveBeenCalledTimes(1);
  });
  it('keeps unknown exceptions and secrets out of both output formats', async () => {
    for (const args of [[], ['--json']]) {
      const { deps } = fixture();
      vi.mocked(deps.getRuntimeInstallation).mockRejectedValue(
        new Error('secret=/private/key TOKEN=abc')
      );
      expect(await runBrowserRuntimeCommand('install', args, deps)).toBe(1);
      const output = JSON.stringify([
        vi.mocked(deps.log).mock.calls,
        vi.mocked(deps.error).mock.calls,
      ]);
      expect(output).not.toContain('TOKEN');
      expect(output).not.toContain('/private/key');
    }
  });
});
