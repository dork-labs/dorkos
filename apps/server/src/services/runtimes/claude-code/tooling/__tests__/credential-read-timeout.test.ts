import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { checkClaudeDependencies } from '../check-dependency.js';
import { readClaudeSignInDeadlines } from '../claude-sign-in-expiry.js';
import { credentialReadHealth, resetCredentialReadHealth } from '../credential-read-health.js';

// No executable is launched: in particular, the security command below is only
// an argument observed by this stub. Never run the real command on a developer Mac.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('../../../shared/runtime-environment-config.js', () => ({
  runtimeEnvironment: () => ({}),
}));
vi.mock('../../sdk/sdk-utils.js', () => ({ resolveClaudeBinaryBeforePath: () => '/fake/claude' }));
vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => '/fake/account',
  claudeConfigDirEnv: () => ({ CLAUDE_CONFIG_DIR: '/fake/account' }),
}));
vi.mock('../../../../core/config-manager.js', () => ({ configManager: { get: () => ({}) } }));
vi.mock('../../../../core/credential-provider.js', () => ({
  credentialProvider: { resolve: vi.fn() },
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
const platform = process.platform;
let hangAuth = false;
beforeEach(() => {
  hangAuth = false;
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetCredentialReadHealth();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.mocked(execFile).mockImplementation(((
    _file: string,
    args: string[],
    _options: unknown,
    callback: (err: null, out: string) => void
  ) => {
    if (args[0] === '--version') callback(null, '1.0');
    else if (args[0] === 'auth' && !hangAuth)
      callback(null, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
    // Fake security hangs forever, including after the timeout would reap it.
    return {};
  }) as typeof execFile);
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  resetCredentialReadHealth();
  vi.useRealTimers();
});

describe('a hung credential-store read', () => {
  it('keeps a hung CLI auth-status read unknown instead of reporting signed out', async () => {
    hangAuth = true;
    const checking = checkClaudeDependencies();
    await vi.advanceTimersByTimeAsync(5_000);
    const [, auth] = await checking;
    expect(auth).toMatchObject({ status: 'unknown', reason: 'credentials_unreadable' });
    expect(auth.installHint).toBeUndefined();
    expect(
      vi.mocked(execFile).mock.calls.filter((call) => call[0] === '/usr/bin/security')
    ).toHaveLength(0);
  });

  it('has a hard 5s bound, keeps deadlines unknown, names the prompt, and throttles retries', async () => {
    const checks = Promise.all(Array.from({ length: 10 }, () => checkClaudeDependencies()));
    await vi.advanceTimersByTimeAsync(5_000);
    const [[, auth]] = await checks;
    expect(auth).toMatchObject({
      status: 'unknown',
      reason: 'credentials_unreadable',
      description: "Agents can't read their sign-in. Check this Mac for a password prompt.",
    });
    expect(auth.installHint).toBeUndefined();
    expect(credentialReadHealth('/fake/account').state).toBe('credentials_unreadable');
    await expect(readClaudeSignInDeadlines('/fake/account')).resolves.toBeNull();
    for (let i = 0; i < 10; i++) await checkClaudeDependencies();
    const reads = () =>
      vi.mocked(execFile).mock.calls.filter((call) => call[0] === '/usr/bin/security');
    expect(reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    const retry = checkClaudeDependencies();
    await vi.advanceTimersByTimeAsync(5_000);
    await retry;
    expect(reads()).toHaveLength(2);
  });
});
