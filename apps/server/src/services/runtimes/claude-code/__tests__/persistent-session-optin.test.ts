import { describe, it, expect } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { isPersistentSessionEnabled } from '../persistent-session-optin.js';

/**
 * A config reader over a whole `UserConfig`, as the real manager answers.
 *
 * @param config - The config to answer from.
 */
function readerFor(config: UserConfig) {
  return { get: <K extends keyof UserConfig>(key: K): UserConfig[K] => config[key] };
}

/**
 * A config reader whose `runtimes` section is missing the leaf entirely — the
 * shape on disk before the field existed, and before any migration ran.
 */
function readerMissingLeaf() {
  const runtimes = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode },
  };
  delete (runtimes.claudeCode as Partial<UserConfig['runtimes']['claudeCode']>).persistentSession;
  return readerFor({ ...USER_CONFIG_DEFAULTS, runtimes } as UserConfig);
}

describe('isPersistentSessionEnabled', () => {
  it('is on for a shipped config, so a claude-code chat keeps its agent warm', () => {
    // Flipped when the flag graduated out of Experiments (spec
    // `full-power-defaults`, D1). The three false cases below are unchanged and
    // are what this file is really for: the default moving does not make a
    // missing leaf, or an unreadable config, mean yes.
    expect(isPersistentSessionEnabled(readerFor(USER_CONFIG_DEFAULTS as UserConfig))).toBe(true);
  });

  it('is off once the operator turns it off', () => {
    const config = {
      ...USER_CONFIG_DEFAULTS,
      runtimes: {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, persistentSession: false },
      },
    } as UserConfig;

    expect(isPersistentSessionEnabled(readerFor(config))).toBe(false);
  });

  it('answers false — not undefined — when the leaf is not on disk yet', () => {
    // A launch decision has to be a boolean. `undefined` reaching a caller that
    // does `if (flag)` happens to work and then stops working the day somebody
    // writes `=== false`.
    expect(isPersistentSessionEnabled(readerMissingLeaf())).toBe(false);
  });

  it('stays on the resume path when the config cannot be read at all', () => {
    // The singleton is undefined before `initConfigManager()` runs. Reading a
    // launch decision must not be able to fail a launch, and an unreadable
    // config is not consent.
    const throwing = {
      get: () => {
        throw new Error('config manager not initialized');
      },
    } as unknown as Parameters<typeof isPersistentSessionEnabled>[0];

    expect(isPersistentSessionEnabled(throwing)).toBe(false);
  });
});
