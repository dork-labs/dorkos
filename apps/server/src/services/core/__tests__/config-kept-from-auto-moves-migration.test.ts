/**
 * The `'0.124.1'` key keeps one registered Claude account out of automatic
 * moves (Re-seat P0): it sets `noAutoMove: true` on that row only, leaves
 * every other row alone, and never overwrites a choice already written,
 * across the real `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.124.1` body. The assertions read the FILE, not
 * a manager read (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.124.1';
});

import { ConfigManager, keepAccountOutOfAutoMoves } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const AB1 = { id: 'claude-ab1', path: '/Users/me/.claude-ab1', label: 'AB1', color: null };
const OTHER = { id: 'claude2', path: '/Users/me/.claude2', label: null, color: '#12ab9f' };

/** A data directory holding a config from the release before this key. */
function seed(accounts: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'kept-out-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      runtimes: { claudeCode: { accounts, persistentSession: true } },
      __internal__: { migrations: { version: '0.124.0' } },
    })
  );
  return home;
}

/** The account rows as they sit on disk. */
function accountsOnDisk(home: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).runtimes.claudeCode.accounts;
}

describe("the '0.124.1' keep-out-of-automatic-moves migration", () => {
  it('sets the flag on that one account, and leaves every other row as stored', () => {
    const home = seed([OTHER, AB1]);
    new ConfigManager(home);
    const [other, ab1] = accountsOnDisk(home);
    expect(ab1).toEqual({ ...AB1, noAutoMove: true });
    expect(other).toEqual(OTHER);
    expect(other).not.toHaveProperty('noAutoMove');
  });

  it('keeps a value already written, even false', () => {
    const home = seed([{ ...AB1, noAutoMove: false }]);
    new ConfigManager(home);
    expect(accountsOnDisk(home)[0]!.noAutoMove).toBe(false);
  });

  it('leaves a registry without that account alone', () => {
    const home = seed([OTHER]);
    new ConfigManager(home);
    expect(accountsOnDisk(home)).toEqual([OTHER]);
  });

  it('changes nothing when run twice, and leaves a missing section alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { claudeCode: { accounts: [OTHER, AB1] } } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    keepAccountOutOfAutoMoves(store);
    keepAccountOutOfAutoMoves(store);
    expect(writes).toEqual([{ claudeCode: { accounts: [OTHER, { ...AB1, noAutoMove: true }] } }]);

    const empty = { get: () => undefined, set: vi.fn() };
    keepAccountOutOfAutoMoves(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });

  it('touches only the first row with that id, the one every reader lists', () => {
    const store = {
      value: { claudeCode: { accounts: [AB1, { ...AB1, path: '/elsewhere' }] } } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        store.value = value;
      },
    };
    keepAccountOutOfAutoMoves(store);
    const rows = (store.value as { claudeCode: { accounts: Array<Record<string, unknown>> } })
      .claudeCode.accounts;
    expect(rows[0]).toHaveProperty('noAutoMove', true);
    expect(rows[1]).not.toHaveProperty('noAutoMove');
  });
});
