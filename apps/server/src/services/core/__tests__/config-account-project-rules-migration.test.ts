/**
 * The `'0.93.0'` migration (spec `flow-multiproject` §8.1, DOR-2526): the
 * account rules are seeded as "no rule" on a config written before an account
 * could be kept to projects. `projectAccounts: {}`,
 * `defaultAccountOnlyProjects: null`, and `onlyProjects: null` on every
 * registry row, with every other member of every row kept.
 *
 * The upgrade cases boot a real `ConfigManager` at `0.93.0` over a realistic
 * stale file and read the FILE back, not the manager: conf's getter
 * re-validates every access, so a value it filled into the copy it hands back
 * would make a manager-level assertion pass with the body deleted (DOR-1496).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.93.0';
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_MIGRATIONS, ConfigManager, seedAccountProjectRules } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { writeOnlyProjects, writeProjectAccounts } from '../usage/account-eligibility-writes.js';

/** A conf-like store over one plain object. */
function memoryStore(initial: Record<string, unknown>) {
  const data = structuredClone(initial);
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

/** Two registered accounts as a 0.92 install stores them, one with a field flow wrote. */
const STALE_ROWS = [
  { id: 'work', path: '/Users/me/.claude-work', label: 'Work', color: '#12ab9f', seat: 2 },
  { id: 'personal', path: '/Users/me/.claude2', label: null, color: null },
];

describe('seedAccountProjectRules', () => {
  it('seeds every rule as "no rule" and keeps every other member', () => {
    const store = memoryStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: {
          defaultAccount: '/Users/me/.claude2',
          accounts: STALE_ROWS,
          defaultAccountColor: '#0d9488',
          persistentSession: false,
        },
      },
    });

    seedAccountProjectRules(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: {
        defaultAccount: '/Users/me/.claude2',
        accounts: STALE_ROWS.map((row) => ({ ...row, onlyProjects: null })),
        defaultAccountColor: '#0d9488',
        persistentSession: false,
        projectAccounts: {},
        defaultAccountOnlyProjects: null,
      },
    });
  });

  it('never overwrites a rule already there, and is a no-op on a second run', () => {
    const store = memoryStore({
      runtimes: {
        claudeCode: {
          accounts: [{ ...STALE_ROWS[0], onlyProjects: ['/work/client.app'] }],
          projectAccounts: { '/work/client.app': { allow: ['work'] } },
          defaultAccountOnlyProjects: ['/work/personal'],
        },
      },
    });
    const before = structuredClone(store.data);
    seedAccountProjectRules(store);
    seedAccountProjectRules(store);
    expect(store.data).toEqual(before);
  });

  it('leaves a config with no runtimes.claudeCode block alone', () => {
    for (const data of [{ ui: { theme: 'dark' } }, { runtimes: { codex: {} } }]) {
      const store = memoryStore(data);
      seedAccountProjectRules(store);
      expect(store.data).toEqual(data);
    }
  });

  it('is what the 0.93.0 key runs', () => {
    const store = memoryStore({ runtimes: { claudeCode: { accounts: [] } } });
    CONFIG_MIGRATIONS['0.93.0'](store);
    expect(store.data.runtimes).toEqual({
      claudeCode: { accounts: [], projectAccounts: {}, defaultAccountOnlyProjects: null },
    });
  });
});

describe('the 0.93.0 migration on an upgrade boot (real ConfigManager, real config.json)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A data directory holding a realistic config one release behind. */
  function staleInstall(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-account-rules-mig-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        runtimes: {
          default: 'claude-code',
          defaultTrustStop: 'act',
          claudeCode: {
            defaultAccount: '/Users/me/.claude2',
            accounts: STALE_ROWS,
            defaultAccountColor: null,
            dismissedFolders: ['/Users/me/.claude-old'],
            defaultModel: 'opus',
            defaultEffort: null,
            defaultTrustStop: null,
            persistentSession: true,
          },
        },
        extensions: { enabled: [], disabled: [], approvedToRun: [], dismissedApprovals: {} },
        __internal__: { migrations: { version: '0.92.0' } },
      })
    );
    return dir;
  }

  function readDisk(dir: string): { runtimes: { claudeCode: Record<string, unknown> } } {
    return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  }

  it('really is running the 0.93.0 migration', () => {
    expect(SERVER_VERSION).toBe('0.93.0');
  });

  it('writes the three rules to disk and keeps everything else', () => {
    const dir = staleInstall();
    new ConfigManager(dir);
    const block = readDisk(dir).runtimes.claudeCode;
    expect(block.projectAccounts).toEqual({});
    expect(block.defaultAccountOnlyProjects).toBeNull();
    expect(block.accounts).toEqual(STALE_ROWS.map((row) => ({ ...row, onlyProjects: null })));
    expect(block.defaultAccount).toBe('/Users/me/.claude2');
    expect(block.dismissedFolders).toEqual(['/Users/me/.claude-old']);
    expect(block.defaultModel).toBe('opus');
  });

  it('writes and reads back a project root that contains a dot', () => {
    // conf's dotted setter would split `/work/client.app` into nested keys;
    // every writer rewrites the whole block instead (spec §8.1).
    const dir = staleInstall();
    const manager = new ConfigManager(dir);
    writeProjectAccounts(manager, '/work/client.app', ['work', 'default']);
    expect(writeOnlyProjects(manager, 'work', ['/work/client.app', '/work/api.v2'])).toBe(true);
    writeOnlyProjects(manager, 'default', ['/work/client.app']);

    const block = readDisk(dir).runtimes.claudeCode;
    expect(block.projectAccounts).toEqual({ '/work/client.app': { allow: ['work', 'default'] } });
    expect(block.defaultAccountOnlyProjects).toEqual(['/work/client.app']);
    const work = (block.accounts as Record<string, unknown>[]).find((row) => row.id === 'work');
    // Edited by id, every other field kept, `seat` included.
    expect(work).toEqual({ ...STALE_ROWS[0], onlyProjects: ['/work/client.app', '/work/api.v2'] });

    // A fresh boot over the same file reads the same rules.
    const again = new ConfigManager(dir);
    expect(again.get('runtimes').claudeCode.projectAccounts).toEqual({
      '/work/client.app': { allow: ['work', 'default'] },
    });

    writeProjectAccounts(again, '/work/client.app', null);
    expect(readDisk(dir).runtimes.claudeCode.projectAccounts).toEqual({});
  });
});

describe('a hand-edited account rule of the wrong shape (real ConfigManager on disk)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // Purpose: a bad hand edit reads as "no rule" and never makes the loader move
  // config.json aside for a fresh file, which would lose every other setting.
  it('loads the file as it is, keeps unrelated settings, and reads the rule as no rule', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-account-rules-bad-'));
    dirs.push(dir);
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        runtimes: {
          claudeCode: {
            defaultAccount: null,
            accounts: [{ ...STALE_ROWS[0], onlyProjects: 'client-app' }],
            defaultAccountOnlyProjects: 'client-app',
            projectAccounts: {
              '/work/a': {},
              '/work/b': { allowed: ['work'] },
              '/work/c': { allow: ['work', ''] },
            },
          },
        },
        __internal__: { migrations: { version: '0.93.0' } },
      })
    );

    const manager = new ConfigManager(dir);

    // No recovery happened: nothing was set aside beside the file.
    expect(fs.readdirSync(dir).filter((name) => /bak|backup|corrupt/i.test(name))).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    expect(onDisk.ui.theme).toBe('dark');
    expect(onDisk.runtimes.claudeCode.defaultAccountOnlyProjects).toBe('client-app');
    expect(manager.get('ui').theme).toBe('dark');
    // The parse reads each bad shape as no rule, the same as the launch reader.
    const parsed = UserConfigSchema.parse(onDisk).runtimes.claudeCode;
    expect(parsed.defaultAccountOnlyProjects).toBeNull();
    expect(parsed.accounts[0]!.onlyProjects).toBeNull();
    expect(parsed.projectAccounts).toEqual({ '/work/c': { allow: ['work'] } });
  });
});
