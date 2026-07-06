import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { checkOpenCodeDependencies } from '../check-dependencies.js';
import { resolveProvisionedOpenCodePath } from '../provision.js';
import { configManager } from '../../../core/config-manager.js';

// execFile (callback form) is the async probe primitive after the T0 async
// conversion; existsSync (mocked) decides which resolver candidate wins.
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs', () => ({ existsSync: vi.fn() }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn() },
}));

const INSTALL_HINT = 'npm i -g opencode-ai && opencode auth login';
const INFO_URL = 'https://opencode.ai/docs/server';

/** A canonical PATH-resolved opencode, distinct from the provisioned path. */
const PATH_OPENCODE = '/usr/local/bin/opencode';
/** The on-demand provisioned binary location (dork-home scoped). */
const PROVISIONED = resolveProvisionedOpenCodePath();

function mockRuntimesConfig(opencode: {
  enabled: boolean;
  binaryPath: string | null;
  port: number;
}) {
  const runtimes: UserConfig['runtimes'] = {
    default: 'claude-code',
    opencode,
    codex: { enabled: true, binaryPath: null },
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
    if (outcome === 'hang') return {} as never;
    if ('error' in outcome) cb(outcome.error, '', '');
    else cb(null, outcome.stdout ?? '', '');
    return {} as never;
  }) as typeof execFile);
}

/**
 * Standard probe handler: resolve `opencode` on PATH and answer its probes.
 * `auth` defaults to a satisfied "2 credentials" listing.
 */
function pathProbes(overrides: { version?: string; auth?: () => ProbeOutcome } = {}) {
  onExecFile((file, args) => {
    if (file === 'which' || file === 'where') return { stdout: `${PATH_OPENCODE}\n` };
    if (args[0] === '--version') return { stdout: overrides.version ?? '1.17.13\n' };
    if (args[0] === 'auth') return (overrides.auth ?? (() => ({ stdout: '2 credentials\n' })))();
    return { error: new Error(`unexpected args: ${args.join(' ')}`) };
  });
}

describe('checkOpenCodeDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns missing for both checks when no binary resolves', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(false);
    onExecFile(() => ({ error: new Error('not found') }));

    const checks = await checkOpenCodeDependencies();

    expect(checks).toHaveLength(2);
    const [cli, auth] = checks;
    expect(cli).toMatchObject({
      name: 'OpenCode CLI',
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
    expect(cli.description).toBeTruthy();
    expect(auth).toMatchObject({ status: 'missing', installHint: INSTALL_HINT, infoUrl: INFO_URL });
  });

  it('returns satisfied for both checks when the binary is on PATH and credentials exist', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    // Only the PATH binary exists; the provisioned candidate does not.
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes();

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli).toMatchObject({ name: 'OpenCode CLI', status: 'satisfied', version: '1.17.13' });
    expect(auth.status).toBe('satisfied');
  });

  it('resolves the on-demand provisioned binary before consulting PATH', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    // The provisioned binary exists; PATH is never consulted.
    vi.mocked(existsSync).mockImplementation((p) => p === PROVISIONED);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { stdout: '1.17.13\n' };
      if (args[0] === 'auth') return { stdout: '1 credential\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    // Every probe ran against the provisioned binary; no which/where lookup.
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe(PROVISIONED);
    }
  });

  it('uses the configured binaryPath and never consults PATH', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/opencode/bin/opencode', port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    onExecFile((_file, args) => {
      if (args[0] === '--version') return { stdout: '1.17.13\n' };
      if (args[0] === 'auth') return { stdout: '1 credential\n' };
      return { error: new Error(`unexpected args: ${args.join(' ')}`) };
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe('/opt/opencode/bin/opencode');
    }
  });

  it('reports missing when the configured binaryPath does not exist (no fallback, no probe)', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/opencode/bin/opencode', port: 0 });
    vi.mocked(existsSync).mockReturnValue(false);
    onExecFile(() => ({ error: new Error('should not be probed') }));

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toBe(INSTALL_HINT);
    expect(auth.status).toBe('missing');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('reports the CLI satisfied but auth missing when no credentials are stored', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({
      auth: () => ({
        stdout: 'Credentials /home/u/.local/share/opencode/auth.json\n\n0 credentials\n',
      }),
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth).toMatchObject({ status: 'missing', installHint: INSTALL_HINT, infoUrl: INFO_URL });
  });

  it('treats env-var-only auth (0 credentials + active environment variables) as satisfied', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({
      auth: () => ({
        stdout:
          'Credentials /home/u/.local/share/opencode/auth.json\n\n0 credentials\n\n' +
          'Environment\n\nANTHROPIC_API_KEY\n\n1 environment variable\n',
      }),
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
  });

  it('treats multiple environment variables as satisfied (plural outro)', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({
      auth: () => ({
        stdout:
          '0 credentials\n\nEnvironment\n\nANTHROPIC_API_KEY\nOPENAI_API_KEY\n\n2 environment variables\n',
      }),
    });

    const [, auth] = await checkOpenCodeDependencies();

    expect(auth.status).toBe('satisfied');
  });

  it('reports auth missing when both credentials and environment counts are zero', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({
      auth: () => ({ stdout: '0 credentials\n\nEnvironment\n\n0 environment variables\n' }),
    });

    const [, auth] = await checkOpenCodeDependencies();

    expect(auth).toMatchObject({ status: 'missing', installHint: INSTALL_HINT, infoUrl: INFO_URL });
  });

  it('reports auth missing when the auth probe fails to run', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({
      auth: () => ({ error: Object.assign(new Error('unknown command'), { code: 1 }) }),
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('missing');
  });

  it('treats an unparseable auth listing as satisfied (env keys and local models need no stored credentials)', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    pathProbes({ auth: () => ({ stdout: 'some future output format\n' }) });

    const [, auth] = await checkOpenCodeDependencies();

    expect(auth.status).toBe('satisfied');
  });

  it('reports missing when the resolved binary fails to launch', async () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockImplementation((p) => p === PATH_OPENCODE);
    onExecFile((file) => {
      if (file === 'which' || file === 'where') return { stdout: `${PATH_OPENCODE}\n` };
      return { error: new Error('spawn failure') };
    });

    const [cli, auth] = await checkOpenCodeDependencies();

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });

  it('degrades to missing when a probe hangs, bounded by the probe timeout (never blocks)', async () => {
    vi.useFakeTimers();
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/opencode/bin/opencode', port: 0 });
    vi.mocked(existsSync).mockReturnValue(true); // configured binary resolves; probes then hang
    onExecFile(() => 'hang');

    const promise = checkOpenCodeDependencies();
    await vi.advanceTimersByTimeAsync(5_001);
    const [cli, auth] = await promise;

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });
});
