/**
 * The `'0.90.0'` migration: `runtimes.claudeCode.defaultAccountColor` is seeded
 * `null` (the default for its position) on a config written before the
 * standalone default Claude account could be given a color (DOR-2492).
 *
 * A nested leaf under a block every stored config already has, so conf's
 * defaults merge never writes it and the body is the only thing that does. The
 * full-path case reads the FILE, not the manager: conf's store getter
 * re-validates every access, so a value it filled into the copy it hands back
 * would make a manager-level assertion pass with the body deleted (DOR-1496).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { CONF_JSON_SCHEMA, CONFIG_MIGRATIONS, seedDefaultAccountColor } from '../config-manager.js';

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

const ROWS = [{ id: 'acme', path: '/a', label: 'Acme', color: '#12ab9f', seat: 1 }];

describe('seedDefaultAccountColor', () => {
  it('seeds null and keeps every other runtimes.claudeCode member', () => {
    const store = memoryStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { defaultAccount: '/d', accounts: ROWS, persistentSession: false },
      },
    });

    seedDefaultAccountColor(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: {
        defaultAccount: '/d',
        accounts: ROWS,
        persistentSession: false,
        defaultAccountColor: null,
      },
    });
  });

  it('never overwrites a color already there, and is a no-op on a second run', () => {
    const store = memoryStore({
      runtimes: { claudeCode: { defaultAccount: null, defaultAccountColor: '#0d9488' } },
    });
    const before = structuredClone(store.data);
    seedDefaultAccountColor(store);
    seedDefaultAccountColor(store);
    expect(store.data).toEqual(before);
  });

  it('leaves a config with no runtimes.claudeCode block alone', () => {
    for (const data of [{ ui: { theme: 'dark' } }, { runtimes: { codex: {} } }]) {
      const store = memoryStore(data);
      seedDefaultAccountColor(store);
      expect(store.data).toEqual(data);
    }
  });

  it('is what the 0.90.0 key runs', () => {
    const store = memoryStore({ runtimes: { claudeCode: { accounts: [] } } });
    CONFIG_MIGRATIONS['0.90.0'](store);
    expect(store.data.runtimes).toEqual({
      claudeCode: { accounts: [], defaultAccountColor: null },
    });
  });
});

describe('a real config file (full conf path)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function openAt(stored: Record<string, unknown>, from: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-default-account-color-mig-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, ...stored, __internal__: { migrations: { version: from } } }),
      'utf-8'
    );
    new Conf({
      configName: 'config',
      cwd: dir,
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.90.0',
      migrations: CONFIG_MIGRATIONS,
    });
    return cfgPath;
  }

  it('writes the leaf to disk on an upgrade from before 0.90.0', () => {
    const cfgPath = openAt(
      { runtimes: { claudeCode: { defaultAccount: null, accounts: ROWS } } },
      '0.88.0'
    );
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(onDisk.runtimes.claudeCode).toHaveProperty('defaultAccountColor', null);
    expect(onDisk.runtimes.claudeCode.accounts).toEqual(ROWS);
  });

  it('keeps a hand-edited bad color loadable instead of condemning the file', () => {
    // Read as "no choice" (the positional default), like a row's bad `color`:
    // Ajv refusing it would throw here and send the whole file to recovery.
    const cfgPath = openAt(
      { runtimes: { claudeCode: { defaultAccount: null, defaultAccountColor: 'teal' } } },
      '0.90.0'
    );
    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(onDisk.runtimes.claudeCode.defaultAccountColor).toBe('teal');
  });
});
