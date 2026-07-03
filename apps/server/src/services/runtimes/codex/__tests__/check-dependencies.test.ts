import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { checkCodexDependencies } from '../check-dependencies.js';
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

const INSTALL_HINT = 'npm i -g @openai/codex && codex login';
const INFO_URL = 'https://developers.openai.com/codex';

function mockRuntimesConfig(codex: { enabled: boolean; binaryPath: string | null }) {
  const runtimes: UserConfig['runtimes'] = {
    default: 'claude-code',
    opencode: { enabled: true, binaryPath: null, port: 0 },
    codex,
  };
  vi.mocked(configManager.get).mockReturnValue(runtimes as never);
}

describe('checkCodexDependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns missing for both checks when no binary resolves from PATH', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const checks = checkCodexDependencies();

    expect(checks).toHaveLength(2);
    const [cli, auth] = checks;
    expect(cli).toMatchObject({
      name: 'Codex CLI',
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

  it('returns satisfied for both checks when the binary is on PATH and login succeeds', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv[0] === 'codex') return '/usr/local/bin/codex\n';
      if (argv[0] === '--version') return 'codex-cli 0.142.5\n';
      if (argv[0] === 'login') return 'Logged in using ChatGPT\n';
      throw new Error(`unexpected args: ${argv.join(' ')}`);
    });

    const [cli, auth] = checkCodexDependencies();

    expect(cli).toMatchObject({
      name: 'Codex CLI',
      status: 'satisfied',
      version: 'codex-cli 0.142.5',
    });
    expect(auth.status).toBe('satisfied');
  });

  it('uses the configured binaryPath and never consults PATH', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/codex/bin/codex' });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockReturnValue('codex-cli 0.142.5\n');

    const [cli, auth] = checkCodexDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth.status).toBe('satisfied');
    // Every probe ran against the configured binary; no which/where lookup.
    for (const call of vi.mocked(execFileSync).mock.calls) {
      expect(call[0]).toBe('/opt/codex/bin/codex');
    }
  });

  it('reports missing when the configured binaryPath does not exist (no PATH fallback)', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: '/opt/codex/bin/codex' });
    vi.mocked(existsSync).mockReturnValue(false);

    const [cli, auth] = checkCodexDependencies();

    expect(cli.status).toBe('missing');
    expect(cli.installHint).toBe(INSTALL_HINT);
    expect(auth.status).toBe('missing');
    // An explicitly configured path is authoritative — PATH must not be probed.
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reports the CLI satisfied but auth missing when login status fails', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv[0] === 'codex') return '/usr/local/bin/codex\n';
      if (argv[0] === '--version') return 'codex-cli 0.142.5\n';
      throw Object.assign(new Error('Not logged in'), { status: 1 });
    });

    const [cli, auth] = checkCodexDependencies();

    expect(cli.status).toBe('satisfied');
    expect(auth).toMatchObject({
      status: 'missing',
      installHint: INSTALL_HINT,
      infoUrl: INFO_URL,
    });
  });

  it('reports missing when the resolved binary fails to launch', () => {
    mockRuntimesConfig({ enabled: true, binaryPath: null });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(execFileSync).mockImplementation((_file, args) => {
      const argv = args as string[];
      if (argv[0] === 'codex') return '/usr/local/bin/codex\n';
      throw new Error('spawn failure');
    });

    const [cli, auth] = checkCodexDependencies();

    expect(cli.status).toBe('missing');
    expect(auth.status).toBe('missing');
  });
});
