/**
 * An explicit `default` launch (shared contract rev 6d; spec
 * `claude-account-fleet` §6 R "Launching `default`"): it runs in the
 * machine-wide default folder, from config and the OS home only, never in the
 * folder the server process inherited.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  claudeConfigDirEnv,
  claudeDefaultAccountFolder,
  machineDefaultClaudeRoot,
  resolveLaunchAccountRoot,
} from '../claude-config-dir.js';

const HOME_ROOT = path.join(os.homedir(), '.claude');
const SERVER_ENV_ROOT = '/staged/server-inherited';

function fakeConfig(claudeCode: Partial<UserConfig['runtimes']['claudeCode']> = {}): {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
} {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      defaultAccount: null,
      accounts: [],
      defaultAccountColor: null,
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: false,
      ...claudeCode,
    },
  };
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : USER_CONFIG_DEFAULTS[key]) as <K extends keyof UserConfig>(
      key: K
    ) => UserConfig[K],
  };
}

describe('launching `default` (contract rev 6d)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    // The server itself was started from a shell pointing somewhere else.
    process.env.CLAUDE_CONFIG_DIR = SERVER_ENV_ROOT;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  });

  it('runs a `default` launch in ~/.claude with CLAUDE_CONFIG_DIR unset, whatever the server inherited', () => {
    const config = fakeConfig({
      accounts: [{ id: 'claude3', path: '/staged/claude3', label: 'Claude3', color: null }],
    });
    const root = resolveLaunchAccountRoot({ hintId: 'default', config });
    expect(root).toBe(HOME_ROOT);
    expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
  });

  it('an agent manifest naming `default` resolves the same way', () => {
    expect(resolveLaunchAccountRoot({ agentAccountId: 'default', config: fakeConfig() })).toBe(
      HOME_ROOT
    );
  });

  it('an explicit defaultAccount is the default folder', () => {
    const config = fakeConfig({ defaultAccount: '/staged/chosen' });
    expect(resolveLaunchAccountRoot({ hintId: 'default', config })).toBe('/staged/chosen');
  });

  it('a registered row reaching ~/.claude through a symlink launches with CLAUDE_CONFIG_DIR unset', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'default-launch-')));
    try {
      const home = path.join(tmp, 'home');
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      const link = path.join(tmp, 'main-link');
      await fs.symlink(path.join(home, '.claude'), link);
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      const config = fakeConfig({
        accounts: [{ id: 'main', path: link, label: 'Main', color: null }],
      });

      const root = resolveLaunchAccountRoot({ hintId: 'default', config });
      expect(root).toBe(path.join(home, '.claude'));
      expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
      // The row's own spelling is the same account, so it unsets the variable too.
      expect(claudeConfigDirEnv(link)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps the operator's own spelling when the server's CLAUDE_CONFIG_DIR reaches ~/.claude through a symlink", async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'default-launch-')));
    try {
      const home = path.join(tmp, 'home');
      await fs.mkdir(path.join(home, '.claude'), { recursive: true });
      const link = path.join(tmp, 'claude-link');
      await fs.symlink(path.join(home, '.claude'), link);
      vi.spyOn(os, 'homedir').mockReturnValue(home);
      process.env.CLAUDE_CONFIG_DIR = link;

      const root = resolveLaunchAccountRoot({ hintId: 'default', config: fakeConfig() });
      expect(root).toBe(path.join(home, '.claude'));
      expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: link });
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it('a hand-edited row named `default` never takes the name', () => {
    const config = fakeConfig({
      accounts: [{ id: 'default', path: '/staged/imposter', label: null, color: null }],
    });
    expect(resolveLaunchAccountRoot({ hintId: 'default', config })).toBe(HOME_ROOT);
  });

  it('with no hint at all, the ladder still inherits the server environment (unchanged)', () => {
    expect(resolveLaunchAccountRoot({ config: fakeConfig() })).toBe(SERVER_ENV_ROOT);
  });
});

describe('the machine default folder never reads the environment', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  });

  it('a server started with CLAUDE_CONFIG_DIR=/x and defaultAccount null still names ~/.claude', () => {
    process.env.CLAUDE_CONFIG_DIR = '/x';
    expect(machineDefaultClaudeRoot(fakeConfig())).toBe(HOME_ROOT);
    expect(
      claudeDefaultAccountFolder({ runtimes: { claudeCode: { defaultAccount: null } } })
    ).toEqual({
      path: HOME_ROOT,
      warnings: [],
    });
  });

  it('reads the pre-0.65.0 activeAccount and ignores a defaultAccount that is not a path', () => {
    expect(
      claudeDefaultAccountFolder({ runtimes: { claudeCode: { activeAccount: '~/.claude2' } } }).path
    ).toBe(path.join(os.homedir(), '.claude2'));
    const invalid = claudeDefaultAccountFolder({
      runtimes: { claudeCode: { defaultAccount: 'claude2' } },
    });
    expect(invalid.path).toBe(HOME_ROOT);
    expect(invalid.warnings.map((w) => w.code)).toEqual(['default-account-invalid']);
  });
});
