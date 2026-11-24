/**
 * The `'0.142.0'` key records that no Claude account is open to agents' own
 * picks yet (DOR-5033): it writes `agentsMayPick: false` on every registered
 * row that lacks the field, keeps a value already written, and changes nothing
 * else, across the real `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.142.0` body. The assertions read the FILE, not
 * a manager read (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.142.0';
});

import { ConfigManager, seedAgentsMayPickOff } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const WORK = { id: 'northwind', path: '/made-up/.claude-northwind', label: 'Work', color: null };
const SIDE = { id: 'side', path: '/made-up/.claude-side', label: null, color: '#12ab9f' };

/** A data directory holding a config from the release before this key. */
function seed(accounts: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'agents-may-pick-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      runtimes: { claudeCode: { accounts, persistentSession: true } },
      __internal__: { migrations: { version: '0.141.0' } },
    })
  );
  return home;
}

/** The account rows as they sit on disk. */
function accountsOnDisk(home: string): Array<Record<string, unknown>> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).runtimes.claudeCode.accounts;
}

describe("the '0.142.0' agents-may-pick migration", () => {
  it('writes the flag off on every row that lacks it, and nothing else', () => {
    const home = seed([WORK, { ...SIDE, noAutoMove: true }]);
    new ConfigManager(home);
    expect(accountsOnDisk(home)).toEqual([
      { ...WORK, agentsMayPick: false },
      { ...SIDE, noAutoMove: true, agentsMayPick: false },
    ]);
  });

  it('keeps a value already written', () => {
    const home = seed([{ ...WORK, agentsMayPick: true }, SIDE]);
    new ConfigManager(home);
    const [work, side] = accountsOnDisk(home);
    expect(work!.agentsMayPick).toBe(true);
    expect(side!.agentsMayPick).toBe(false);
  });

  it('changes nothing when run twice, and leaves a missing or empty registry alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { claudeCode: { accounts: [WORK, SIDE] } } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    seedAgentsMayPickOff(store);
    seedAgentsMayPickOff(store);
    expect(writes).toEqual([
      {
        claudeCode: {
          accounts: [
            { ...WORK, agentsMayPick: false },
            { ...SIDE, agentsMayPick: false },
          ],
        },
      },
    ]);

    for (const value of [undefined, { claudeCode: { accounts: [] } }, { claudeCode: {} }]) {
      const quiet = { get: () => value, set: vi.fn() };
      seedAgentsMayPickOff(quiet);
      expect(quiet.set).not.toHaveBeenCalled();
    }
  });
});
