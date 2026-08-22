import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  claudeConfigDirEnv,
  describeClaudeCodeAccounts,
  resolveActiveClaudeRoot,
  resolveClaudeRootSet,
} from '../claude-config-dir.js';

/**
 * A config reader over one `runtimes.claudeCode` section, standing in for the
 * `configManager` singleton the resolvers default to (the same injection seam
 * `credential-env.ts` uses).
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

/** A config reader that throws, standing in for the uninitialized singleton. */
const brokenConfig = {
  get: <K extends keyof UserConfig>(_key: K): UserConfig[K] => {
    throw new Error('config manager not initialized');
  },
};

describe('resolveActiveClaudeRoot (spec claude-code-accounts D2)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    }
  });

  it('falls back to ~/.claude with the field at its default and no env var', () => {
    expect(resolveActiveClaudeRoot(fakeConfig())).toBe(path.join(os.homedir(), '.claude'));
  });

  it('inherits CLAUDE_CONFIG_DIR with the field at its default', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(resolveActiveClaudeRoot(fakeConfig())).toBe('/tmp/inherited-claude');
  });

  it('OVERRIDES an inherited CLAUDE_CONFIG_DIR with an explicit defaultAccount', () => {
    // The determinism the feature exists for: which account runs the work must not
    // depend on which terminal happened to launch DorkOS (acceptance criterion 3).
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(resolveActiveClaudeRoot(fakeConfig({ defaultAccount: '/tmp/chosen-claude' }))).toBe(
      '/tmp/chosen-claude'
    );
  });

  it('degrades to the inherited default when the config cannot be read', () => {
    // The singleton is undefined before `initConfigManager()` runs, and this sits
    // on the transcript read path — failing there must not break a read.
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(resolveActiveClaudeRoot(brokenConfig)).toBe('/tmp/inherited-claude');
  });

  it('re-reads the env var on every call (no stale caching)', () => {
    // The SDK subprocess reads the variable per spawn, so a value cached at
    // module load would split-brain the moment anything changed it (DOR-250).
    expect(resolveActiveClaudeRoot(fakeConfig())).toBe(path.join(os.homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/second-config';
    expect(resolveActiveClaudeRoot(fakeConfig())).toBe('/tmp/second-config');
  });
});

describe('resolveClaudeRootSet (spec claude-code-accounts D2/D4)', () => {
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let tmp: string;
  /** `~/.claude` under the staged HOME — created only by the test that needs it. */
  let stagedHomeRoot: string;

  /** Create a directory that qualifies as an account (it holds `projects/`). */
  function makeAccount(dir: string): string {
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
    return dir;
  }

  /** Create a directory that exists but is NOT an account (no `projects/`). */
  function makeNonAccount(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-root-set-'));
    // `~/.claude` is an UNCONDITIONAL candidate, so the answer depends on the
    // real home directory unless the test owns it. Staging HOME is the sanctioned
    // way to do that here (`.claude/rules/dork-home.md`); it also keeps the suite
    // from reading whatever accounts the developer happens to have.
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    stagedHomeRoot = path.join(tmp, '.claude');
  });

  afterEach(() => {
    for (const [key, value] of [
      ['CLAUDE_CONFIG_DIR', ORIGINAL.configDir],
      ['HOME', ORIGINAL.home],
      ['USERPROFILE', ORIGINAL.userProfile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('proves the staged HOME is what the resolver reads', () => {
    // Guards every assertion below: if HOME staging stopped working, they would
    // silently start describing the developer's own machine.
    expect(os.homedir()).toBe(tmp);
  });

  it('names the active root once, not three times, when env and config agree', () => {
    // Active root, `$CLAUDE_CONFIG_DIR` and the registered path are all the same
    // directory here, so a set that is not deduplicated would scan it repeatedly.
    const account = makeAccount(path.join(tmp, 'claude2'));
    process.env.CLAUDE_CONFIG_DIR = account;
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: account,
        accounts: [{ id: 'acme', path: account, label: 'Acme' }],
      })
    );
    expect(roots).toEqual([account]);
  });

  it('treats two spellings of one directory as one root', () => {
    const account = makeAccount(path.join(tmp, 'claude2'));
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: account,
        accounts: [{ id: 'acme', path: `${account}${path.sep}`, label: 'Acme' }],
      })
    );
    expect(roots).toEqual([account]);
  });

  it('puts the active root first and keeps every registered account after it', () => {
    const active = makeAccount(path.join(tmp, 'claude2'));
    const other = makeAccount(path.join(tmp, 'claude3'));
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: active,
        accounts: [
          { id: 'beta-inc', path: other, label: 'Beta Inc' },
          { id: 'acme-corp', path: active, label: 'Acme Corp' },
        ],
      })
    );
    expect(roots).toEqual([active, other]);
  });

  it('keeps ~/.claude in the set even when another account is active', () => {
    // Unconditional by decision (D2): the SDK may already have written there, and
    // dropping it would hide history.
    makeAccount(stagedHomeRoot);
    const active = makeAccount(path.join(tmp, 'claude2'));
    expect(resolveClaudeRootSet(fakeConfig({ defaultAccount: active }))).toEqual([
      active,
      stagedHomeRoot,
    ]);
  });

  it('adds $CLAUDE_CONFIG_DIR even when a different account is active', () => {
    // Selecting an account must not silently stop covering the root the SDK was
    // already pointed at.
    const active = makeAccount(path.join(tmp, 'claude2'));
    const inherited = makeAccount(path.join(tmp, 'claude-from-shell'));
    process.env.CLAUDE_CONFIG_DIR = inherited;
    expect(resolveClaudeRootSet(fakeConfig({ defaultAccount: active }))).toEqual([
      active,
      inherited,
    ]);
  });

  it('excludes a registered directory that exists but holds no projects/', () => {
    // `~/.claude-worktrees` and `~/.claudekit` are real directories that are not
    // accounts, which is exactly why the check is structural rather than a glob.
    const account = makeAccount(path.join(tmp, 'claude2'));
    const notAnAccount = makeNonAccount(path.join(tmp, 'claudekit'));
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: account,
        accounts: [{ id: 'not-an-account', path: notAnAccount, label: 'not an account' }],
      })
    );
    expect(roots).toEqual([account]);
  });

  it('skips a registered path that does not exist, silently', () => {
    const account = makeAccount(path.join(tmp, 'claude2'));
    const gone = path.join(tmp, 'deleted-account');
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: account,
        accounts: [{ id: 'moved', path: gone, label: 'moved' }],
      })
    );
    expect(roots).toEqual([account]);
  });

  it('excludes even the ACTIVE root when it does not qualify', () => {
    // An active account with no `projects/` has no sessions to enumerate, so the
    // listing set is empty rather than carrying a root that yields nothing.
    expect(
      resolveClaudeRootSet(fakeConfig({ defaultAccount: makeNonAccount(path.join(tmp, 'empty')) }))
    ).toEqual([]);
  });

  it('does not throw when the config cannot be read', () => {
    const inherited = makeAccount(path.join(tmp, 'claude-from-shell'));
    process.env.CLAUDE_CONFIG_DIR = inherited;
    expect(resolveClaudeRootSet(brokenConfig)).toEqual([inherited]);
  });
});

describe('describeClaudeCodeAccounts (the GET /api/config block)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;
  let tmp: string;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-accounts-'));
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports the inherited default as resolved, so the UI never shows an empty field', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(describeClaudeCodeAccounts(fakeConfig())).toEqual({
      resolvedAccount: '/tmp/inherited-claude',
      inherited: true,
      accounts: [],
    });
  });

  it('reports a chosen account as not inherited', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(describeClaudeCodeAccounts(fakeConfig({ defaultAccount: '/tmp/chosen' }))).toMatchObject(
      {
        resolvedAccount: '/tmp/chosen',
        inherited: false,
      }
    );
  });

  it('says which registered accounts DorkOS can currently find', () => {
    const real = path.join(tmp, 'claude2');
    fs.mkdirSync(path.join(real, 'projects'), { recursive: true });
    const missing = path.join(tmp, 'gone');
    expect(
      describeClaudeCodeAccounts(
        fakeConfig({
          accounts: [
            { id: 'acme-corp', path: real, label: 'Acme Corp' },
            { id: 'gone', path: missing, label: null },
          ],
        })
      ).accounts
    ).toEqual([
      { id: 'acme-corp', path: real, label: 'Acme Corp', isAccountRoot: true },
      { id: 'gone', path: missing, label: null, isAccountRoot: false },
    ]);
  });

  // An empty `accounts` list has two opposite meanings and the wire has to tell
  // them apart. Read as "nothing is registered", a failed read would make every
  // agent with an account reference look broken at once, on every surface, for
  // the length of the outage.
  it('flags a registry it could not READ, so an empty list is not read as an answer', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(describeClaudeCodeAccounts(brokenConfig)).toEqual({
      resolvedAccount: '/tmp/inherited-claude',
      inherited: true,
      accounts: [],
      accountsUnavailable: true,
    });
  });

  // The discriminator: a registry that really is empty carries no flag at all,
  // so the key's mere presence is the claim and nothing else has to be read.
  it('sends no flag at all when the registry is genuinely empty', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/inherited-claude';
    expect(describeClaudeCodeAccounts(fakeConfig())).not.toHaveProperty('accountsUnavailable');
  });
});

describe('claudeConfigDirEnv (spec claude-code-accounts D8)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  });

  it('names a chosen account explicitly', () => {
    expect(claudeConfigDirEnv('/Users/dev/.claude2')).toEqual({
      CLAUDE_CONFIG_DIR: '/Users/dev/.claude2',
    });
  });

  it('names the default account by ABSENCE when nothing set the variable', () => {
    // Not a shortcut: Claude Code takes the unsuffixed macOS Keychain name
    // exactly when this variable is UNSET, so writing the default path where
    // nothing was set points the CLI at an entry that does not exist. Absence is
    // the faithful spelling of the default account.
    const answer = claudeConfigDirEnv(path.join(os.homedir(), '.claude'));

    expect(answer.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Present-as-undefined, so it still ERASES an inherited value: Node drops
    // undefined entries when it builds a child's environment.
    expect('CLAUDE_CONFIG_DIR' in answer).toBe(true);
  });

  it('still names the default account by ABSENCE when an UNRELATED account is inherited', () => {
    // The case that decides this: the launching shell exported ~/.claude3, and the
    // operator then selected ~/.claude in the cockpit. Spelling the default path
    // out here sends Claude Code to `Claude Code-credentials-<hash of ~/.claude>`,
    // which does NOT exist — the unsuffixed entry is the one absence created — so
    // the turn fails to sign in. Which branch Claude Code is ON is not the same
    // question as whether the name for the WANTED account exists.
    process.env.CLAUDE_CONFIG_DIR = '/Users/dev/.claude3';
    const answer = claudeConfigDirEnv(path.join(os.homedir(), '.claude'));

    expect(answer.CLAUDE_CONFIG_DIR).toBeUndefined();
    // Still present-as-undefined, which is what ERASES the inherited ~/.claude3
    // rather than letting the subprocess pick it up (acceptance criterion 3).
    expect('CLAUDE_CONFIG_DIR' in answer).toBe(true);
  });

  it('names the default account by ABSENCE when the inherited account is a sibling', () => {
    // The reported failure verbatim: launched from a shell exporting
    // `CLAUDE_CONFIG_DIR=~/.claude2`, ~/.claude selected in the cockpit.
    process.env.CLAUDE_CONFIG_DIR = path.join(os.homedir(), '.claude2');

    expect(
      claudeConfigDirEnv(path.join(os.homedir(), '.claude')).CLAUDE_CONFIG_DIR
    ).toBeUndefined();
  });

  it('names the default account EXPLICITLY when the inherited variable already named it', () => {
    // The one path to ~/.claude where the suffixed Keychain entry genuinely
    // exists: this operator always exports CLAUDE_CONFIG_DIR=~/.claude, so they
    // authenticated under that regime and pinning the path is right for them.
    const defaultRoot = path.join(os.homedir(), '.claude');
    process.env.CLAUDE_CONFIG_DIR = defaultRoot;

    expect(claudeConfigDirEnv(defaultRoot)).toEqual({ CLAUDE_CONFIG_DIR: defaultRoot });
  });

  it('ignores a trailing separator when deciding whether the root is the default', () => {
    expect(claudeConfigDirEnv(`${path.join(os.homedir(), '.claude')}/`)).toEqual({
      CLAUDE_CONFIG_DIR: undefined,
    });
  });
});
