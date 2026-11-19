/**
 * The `'0.137.0'` key writes `runtimes.loadGate` into a stored `runtimes`
 * section that predates it (DOR-4209), across the real `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.137.0` body. The assertions read the FILE:
 * Ajv's `useDefaults` fills the section into every read copy, so a manager read
 * passes with the body deleted (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.137.0';
});

import { ConfigManager, seedLoadGate } from '../config-manager.js';

const SHIPPED = {
  enabled: true,
  maxLoad: 16,
  slots: 1,
  maxWaitMinutes: 60,
  hardCapMinutes: 240,
  heavyCommands: { add: [], remove: [] },
};

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A fresh data directory, holding a config from the release before this key when given one. */
function seed(runtimes?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'load-gate-config-'));
  homes.push(home);
  if (runtimes !== undefined) {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        version: 1,
        runtimes,
        __internal__: { migrations: { version: '0.136.0' } },
      })
    );
  }
  return home;
}

/** The `runtimes` section as it sits on disk. */
function runtimesOnDisk(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).runtimes;
}

describe("the '0.137.0' load-gate migration", () => {
  it('writes the shipped load gate beside the fields an older section kept', () => {
    const home = seed({ default: 'claude-code', maxAgentChats: 8 });
    new ConfigManager(home);
    expect(runtimesOnDisk(home)).toMatchObject({
      default: 'claude-code',
      maxAgentChats: 8,
      loadGate: SHIPPED,
    });
  });

  it('keeps settings a person already chose', () => {
    const chosen = { ...SHIPPED, maxLoad: 8, slots: 2 };
    const home = seed({ default: 'claude-code', loadGate: chosen });
    new ConfigManager(home);
    expect(runtimesOnDisk(home).loadGate).toEqual(chosen);
  });

  it('lands the shipped settings on a fresh install, written by conf rather than the body', () => {
    // No file at all: conf writes its whole `defaults` before the first key, so
    // the section is on disk whether or not this body runs. Asserted to pin the
    // default itself, not to credit the migration.
    const home = seed();
    new ConfigManager(home);
    expect(runtimesOnDisk(home).loadGate).toEqual(SHIPPED);
  });

  it('changes nothing when run twice, and leaves a missing section alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { default: 'claude-code' } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    seedLoadGate(store);
    seedLoadGate(store);
    expect(writes).toEqual([{ default: 'claude-code', loadGate: SHIPPED }]);

    const empty = { get: () => undefined, set: vi.fn() };
    seedLoadGate(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });
});
