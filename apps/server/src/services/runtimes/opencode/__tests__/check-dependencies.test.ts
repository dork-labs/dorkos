import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { checkOpenCodeDependencies } from '../check-dependencies.js';
import { configManager } from '../../../core/config-manager.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

const INSTALL_HINT = 'npm i -g opencode-ai && opencode auth login';
const INFO_URL = 'https://opencode.ai/docs/server';

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

/** execFileSync mock that resolves the binary on PATH and answers probes. */
function mockProbes(overrides: Partial<Record<'which' | 'version' | 'auth', () => string>> = {}) {
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const argv = args as string[];
    if (argv[0] === 'opencode') return (overrides.which ?? (() => '/usr/local/bin/opencode\n'))();
    if (argv[0] === '--version') return (overrides.version ?? (() => '1.17.13\n'))();
    if (argv[0] === 'auth') return (overrides.auth ?? (() => '2 credentials\n'))();
    throw new Error(`unexpected args: ${argv.join(' ')}`);
  });
}

describe('checkOpenCodeDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns missing for both checks when no binary resolves from PATH', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const checks = checkOpenCodeDependencies();

    expect(checks).toHaveLength(2);
    const [cli, auth] = checks;
    expect(cli).toMatchObject({
      name: 'OpenCode CLI',
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
    expect(cli.description).toBeTruthy();
    expect(auth).toMatchObject({
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
  });

  it('returns satisfied for both checks when the binary is on PATH and credentials exist', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes();

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli).toMatchObject({
      name: 'OpenCode CLI',
      status: 'satisfied',
      version: '1.17.13',
    });
    expect(auth.status).toBe('satisfied');
  });

  it('uses the configured binaryPath and never consults PATH', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/opencode/bin/opencode', port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv[0] === '--version') return '1.17.13\n';
      if (argv[0] === 'auth') return '1 credential\n';
      throw new Error(`unexpected args: ${argv.join(' ')}`);
    });

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    // Every probe ran against the configured binary; no which/where lookup.
    for (const call of vi.mocked(execFileSync).mock.calls) {
      expect(call[0]).toBe('/opt/opencode/bin/opencode');
    }
  });

  it('reports missing when the configured binaryPath does not exist (no PATH fallback)', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/opencode/bin/opencode', port: 0 });
    vi.mocked(existsSync).mockReturnValue(false);

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toBe(INSTALL_HINT);
    expect(auth.status).toBe('missing');
    // An explicitly configured path is authoritative — PATH must not be probed.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reports the CLI satisfied but auth missing when no credentials are stored', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({
      auth: () => 'Credentials /home/u/.local/share/opencode/auth.json\n\n0 credentials\n',
    });

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth).toMatchObject({
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
  });

  it('treats env-var-only auth (0 credentials + active environment variables) as satisfied', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({
      // `opencode auth list` counts only auth.json entries; active provider
      // env vars print in a separate "Environment" section (NOTES.md §4).
      auth: () =>
        'Credentials /home/u/.local/share/opencode/auth.json\n\n0 credentials\n\n' +
        'Environment\n\nANTHROPIC_API_KEY\n\n1 environment variable\n',
    });

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
  });

  it('treats multiple environment variables as satisfied (plural outro)', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({
      auth: () =>
        '0 credentials\n\nEnvironment\n\nANTHROPIC_API_KEY\nOPENAI_API_KEY\n\n2 environment variables\n',
    });

    const [, auth] = checkOpenCodeDependencies();

    expect(auth.status).toBe('satisfied');
  });

  it('reports auth missing when both credentials and environment counts are zero', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({
      auth: () => '0 credentials\n\nEnvironment\n\n0 environment variables\n',
    });

    const [, auth] = checkOpenCodeDependencies();

    expect(auth).toMatchObject({
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
  });

  it('reports auth missing when the auth probe fails to run', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({
      auth: () => {
        throw Object.assign(new Error('unknown command'), { status: 1 });
      },
    });

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('missing');
  });

  it('treats an unparseable auth listing as satisfied (env keys and local models need no stored credentials)', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    mockProbes({ auth: () => 'some future output format\n' });

    const [, auth] = checkOpenCodeDependencies();

    expect(auth.status).toBe('satisfied');
  });

  it('reports missing when the resolved binary fails to launch', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null, port: 0 });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv[0] === 'opencode') return '/usr/local/bin/opencode\n';
      throw new Error('spawn failure');
    });

    const [cli, auth] = checkOpenCodeDependencies();

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });
});
