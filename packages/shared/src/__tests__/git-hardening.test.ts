import { describe, expect, it } from 'vitest';
import {
  SESSION_GIT_CONFIG,
  gitProtectionCheck,
  gitProtectionLevel,
  parseGitVersion,
  gitConfigArgs,
  internalGitConfig,
  withGitConfigEnv,
} from '../git-hardening.js';

describe('git hardening (DOR-2326)', () => {
  // Purpose: agent sessions refuse a found bare repository and any
  // file-system monitor, and keep a person's own hooks.
  it('gives sessions the two settings that stop a folder running a program', () => {
    expect(SESSION_GIT_CONFIG).toEqual([
      { key: 'safe.bareRepository', value: 'explicit' },
      { key: 'core.fsmonitor', value: '' },
    ]);
  });

  // Purpose: DorkOS's own git also runs no hooks, pointed at the platform's
  // empty device.
  it.each([
    ['linux', '/dev/null'],
    ['darwin', '/dev/null'],
    ['win32', 'NUL'],
  ] as const)('turns hooks off for DorkOS on %s', (platform, device) => {
    expect(internalGitConfig(platform)).toEqual([
      ...SESSION_GIT_CONFIG,
      { key: 'core.hooksPath', value: device },
    ]);
  });

  it('renders -c arguments', () => {
    expect(gitConfigArgs(SESSION_GIT_CONFIG)).toEqual([
      '-c',
      'safe.bareRepository=explicit',
      '-c',
      'core.fsmonitor=',
    ]);
  });

  // Purpose: settings are appended after any the environment carries, which
  // keep their places, and the input is not changed.
  it('appends to the environment settings already present', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' };
    expect(withGitConfigEnv(env, SESSION_GIT_CONFIG)).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'a.b',
      GIT_CONFIG_VALUE_0: 'c',
      GIT_CONFIG_KEY_1: 'safe.bareRepository',
      GIT_CONFIG_VALUE_1: 'explicit',
      GIT_CONFIG_KEY_2: 'core.fsmonitor',
      GIT_CONFIG_VALUE_2: '',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });
});

describe('the installed git (DOR-2326)', () => {
  it.each([
    ['git version 2.39.5 (Apple Git-154)', [2, 39]],
    ['git version 2.43.0.windows.1', [2, 43]],
    ['not git', undefined],
  ] as const)('parses %j', (out, expected) => {
    expect(parseGitVersion(out)).toEqual(expected);
  });

  // Purpose: sessions' settings travel in the environment (git 2.31+), and
  // safe.bareRepository needs 2.38; the boundaries are exact.
  it.each([
    [[2, 25], 'none'],
    [[2, 30], 'none'],
    [[2, 31], 'partial'],
    [[2, 37], 'partial'],
    [[2, 38], 'full'],
    [[3, 0], 'full'],
  ] as const)('rates git %j as %s', (version, level) => {
    expect(gitProtectionLevel(version)).toBe(level);
  });

  it.each([
    ['git version 2.30.0\n', 'warn'],
    ['git version 2.37.1\n', 'warn'],
    ['git version 2.38.0\n', 'pass'],
    ['garbled', 'info'],
    [undefined, 'info'],
  ] as const)('reports %j as %s', (out, status) => {
    const check = gitProtectionCheck(out);
    expect(check.status).toBe(status);
    if (status === 'warn') expect(check.fix).toContain('2.38');
  });
});
