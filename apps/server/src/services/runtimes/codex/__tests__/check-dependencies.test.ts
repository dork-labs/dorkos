import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { checkCodexDependencies } from '../check-dependencies.js';
import { configManager } from '../../../core/config-manager.js';

// execFile (callback form) is the async probe primitive after the T0 async
// conversion; node:module / node:path stay real so the SDK-vendored resolution
// runs for real and existsSync (mocked) decides which candidate wins.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn() },
}));

const INSTALL_HINT = 'npm i -g @openai/codex && codex login';
const INFO_URL = 'https://developers.openai.com/codex';

/** A canonical PATH-resolved codex, distinct from any vendored path. */
const PATH_CODEX = '/usr/local/bin/codex';

function mockRuntimesConfig(codex: { enabled: boolean; binaryPath: string | null }) {
  const runtimes: UserConfig['runtimes'] = {
    default: 'claude-code',
    opencode: { enabled: true, binaryPath: null, port: 0 },
    codex,
  };
  vi.mocked(configManager.get).mockReturnValue(runtimes as never);
}

type ProbeOutcome = { stdout?: string } | { error: Error } | 'hang';

/** Drive the execFile callback mock from a per-invocation handler. */
function onExecFile(handler: (file: string, args: string[]) => ProbeOutcome) {
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const outcome = handler(file, args);
    if (outcome === 'hang') return {} as never; // never invoke cb — simulates a stuck probe
    if ('error' in outcome) cb(outcome.error, '', '');
    else cb(null, outcome.stdout ?? '', '');
    return {} as never;
  }) as typeof execFile);
}

describe('checkCodexDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the SDK-vendored binary when nothing is on PATH — the false "needs setup" bug is gone', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    // The vendored path exists; PATH is never consulted because vendored wins.
    vi.mocked(existsSync).mockReturnValue(true);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { stdout: 'codex-cli 0.142.5\n' };
      if (args[0] === 'login') return { stdout: 'Logged in using ChatGPT\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkCodexDependencies();

    expect(cli).toMatchObject({
      name: 'Codex CLI',
      status: 'satisfied',
      version: 'codex-cli 0.142.5',
    });
    expect(auth.status).toBe('satisfied');
    // Vendored resolved first: no which/where lookup happened.
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).not.toBe('which');
      expect(call[0]).not.toBe('where');
    }
  });

  it('falls through to PATH when the vendored binary is absent', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    // Only the PATH-resolved binary exists; the vendored candidate does not.
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_CODEX);
    onExecFile((file, args) => {
      if (file === 'which' || file === 'where') return { stdout: `${PATH_CODEX}\n` };
      if (args[0] === '--version') return { stdout: 'codex-cli 0.142.5\n' };
      if (args[0] === 'login') return { stdout: 'ok\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkCodexDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    // A PATH lookup ran — the resolver fell through past the missing vendored binary.
    expect(vi.mocked(execFile).mock.calls.some((c) => c[0] === 'which' || c[0] === 'where')).toBe(
      true
    );
  });

  it('returns missing for both checks when every source is absent', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(false);
    onExecFile(() => ({ error: new Error('not found') }));

    const checks = await checkCodexDependencies();

    expect(checks).toHaveLength(2);
    const [cli, auth] = checks;
    expect(cli).toMatchObject({
      name: 'Codex CLI',
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
    expect(cli.description).toBeTruthy();
    expect(auth).toMatchObject({ status: 'missing', installHint: INSTALL_HINT, infoUrl: INFO_URL });
  });

  it('uses the configured binaryPath and never consults the vendored path or PATH', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/codex/bin/codex' });
    vi.mocked(existsSync).mockReturnValue(true);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { stdout: 'codex-cli 0.142.5\n' };
      if (args[0] === 'login') return { stdout: 'ok\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkCodexDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    // Every probe ran against the configured binary; no which/where lookup.
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe('/opt/codex/bin/codex');
    }
  });

  it('reports missing when the configured binaryPath does not exist (no vendored/PATH fallback)', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/codex/bin/codex' });
    vi.mocked(existsSync).mockReturnValue(false);
    onExecFile(() => ({ error: new Error('should not be probed') }));

    const [cli, auth] = await checkCodexDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toBe(INSTALL_HINT);
    expect(auth.status).toBe('missing');
    // An authoritative configured path short-circuits — nothing was probed.
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports the CLI satisfied but auth missing when login status fails', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { stdout: 'codex-cli 0.142.5\n' };
      if (args[0] === 'login')
        return { error: Object.assign(new Error('Not logged in'), { code: 1 }) };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkCodexDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth).toMatchObject({ status: 'missing', installHint: INSTALL_HINT, infoUrl: INFO_URL });
  });

  it('reports missing when the resolved binary fails to launch', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { error: new Error('spawn failure') };
      if (args[0] === 'login') return { error: new Error('spawn failure') };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkCodexDependencies();

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });

  it('degrades to missing when a probe hangs, bounded by the probe timeout (never blocks)', async () => {
    vi.useFakeTimers();
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true); // vendored resolves; the probe then hangs
    onExecFile(() => 'hang');

    const promise = checkCodexDependencies();
    // Advance past the 5s probe cap: the stuck probes reject and degrade, rather
    // than hanging the handler forever.
    await vi.advanceTimersByTimeAsync(5_001);
    const [cli, auth] = await promise;

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });
});
