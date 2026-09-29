/**
 * The `'0.87.0'` migration: a Claude account row called `default` is renamed
 * to the next free `default-N` (spec `claude-account-fleet` D1, contract
 * `flow-cli-core` §1.1a revision 6d), because `default` now names the default
 * account itself.
 *
 * The full-path case reads the FILE, not the manager: conf's store getter
 * re-validates every access, so a value it filled into the copy it hands back
 * would make a manager-level assertion pass with the body deleted (DOR-1496).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  renameReservedClaudeAccountIds,
} from '../config-manager.js';

/** A minimal conf-like store over one plain object. */
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

/** A store holding one registry. */
function storeWith(accounts: unknown[]) {
  return memoryStore({ runtimes: { claudeCode: { defaultAccount: null, accounts } } });
}

/** The registry a store holds after a run. */
function accountsIn(store: ReturnType<typeof memoryStore>): unknown[] {
  return (store.data.runtimes as { claudeCode: { accounts: unknown[] } }).claudeCode.accounts;
}

describe('renameReservedClaudeAccountIds', () => {
  it('renames a row called default to default-2 and marks where it came from', () => {
    const store = storeWith([
      { id: 'acme', path: '/a', label: 'Acme' },
      { id: 'default', path: '/d', label: 'Default', color: '#12ab9f', seat: 1 },
    ]);

    renameReservedClaudeAccountIds(store);

    expect(accountsIn(store)).toEqual([
      { id: 'acme', path: '/a', label: 'Acme' },
      {
        id: 'default-2',
        path: '/d',
        label: 'Default',
        color: '#12ab9f',
        seat: 1,
        renamedFrom: 'default',
      },
    ]);
  });

  it('skips an id another row already owns', () => {
    const store = storeWith([
      { id: 'default-2', path: '/x', label: null },
      { id: 'default', path: '/d', label: null },
    ]);

    renameReservedClaudeAccountIds(store);

    expect(accountsIn(store)).toMatchObject([{ id: 'default-2' }, { id: 'default-3' }]);
  });

  it('is a no-op on a second run and on a registry with no such row', () => {
    const store = storeWith([{ id: 'default', path: '/d', label: null }]);
    renameReservedClaudeAccountIds(store);
    const once = structuredClone(store.data);
    renameReservedClaudeAccountIds(store);
    expect(store.data).toEqual(once);

    const untouched = storeWith([{ id: 'acme', path: '/a', label: null }]);
    const before = structuredClone(untouched.data);
    renameReservedClaudeAccountIds(untouched);
    expect(untouched.data).toEqual(before);
  });

  it('leaves a config with no registry alone', () => {
    const store = memoryStore({ ui: { theme: 'dark' } });
    renameReservedClaudeAccountIds(store);
    expect(store.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('is what the 0.87.0 key runs', () => {
    const store = storeWith([{ id: 'default', path: '/d', label: null }]);
    CONFIG_MIGRATIONS['0.87.0'](store);
    expect(accountsIn(store)).toMatchObject([{ id: 'default-2', renamedFrom: 'default' }]);
  });
});

describe('a real pre-0.87.0 config file (full conf path)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('renames the row on disk and keeps everything else', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-reserved-account-mig-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        runtimes: {
          claudeCode: {
            defaultAccount: '/d',
            accounts: [
              { id: 'acme', path: '/a', label: 'Acme' },
              { id: 'default', path: '/d', label: 'Default' },
            ],
          },
        },
        __internal__: { migrations: { version: '0.85.0' } },
      }),
      'utf-8'
    );

    new Conf({
      configName: 'config',
      cwd: dir,
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.87.0',
      migrations: CONFIG_MIGRATIONS,
    });

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      runtimes: { claudeCode: { defaultAccount: string; accounts: unknown[] } };
    };
    expect(onDisk.runtimes.claudeCode.accounts).toEqual([
      { id: 'acme', path: '/a', label: 'Acme' },
      { id: 'default-2', path: '/d', label: 'Default', renamedFrom: 'default' },
    ]);
    // The default account is a folder, not an id, so the choice is untouched.
    expect(onDisk.runtimes.claudeCode.defaultAccount).toBe('/d');
  });
});
