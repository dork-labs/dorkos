/**
 * The launch ladder and Claude sign-ins (DOR-3245): an automatic rung never
 * picks a folder whose sign-in is new or changed, a named account still runs
 * there, and when nothing else is left the folder's own default runs rather
 * than the turn being refused.
 */
import { describe, it, expect, vi } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';

/** Folders whose sign-in DorkOS may not pick on its own, set per test. */
const unconfirmed = new Set<string>();
vi.mock('../accounts/account-login-metadata.js', async (original) => ({
  ...(await original<typeof import('../accounts/account-login-metadata.js')>()),
  mayAutoPickClaudeRoot: (root: string) => !unconfirmed.has(root),
}));

import { resolveLaunchAccountRoot } from '../claude-config-dir.js';

const NEW = '/staged/claude-new';
const OLD = '/staged/claude-old';

function fakeConfig(): { get<K extends keyof UserConfig>(key: K): UserConfig[K] } {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
      defaultAccount: NEW,
      accounts: [
        { id: 'new', path: NEW, label: 'New', color: null },
        { id: 'old', path: OLD, label: 'Old', color: null },
      ],
    },
  };
  return {
    get: (<K extends keyof UserConfig>(key: K) =>
      key === 'runtimes' ? runtimes : USER_CONFIG_DEFAULTS[key]) as <K extends keyof UserConfig>(
      key: K
    ) => UserConfig[K],
  };
}

function launch(opts: { hintId?: string } = {}) {
  const result = resolveLaunchAccountRoot({ project: null, config: fakeConfig(), ...opts });
  if (!result.ok) throw result.error;
  return result;
}

describe('the launch ladder and sign-ins DorkOS may not pick on its own', () => {
  it('control: a confirmed default runs where it is', () => {
    unconfirmed.clear();
    expect(launch().root).toBe(NEW);
  });

  it('skips a default whose sign-in is new or changed, for the next one it may pick', () => {
    unconfirmed.clear();
    unconfirmed.add(NEW);
    expect(launch()).toMatchObject({ root: OLD, accountId: 'old' });
  });

  it('a person or agent naming that account still runs on it', () => {
    unconfirmed.clear();
    unconfirmed.add(NEW);
    expect(launch({ hintId: 'new' }).root).toBe(NEW);
  });

  it('with nothing it may pick, the default runs anyway: never "no account, refused"', () => {
    unconfirmed.clear();
    unconfirmed.add(NEW);
    unconfirmed.add(OLD);
    // `default` (the machine root) is the last candidate; leave none pickable.
    unconfirmed.add(launchOnlyMachineRoot());
    expect(launch()).toMatchObject({ ok: true, root: NEW });
  });
});

/** The machine root the ladder falls back to last, so a test can rule it out too. */
function launchOnlyMachineRoot(): string {
  const before = new Set(unconfirmed);
  unconfirmed.clear();
  const root = resolveLaunchAccountRoot({ project: null, config: fakeConfig(), hintId: 'default' });
  for (const item of before) unconfirmed.add(item);
  return root.ok ? root.root : '';
}
