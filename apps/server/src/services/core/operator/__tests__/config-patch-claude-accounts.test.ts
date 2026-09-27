/**
 * The Claude account registry through the real write path, on a real config
 * file (spec `claude-account-fleet` D1, marketplace `specs/flow-cli-core`
 * §1.1a). flow writes the same file, so the file on disk is what is asserted,
 * never an in-memory copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readClaudeAccountSettings } from '@dorkos/shared/config-schema';
import { initConfigManager, configManager } from '../../config-manager.js';
import { applyConfigPatch, resetClaudeAccountApplier } from '../config-patch.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
let configPath: string;

/** The registry as it is on disk right now. */
function accountsOnDisk(): Record<string, unknown>[] {
  const file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    runtimes: { claudeCode: { accounts: Record<string, unknown>[] } };
  };
  return file.runtimes.claudeCode.accounts;
}

/** Write the registry straight into the file, the way flow or a hand edit does. */
function writeAccountsExternally(accounts: unknown[]): void {
  const file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    runtimes: { claudeCode: Record<string, unknown> };
  };
  file.runtimes.claudeCode.accounts = accounts;
  fs.writeFileSync(configPath, JSON.stringify(file, null, 2));
}

/**
 * The rows the settings screen would send back: what `GET /api/config` lists,
 * reduced the way `toWritableAccounts` reduces them.
 */
function clientRows(): { id: string; path: string; label: string | null; color: string | null }[] {
  const { accounts } = readClaudeAccountSettings(configManager.get('runtimes').claudeCode);
  return accounts.map((account) => ({
    id: account.id,
    path: account.path,
    label: account.label,
    color: account.colorIsDefault ? null : account.color,
  }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-claude-accounts-'));
  configPath = path.join(dir, 'config.json');
  resetClaudeAccountApplier();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a config.json flow created', () => {
  it('boots and reads without being reset', () => {
    const row = { id: 'a', path: '/x', label: null, color: null };
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtimes: { claudeCode: { accounts: [row] } } }),
      'utf-8'
    );

    initConfigManager(dir);

    const { accounts } = readClaudeAccountSettings(configManager.get('runtimes').claudeCode);
    expect(accounts.map((a) => a.id)).toEqual(['a']);
    expect(accountsOnDisk()).toEqual([row]);
    // Nothing condemned the file: no recovery backup beside it.
    expect(fs.readdirSync(dir).filter((name) => name.includes('.bak'))).toEqual([]);
  });

  it('boots with rows the read rules skip, instead of condemning the file', () => {
    const rows = [
      { id: '', path: '/a', label: 'Acme' },
      { id: 'hand', path: 'relative', label: null },
      { id: 'pathless', label: null },
      { id: 'colored', path: '/c', label: null, color: 'RED' },
    ];
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtimes: { claudeCode: { accounts: rows } } }),
      'utf-8'
    );

    initConfigManager(dir);

    const { accounts } = readClaudeAccountSettings(configManager.get('runtimes').claudeCode);
    expect(accounts.map((a) => a.id)).toEqual(['acme', 'colored']);
    expect(accountsOnDisk()).toEqual(rows);
  });
});

describe('a hand-edited registry with rows of the wrong type', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a numeric label', { id: 'l', path: '/l', label: 5 }],
    ['a numeric path', { id: 'p', path: 5, label: null }],
    ['a numeric id', { id: 7, path: '/i', label: null }],
    ['a numeric color', { id: 'c', path: '/c', label: null, color: 3 }],
  ])('boots with %s as a row and keeps the good rows', (_what, bad) => {
    const good = { id: 'good', path: '/g', label: 'Good', color: null };
    const rows = [good, bad];
    fs.writeFileSync(
      configPath,
      JSON.stringify({ runtimes: { claudeCode: { accounts: rows } } }),
      'utf-8'
    );

    initConfigManager(dir);

    const { accounts } = readClaudeAccountSettings(configManager.get('runtimes').claudeCode);
    expect(accounts[0]).toMatchObject({ id: 'good', path: '/g' });
    expect(accountsOnDisk()).toEqual(rows);
    expect(fs.readdirSync(dir).filter((name) => name.includes('.bak'))).toEqual([]);
  });

  it('reads a numeric color as the default, and writes around it', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        runtimes: { claudeCode: { accounts: [{ id: 'c', path: '/c', label: null, color: 3 }] } },
      }),
      'utf-8'
    );
    initConfigManager(dir);

    const { accounts } = readClaudeAccountSettings(configManager.get('runtimes').claudeCode);
    expect(accounts[0]).toMatchObject({ colorIsDefault: true });
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
  });
});

describe('applyConfigPatch on the Claude account registry', () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf-8');
    initConfigManager(dir);
  });

  it('keeps an unknown row field and a row the client never saw when the client adds one', () => {
    writeAccountsExternally([
      { id: 'acme', path: '/a', label: 'Acme', color: '#12ab9f', seat: 'team-3' },
      { id: 'hand', path: 'relative/claude', label: null },
    ]);

    const result = applyConfigPatch({
      runtimes: {
        claudeCode: {
          accounts: [...clientRows(), { id: 'new', path: '/n', label: null, color: null }],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(accountsOnDisk()).toEqual([
      { id: 'acme', path: '/a', label: 'Acme', color: '#12ab9f', seat: 'team-3' },
      { id: 'new', path: '/n', label: null, color: null },
      { id: 'hand', path: 'relative/claude', label: null },
    ]);
  });

  it('lets the patch set color to null, and keeps what it leaves out', () => {
    writeAccountsExternally([{ id: 'acme', path: '/a', label: 'Acme', color: '#12ab9f', x: 1 }]);

    applyConfigPatch({ runtimes: { claudeCode: { accounts: [{ id: 'acme', color: null }] } } });

    expect(accountsOnDisk()).toEqual([
      { id: 'acme', path: '/a', label: 'Acme', color: null, x: 1 },
    ]);
  });

  it('removes a row the writer was shown and left out', () => {
    writeAccountsExternally([
      { id: 'a', path: '/a', label: null },
      { id: 'b', path: '/b', label: null },
    ]);

    applyConfigPatch({
      runtimes: {
        claudeCode: {
          accounts: clientRows().filter((r) => r.id !== 'b'),
          accountsSeen: ['a', 'b'],
        },
      },
    });

    expect(accountsOnDisk().map((r) => r.id)).toEqual(['a']);
  });

  it('treats every listed row as seen when the writer sends no list (the CLI, config_patch)', () => {
    writeAccountsExternally([
      { id: 'a', path: '/a', label: null },
      { id: 'b', path: '/b', label: null },
    ]);

    applyConfigPatch({
      runtimes: { claudeCode: { accounts: [{ id: 'a', path: '/a', label: 'A' }] } },
    });

    expect(accountsOnDisk().map((r) => r.id)).toEqual(['a']);
  });

  it('never stores accountsSeen, and refuses one that is not a list of ids', () => {
    writeAccountsExternally([{ id: 'a', path: '/a', label: null }]);

    expect(
      applyConfigPatch({
        runtimes: { claudeCode: { accounts: clientRows(), accountsSeen: ['a'] } },
      }).ok
    ).toBe(true);
    const file = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(file.runtimes.claudeCode).not.toHaveProperty('accountsSeen');

    const refused = applyConfigPatch({
      runtimes: { claudeCode: { accounts: [], accountsSeen: 'a' } },
    });
    expect(refused.ok).toBe(false);
    expect(accountsOnDisk().map((r) => r.id)).toEqual(['a']);
  });

  describe('a stale settings screen, and an account flow added after it loaded', () => {
    beforeEach(() => {
      writeAccountsExternally([{ id: 'a', path: '/a', label: null }]);
    });

    /** What the screen loaded, before flow wrote. */
    function loadScreen() {
      const rows = clientRows();
      return { rows, seen: rows.map((row) => row.id) };
    }

    function flowAdds(): void {
      writeAccountsExternally([
        ...accountsOnDisk(),
        { id: 'flow-added', path: '/f', label: null, color: null },
      ]);
    }

    it('keeps it when the screen saves', () => {
      const screen = loadScreen();
      flowAdds();

      applyConfigPatch({
        runtimes: {
          claudeCode: {
            accounts: screen.rows.map((row) => ({ ...row, label: 'A' })),
            accountsSeen: screen.seen,
          },
        },
      });

      expect(accountsOnDisk().map((r) => r.id)).toEqual(['a', 'flow-added']);
    });

    it('keeps it when the screen adds an account', () => {
      const screen = loadScreen();
      flowAdds();

      applyConfigPatch({
        runtimes: {
          claudeCode: {
            accounts: [...screen.rows, { id: 'new', path: '/n', label: null, color: null }],
            accountsSeen: screen.seen,
          },
        },
      });

      expect(accountsOnDisk().map((r) => r.id)).toEqual(['a', 'new', 'flow-added']);
    });

    it('keeps it when the screen removes a different account', () => {
      const screen = loadScreen();
      flowAdds();

      applyConfigPatch({
        runtimes: { claudeCode: { accounts: [], accountsSeen: screen.seen } },
      });

      expect(accountsOnDisk().map((r) => r.id)).toEqual(['flow-added']);
    });
  });

  it('matches a row whose id changed to its stored row by path', () => {
    writeAccountsExternally([{ id: 'acme', path: '/a', label: 'Acme', seat: 3 }]);

    const result = applyConfigPatch({
      runtimes: { claudeCode: { accounts: [{ id: 'acme-corp', path: '/a', label: 'Acme' }] } },
    });

    expect(result.ok).toBe(true);
    expect(accountsOnDisk()).toEqual([
      { id: 'acme-corp', path: '/a', label: 'Acme', color: null, seat: 3 },
    ]);
  });

  it('merges a duplicated id into the FIRST stored row and leaves the skipped one alone', () => {
    writeAccountsExternally([
      { id: 'acme', path: '/first', label: null, seat: 1 },
      { id: 'acme', path: '/second', label: null, seat: 2 },
    ]);

    const result = applyConfigPatch({
      runtimes: { claudeCode: { accounts: [{ id: 'acme', path: '/first', label: 'Acme' }] } },
    });

    expect(result.ok).toBe(true);
    expect(accountsOnDisk()).toEqual([
      { id: 'acme', path: '/first', label: 'Acme', color: null, seat: 1 },
      { id: 'acme', path: '/second', label: null, seat: 2 },
    ]);
  });

  it('does not trip an unrelated write over a hand-edited row', () => {
    writeAccountsExternally([{ id: 'pathless', label: null }]);

    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
    expect(
      applyConfigPatch({ runtimes: { claudeCode: { defaultAccount: '/Users/me/.claude2' } } }).ok
    ).toBe(true);
    expect(accountsOnDisk()).toEqual([{ id: 'pathless', label: null }]);
  });

  describe('the id rules on write', () => {
    beforeEach(() => {
      writeAccountsExternally([
        { id: 'Legacy_Id', path: '/legacy', label: null },
        { id: 'default', path: '/old-default', label: null },
      ]);
    });

    it('never refuses a row whose id is unchanged, however it is spelled', () => {
      const result = applyConfigPatch({
        runtimes: {
          claudeCode: { accounts: [...clientRows(), { id: 'ok', path: '/ok', label: null }] },
        },
      });
      expect(result.ok).toBe(true);
    });

    it('refuses a new row whose id fails the pattern, naming the row', () => {
      const result = applyConfigPatch({
        runtimes: {
          claudeCode: { accounts: [...clientRows(), { id: 'Bad_Id', path: '/n', label: null }] },
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.details).toEqual([expect.stringContaining('accounts.2.id')]);
      expect(accountsOnDisk().map((r) => r.id)).toEqual(['Legacy_Id', 'default']);
    });

    it('refuses default as a new id', () => {
      writeAccountsExternally([]);
      const result = applyConfigPatch({
        runtimes: { claudeCode: { accounts: [{ id: 'default', path: '/n', label: null }] } },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.details?.[0]).toContain('reserved');
    });

    it('refuses default as a changed id', () => {
      writeAccountsExternally([{ id: 'acme', path: '/a', label: null }]);
      const result = applyConfigPatch({
        runtimes: { claudeCode: { accounts: [{ id: 'default', path: '/a', label: null }] } },
      });
      expect(result.ok).toBe(false);
      expect(accountsOnDisk()).toEqual([{ id: 'acme', path: '/a', label: null }]);
    });

    it('refuses a changed id that fails the pattern', () => {
      writeAccountsExternally([{ id: 'acme', path: '/a', label: null }]);
      const result = applyConfigPatch({
        runtimes: { claudeCode: { accounts: [{ id: 'Acme Corp', path: '/a', label: null }] } },
      });
      expect(result.ok).toBe(false);
    });
  });

  it('merges onto the file as it is NOW, so a row flow added between two writes survives', () => {
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
    // `flow accounts add`, while the server runs.
    writeAccountsExternally([{ id: 'flow-added', path: '/f', label: null, color: null }]);

    const result = applyConfigPatch({
      runtimes: { claudeCode: { defaultAccount: '/Users/me/.claude2' } },
    });

    expect(result.ok).toBe(true);
    expect(accountsOnDisk()).toEqual([{ id: 'flow-added', path: '/f', label: null, color: null }]);
  });
});

describe('an unrelated write beside rows the read rules skip', () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, JSON.stringify({}), 'utf-8');
    initConfigManager(dir);
  });

  it('reports the registry as unchanged', () => {
    writeAccountsExternally([
      { id: 'a', path: '/a', label: null },
      { id: 'hand', path: 'relative', label: null },
    ]);

    const result = applyConfigPatch({ ui: { theme: 'light' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.before.runtimes.claudeCode.accounts).toEqual(
      result.config.runtimes.claudeCode.accounts
    );
  });
});
