/**
 * The `'0.122.0'` key writes `runtimes.claudeCode.maxWarmProcesses: null` into a
 * stored `runtimes.claudeCode` section that predates it (DOR-3012), across the
 * real `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.122.0` body. The assertions read the FILE:
 * Ajv's `useDefaults` fills `null` into every read copy, so a manager read
 * passes with the body deleted (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.122.0';
});

import { ConfigManager, seedMaxWarmProcesses } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A data directory holding a config from the release before this key. */
function seed(claudeCode: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'max-warm-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      runtimes: { claudeCode },
      __internal__: { migrations: { version: '0.121.0' } },
    })
  );
  return home;
}

/** The `runtimes.claudeCode` section as it sits on disk. */
function claudeCodeOnDisk(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).runtimes.claudeCode;
}

describe("the '0.122.0' warm-ceiling migration", () => {
  it('writes maxWarmProcesses: null beside the fields an older section kept', () => {
    const home = seed({ accounts: [], persistentSession: true });
    new ConfigManager(home);
    expect(claudeCodeOnDisk(home)).toMatchObject({
      accounts: [],
      persistentSession: true,
      maxWarmProcesses: null,
    });
  });

  it('keeps a number a person already chose', () => {
    const home = seed({ accounts: [], persistentSession: true, maxWarmProcesses: 6 });
    new ConfigManager(home);
    expect(claudeCodeOnDisk(home).maxWarmProcesses).toBe(6);
  });

  it('changes nothing when run twice, and leaves a missing section alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { accounts: [] } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    seedMaxWarmProcesses(store);
    seedMaxWarmProcesses(store);
    expect(writes).toEqual([{ accounts: [], maxWarmProcesses: null }]);

    const empty = { get: () => undefined, set: vi.fn() };
    seedMaxWarmProcesses(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });
});
