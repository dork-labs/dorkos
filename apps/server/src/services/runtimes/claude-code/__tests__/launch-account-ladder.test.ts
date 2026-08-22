/**
 * The launch-account ladder (spec `billing-account-ladder`, ADR 260821-205323):
 * session hint → agent manifest → server default → environment.
 *
 * Kept beside `claude-config-dir.test.ts` rather than inside it because the two
 * ask different questions: that file pins the READ-side resolution every
 * transcript scan depends on, this one pins where ONE launch is sent. The
 * resolver is a pure function of a config reader, so nothing here needs a
 * runtime, a session, or the filesystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { claudeConfigDirEnv, resolveLaunchAccountRoot } from '../claude-config-dir.js';
import { logger } from '../../../../lib/logger.js';

/** The account roots the ladder chooses between, one per rung. */
const HINT_ROOT = '/staged/claude-hint';
const AGENT_ROOT = '/staged/claude-agent';
const DEFAULT_ROOT = '/staged/claude-default';
const ENV_ROOT = '/staged/claude-env';
/** The SDK's own default — the root the named-by-absence rule is about. */
const HOME_ROOT = path.join(os.homedir(), '.claude');

/**
 * A config reader over one `runtimes.claudeCode` section — the same injection
 * seam `claude-config-dir.test.ts` uses, so both files describe the resolvers
 * through the door production code goes through.
 *
 * @param claudeCode - The fields this case cares about; the rest take defaults.
 * @returns A reader shaped like the `configManager` singleton.
 */
function fakeConfig(claudeCode: Partial<UserConfig['runtimes']['claudeCode']> = {}): {
  get<K extends keyof UserConfig>(key: K): UserConfig[K];
} {
  const runtimes: UserConfig['runtimes'] = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: {
      defaultAccount: null,
      accounts: [],
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

/** A registry holding both referenceable accounts. */
const REGISTRY = [
  { id: 'acme-corp', path: HINT_ROOT, label: 'Acme Corp' },
  { id: 'personal', path: AGENT_ROOT, label: 'Personal' },
];

describe('resolveLaunchAccountRoot — the ladder (spec billing-account-ladder invariant 3)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('takes the session hint over every lower rung', () => {
    process.env.CLAUDE_CONFIG_DIR = ENV_ROOT;
    expect(
      resolveLaunchAccountRoot({
        hintId: 'acme-corp',
        agentAccountId: 'personal',
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(HINT_ROOT);
  });

  it("takes the agent's account when no hint was sent", () => {
    process.env.CLAUDE_CONFIG_DIR = ENV_ROOT;
    expect(
      resolveLaunchAccountRoot({
        agentAccountId: 'personal',
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(AGENT_ROOT);
  });

  it('takes the server default when neither the session nor the agent names one', () => {
    process.env.CLAUDE_CONFIG_DIR = ENV_ROOT;
    expect(
      resolveLaunchAccountRoot({
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(DEFAULT_ROOT);
  });

  it('falls all the way through to the environment when nothing is configured', () => {
    process.env.CLAUDE_CONFIG_DIR = ENV_ROOT;
    expect(resolveLaunchAccountRoot({ config: fakeConfig({ accounts: REGISTRY }) })).toBe(ENV_ROOT);
  });

  it('ends at ~/.claude when the environment names nothing either', () => {
    expect(resolveLaunchAccountRoot({ config: fakeConfig() })).toBe(HOME_ROOT);
  });

  // Invariant 3: a launch NEVER fails on a bad account reference.

  it('falls through an unknown hint id, and says so', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(
      resolveLaunchAccountRoot({
        hintId: 'deleted-last-week',
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(DEFAULT_ROOT);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not registered'),
      expect.objectContaining({ source: 'session hint', id: 'deleted-last-week' })
    );
  });

  it('falls through an unknown agent id to the default, not to nothing', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(
      resolveLaunchAccountRoot({
        agentAccountId: 'renamed-directory',
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(DEFAULT_ROOT);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('not registered'),
      expect.objectContaining({ source: 'agent manifest' })
    );
  });

  it("lets the agent's account answer when only the HINT is unknown", () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(
      resolveLaunchAccountRoot({
        hintId: 'nope',
        agentAccountId: 'personal',
        config: fakeConfig({ accounts: REGISTRY, defaultAccount: DEFAULT_ROOT }),
      })
    ).toBe(AGENT_ROOT);
  });

  it('never throws on an unreadable config — it answers the environment', () => {
    process.env.CLAUDE_CONFIG_DIR = ENV_ROOT;
    const brokenConfig = {
      get: <K extends keyof UserConfig>(_key: K): UserConfig[K] => {
        throw new Error('config manager not initialized');
      },
    };
    expect(resolveLaunchAccountRoot({ hintId: 'acme-corp', config: brokenConfig })).toBe(ENV_ROOT);
  });
});

describe('named-by-absence holds at EVERY rung (invariant 2, ADR 260801-204128)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  });

  // The rule is a property of the RESOLVED ROOT, not of which rung produced it:
  // whenever the ladder lands on `~/.claude` and the ambient environment did not
  // name it, `CLAUDE_CONFIG_DIR` must reach the subprocess UNSET, or Claude Code
  // looks up a suffixed Keychain entry that was never created and sign-in fails.
  const homeRegistry = [{ id: 'home', path: HOME_ROOT, label: 'Home' }];

  it.each([
    ['the session hint', { hintId: 'home', config: fakeConfig({ accounts: homeRegistry }) }],
    [
      'the agent manifest',
      { agentAccountId: 'home', config: fakeConfig({ accounts: homeRegistry }) },
    ],
    ['the server default', { config: fakeConfig({ defaultAccount: HOME_ROOT }) }],
    ['the environment', { config: fakeConfig() }],
  ])('leaves CLAUDE_CONFIG_DIR unset when %s resolves to ~/.claude', (_rung, opts) => {
    const root = resolveLaunchAccountRoot(opts);
    expect(root).toBe(HOME_ROOT);
    expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: undefined });
  });

  it('still spells ~/.claude out when the launching environment named it', () => {
    // The one exception the rule carries: an operator who always exports
    // `CLAUDE_CONFIG_DIR=~/.claude` authenticated under that regime, so their
    // SUFFIXED Keychain entry is the one that exists.
    process.env.CLAUDE_CONFIG_DIR = HOME_ROOT;
    const root = resolveLaunchAccountRoot({
      hintId: 'home',
      config: fakeConfig({ accounts: homeRegistry }),
    });
    expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: HOME_ROOT });
  });

  it('names a NON-default root the ladder picked', () => {
    const root = resolveLaunchAccountRoot({
      hintId: 'acme-corp',
      config: fakeConfig({ accounts: REGISTRY }),
    });
    expect(claudeConfigDirEnv(root)).toEqual({ CLAUDE_CONFIG_DIR: HINT_ROOT });
  });
});
