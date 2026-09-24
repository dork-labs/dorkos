import { describe, expect, it } from 'vitest';
import {
  SESSION_GIT_CONFIG,
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
      { key: 'core.fsmonitor', value: 'false' },
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
      'core.fsmonitor=false',
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
      GIT_CONFIG_VALUE_2: 'false',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
  });
});
