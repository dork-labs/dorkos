import { DEFAULT_ACCOUNT_COLORS } from '@dorkos/shared/account-usage';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  resolveLaunchAccountRoot,
} from '../claude-config-dir.js';
import { logger } from '../../../../lib/logger.js';

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
      defaultAccountColor: null,
      dismissedFolders: [],
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

describe('a default account stored with ~ (written by hand, or before it was expanded on write)', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  });

  /** What a launch hands the child: the ladder's folder, spelled as the env var. */
  function launchEnv(defaultAccount: string | null): { CLAUDE_CONFIG_DIR: string | undefined } {
    return claudeConfigDirEnv(resolveLaunchAccountRoot({ config: fakeConfig({ defaultAccount }) }));
  }

  it('launches ~/.claude2 in the expanded folder, not a folder literally named ~', () => {
    // No shell sits between the env object and the child, so nothing else would
    // ever expand it.
    expect(launchEnv('~/.claude2')).toEqual({
      CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude2'),
    });
    expect(resolveActiveClaudeRoot(fakeConfig({ defaultAccount: '~/.claude2' }))).toBe(
      path.join(os.homedir(), '.claude2')
    );
  });

  it('launches ~/.claude with the variable UNSET, which is what its Keychain entry answers to', () => {
    const answer = launchEnv('~/.claude');
    expect(answer.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect('CLAUDE_CONFIG_DIR' in answer).toBe(true);
  });

  it('launches an absolute folder exactly as stored', () => {
    expect(launchEnv('/Users/dev/.claude2')).toEqual({ CLAUDE_CONFIG_DIR: '/Users/dev/.claude2' });
  });

  it('shows Settings the expanded folder as where new sessions run', () => {
    expect(describeClaudeCodeAccounts(fakeConfig({ defaultAccount: '~/.claude2' }))).toMatchObject({
      resolvedAccount: path.join(os.homedir(), '.claude2'),
      inherited: false,
    });
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
        accounts: [{ id: 'acme', path: account, label: 'Acme', color: null }],
      })
    );
    expect(roots).toEqual([account]);
  });

  it('treats two spellings of one directory as one root', () => {
    const account = makeAccount(path.join(tmp, 'claude2'));
    const roots = resolveClaudeRootSet(
      fakeConfig({
        defaultAccount: account,
        accounts: [{ id: 'acme', path: `${account}${path.sep}`, label: 'Acme', color: null }],
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
          { id: 'beta-inc', path: other, label: 'Beta Inc', color: null },
          { id: 'acme-corp', path: active, label: 'Acme Corp', color: null },
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
        accounts: [
          { id: 'not-an-account', path: notAnAccount, label: 'not an account', color: null },
        ],
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
        accounts: [{ id: 'moved', path: gone, label: 'moved', color: null }],
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
      defaultAccountColor: null,
      defaultAccountResolvedColor: DEFAULT_ACCOUNT_COLORS[0],
      // No row: Main is ~/.claude (never the env, contract rev 6d), and nobody
      // registered the inherited folder. The override says where sessions go.
      launchOverride: { env: 'CLAUDE_CONFIG_DIR', path: '/tmp/inherited-claude' },
    });
  });

  describe('the default account color, decided here and nowhere else (DOR-2492)', () => {
    const row = (id: string, dir: string, color: string | null) => ({
      id,
      path: dir,
      label: null,
      color,
    });

    it('ignores CLAUDE_CONFIG_DIR: a row at the inherited folder is NOT the default', () => {
      // The client sees `resolvedAccount` = /x and a row at /x, and could read
      // that as an alias. The server's rule resolves `default` from config and
      // home only, so the default stands alone, after the row.
      const x = path.join(tmp, 'x');
      fs.mkdirSync(x);
      process.env.CLAUDE_CONFIG_DIR = x;
      const described = describeClaudeCodeAccounts(
        fakeConfig({ accounts: [row('x', x, '#9b51e0')], defaultAccountColor: '#0d9488' })
      );
      expect(described.resolvedAccount).toBe(x);
      expect(described.defaultAccountResolvedColor).toBe('#0d9488');
      const none = describeClaudeCodeAccounts(fakeConfig({ accounts: [row('x', x, '#9b51e0')] }));
      expect(none.defaultAccountResolvedColor).toBe(DEFAULT_ACCOUNT_COLORS[1]);
    });

    it('finds the alias through a symlink, and draws the row color', () => {
      const real = path.join(tmp, 'real');
      const link = path.join(tmp, 'link');
      fs.mkdirSync(real);
      fs.symlinkSync(real, link);
      const described = describeClaudeCodeAccounts(
        fakeConfig({
          defaultAccount: link,
          accounts: [row('main', real, '#9b51e0')],
          defaultAccountColor: '#0d9488',
        })
      );
      expect(described.defaultAccountResolvedColor).toBe('#9b51e0');
    });

    it('counts only the rows the read rules list for the positional fallback', () => {
      // A row with no absolute path is skipped, so the default is at position 1.
      const described = describeClaudeCodeAccounts(
        fakeConfig({
          defaultAccount: path.join(tmp, 'main'),
          accounts: [row('a', path.join(tmp, 'a'), null), row('bad', 'relative/path', null)],
        })
      );
      expect(described.defaultAccountResolvedColor).toBe(DEFAULT_ACCOUNT_COLORS[1]);
    });
  });

  it('logs a minted id at debug level, since every un-migrated install has one', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const rows = [
        { path: path.join(tmp, 'minted-row'), label: null },
        { id: 'Bad_Id', path: path.join(tmp, 'bad-row'), label: null },
      ] as unknown as UserConfig['runtimes']['claudeCode']['accounts'];
      describeClaudeCodeAccounts(fakeConfig({ accounts: rows }));
      const codes = (spy: typeof debug) =>
        spy.mock.calls
          .filter(([message]) => String(message).startsWith('[claude-accounts]'))
          .map(([, meta]) => (meta as { code: string }).code);
      expect(codes(debug)).toEqual(['id-minted']);
      expect(codes(warn)).toEqual(['id-invalid']);
    } finally {
      debug.mockRestore();
      warn.mockRestore();
    }
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
            { id: 'acme-corp', path: real, label: 'Acme Corp', color: '#12ab9f' },
            { id: 'gone', path: missing, label: null, color: null },
          ],
        })
      ).accounts
    ).toEqual([
      {
        id: 'acme-corp',
        path: real,
        label: 'Acme Corp',
        color: '#12ab9f',
        colorIsDefault: false,
        isAccountRoot: true,
      },
      {
        id: 'gone',
        path: missing,
        label: null,
        // No stored color: the default for its position, the second one.
        color: DEFAULT_ACCOUNT_COLORS[1],
        colorIsDefault: true,
        isAccountRoot: false,
      },
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
      defaultAccountColor: null,
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

describe('describeClaudeCodeAccounts: the row new sessions run on (resolvedAccountId)', () => {
  const ORIGINAL = {
    configDir: process.env.CLAUDE_CONFIG_DIR,
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
  };
  let tmp: string;
  const row = (id: string, dir: string) => ({ id, path: dir, label: null, color: null });

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
    // Real path: macOS hands out /var/... for a /private/var/... folder, and the
    // canonical comparison resolves symlinks, so the test owns a real one.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resolved-row-')));
    // `~` and the built-in `~/.claude` both read the OS home, so the test owns it.
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    fs.mkdirSync(path.join(tmp, '.claude'));
    fs.mkdirSync(path.join(tmp, '.claude2'));
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
    expect(os.homedir()).toBe(tmp);
  });

  it('names the row whose folder the default is, even with a trailing slash', () => {
    const second = path.join(tmp, '.claude2');
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: `${second}/`, accounts: [row('acme', second)] })
    );
    expect(described.resolvedAccountId).toBe('acme');
  });

  it('names the row a symlinked default points at', () => {
    const second = path.join(tmp, '.claude2');
    const link = path.join(tmp, 'link-to-claude2');
    fs.symlinkSync(second, link);
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: link, accounts: [row('acme', second)] })
    );
    expect(described.resolvedAccountId).toBe('acme');
  });

  it('matches a ~ default against the absolute row it names', () => {
    // Only the default can be spelled with `~`: a row without an absolute path
    // is not listed at all (`readClaudeAccountSettings`).
    const second = path.join(tmp, '.claude2');
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: '~/.claude2', accounts: [row('acme', second)] })
    );
    expect(described.resolvedAccountId).toBe('acme');
  });

  it('follows $CLAUDE_CONFIG_DIR with no default chosen, because new sessions do', () => {
    const second = path.join(tmp, '.claude2');
    process.env.CLAUDE_CONFIG_DIR = `${second}/`;
    const described = describeClaudeCodeAccounts(
      fakeConfig({ accounts: [row('main', path.join(tmp, '.claude')), row('acme', second)] })
    );
    expect(described.resolvedAccountId).toBe('acme');
  });

  it('names the row at ~/.claude when nothing is chosen and nothing is inherited', () => {
    const described = describeClaudeCodeAccounts(
      fakeConfig({
        defaultAccount: null,
        accounts: [row('acme', path.join(tmp, '.claude2')), row('main', path.join(tmp, '.claude'))],
      })
    );
    expect(described.resolvedAccountId).toBe('main');
  });

  it("says 'default' when the default stands alone (null default, ~/.claude unregistered)", () => {
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: null, accounts: [row('acme', path.join(tmp, '.claude2'))] })
    );
    expect(described.resolvedAccountId).toBe('default');
  });

  it("says 'default' when the chosen folder is one nobody registered", () => {
    const loose = path.join(tmp, '.claude-loose');
    fs.mkdirSync(loose);
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: loose, accounts: [row('acme', path.join(tmp, '.claude2'))] })
    );
    expect(described.resolvedAccountId).toBe('default');
  });

  it('names no row when $CLAUDE_CONFIG_DIR is an unregistered folder and ~/.claude is registered', () => {
    const loose = path.join(tmp, '.claude-loose');
    fs.mkdirSync(loose);
    process.env.CLAUDE_CONFIG_DIR = loose;
    const described = describeClaudeCodeAccounts(
      fakeConfig({ accounts: [row('main', path.join(tmp, '.claude'))] })
    );
    expect(described).not.toHaveProperty('resolvedAccountId');
    // Where new sessions go instead, for Settings to say in words.
    expect(described.launchOverride).toEqual({ env: 'CLAUDE_CONFIG_DIR', path: loose });
  });

  it('names Main and sends no launch override when $CLAUDE_CONFIG_DIR is ~/.claude itself', () => {
    process.env.CLAUDE_CONFIG_DIR = `${path.join(tmp, '.claude')}/`;
    const described = describeClaudeCodeAccounts(
      fakeConfig({ accounts: [row('acme', path.join(tmp, '.claude2'))] })
    );
    expect(described.resolvedAccountId).toBe('default');
    expect(described).not.toHaveProperty('launchOverride');
  });

  it('names the row and sends no launch override when $CLAUDE_CONFIG_DIR is a registered row', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude2');
    const described = describeClaudeCodeAccounts(
      fakeConfig({ accounts: [row('acme', path.join(tmp, '.claude2'))] })
    );
    expect(described.resolvedAccountId).toBe('acme');
    expect(described).not.toHaveProperty('launchOverride');
  });

  it('reports no launch override once a default is chosen, even with the variable set', () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, '.claude2');
    const described = describeClaudeCodeAccounts(
      fakeConfig({ defaultAccount: path.join(tmp, '.claude'), accounts: [] })
    );
    expect(described).not.toHaveProperty('launchOverride');
    expect(described.resolvedAccountId).toBe('default');
  });

  it('does not call it Main when $CLAUDE_CONFIG_DIR is an unregistered folder and ~/.claude is not registered', () => {
    // Main stands for ~/.claude (the usage store never reads the environment),
    // while new sessions run in the inherited folder: neither row is honest.
    const loose = path.join(tmp, '.claude-loose');
    fs.mkdirSync(loose);
    process.env.CLAUDE_CONFIG_DIR = loose;
    const described = describeClaudeCodeAccounts(
      fakeConfig({ accounts: [row('acme', path.join(tmp, '.claude2'))] })
    );
    expect(described).not.toHaveProperty('resolvedAccountId');
    expect(described.launchOverride).toEqual({ env: 'CLAUDE_CONFIG_DIR', path: loose });
  });

  it('omits it when the registry cannot be read, rather than guessing', () => {
    expect(describeClaudeCodeAccounts(brokenConfig)).not.toHaveProperty('resolvedAccountId');
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
