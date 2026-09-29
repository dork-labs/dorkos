/**
 * The `'0.91.0'` migration: `runtimes.claudeCode.dismissedFolders` is seeded
 * as an empty list (spec `claude-account-ui` §7.4), the account folders a
 * person hid from Settings' "Found on this computer" list.
 *
 * A nested leaf under a block every stored config already has, so conf's
 * shallow defaults-merge never adds it: the full-path case reads the FILE,
 * because a manager-level read would pass with the body deleted (DOR-1496).
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
  seedClaudeDismissedFolders,
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

describe('seedClaudeDismissedFolders', () => {
  it('seeds an empty list and keeps every other claudeCode member', () => {
    const store = memoryStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { defaultAccount: '/d', accounts: [{ id: 'a', path: '/a', label: null }] },
      },
    });

    seedClaudeDismissedFolders(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: {
        defaultAccount: '/d',
        accounts: [{ id: 'a', path: '/a', label: null }],
        dismissedFolders: [],
      },
    });
  });

  it('leaves a list that is already there alone', () => {
    const runtimes = { claudeCode: { accounts: [], dismissedFolders: ['/h/.claude-old'] } };
    const store = memoryStore({ runtimes });
    seedClaudeDismissedFolders(store);
    seedClaudeDismissedFolders(store);
    expect(store.data.runtimes).toEqual(runtimes);
  });

  it('skips a config with no runtimes or no claudeCode block', () => {
    const bare = memoryStore({ ui: { theme: 'dark' } });
    seedClaudeDismissedFolders(bare);
    expect(bare.data).toEqual({ ui: { theme: 'dark' } });

    const noClaude = memoryStore({ runtimes: { default: 'codex' } });
    seedClaudeDismissedFolders(noClaude);
    expect(noClaude.data).toEqual({ runtimes: { default: 'codex' } });
  });

  it('is what the 0.91.0 key runs', () => {
    const store = memoryStore({ runtimes: { claudeCode: { accounts: [] } } });
    CONFIG_MIGRATIONS['0.91.0'](store);
    expect(store.data.runtimes).toEqual({ claudeCode: { accounts: [], dismissedFolders: [] } });
  });
});

describe('a real pre-0.91.0 config file (full conf path)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gains the empty list on disk', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-dismissed-folders-mig-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        runtimes: {
          claudeCode: { defaultAccount: null, accounts: [{ id: 'a', path: '/a', label: null }] },
        },
        __internal__: { migrations: { version: '0.88.0' } },
      }),
      'utf-8'
    );

    new Conf({
      configName: 'config',
      cwd: dir,
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.91.0',
      migrations: CONFIG_MIGRATIONS,
    });

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(onDisk.runtimes.claudeCode.dismissedFolders).toEqual([]);
    expect(onDisk.runtimes.claudeCode.accounts).toEqual([{ id: 'a', path: '/a', label: null }]);
  });
});
