/**
 * The `'0.126.5'` key writes `runtimes.maxAgentChats: 8` into a stored
 * `runtimes` section that predates it (DOR-3413), across the real `conf`/Ajv
 * seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.126.5` body. The assertions read the FILE:
 * Ajv's `useDefaults` fills `8` into every read copy, so a manager read passes
 * with the body deleted (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.126.5';
});

import { ConfigManager, seedMaxAgentChats } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A data directory holding a config from the release before this key. */
function seed(runtimes: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'max-agent-chats-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      runtimes,
      __internal__: { migrations: { version: '0.126.4' } },
    })
  );
  return home;
}

/** The `runtimes` section as it sits on disk. */
function runtimesOnDisk(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).runtimes;
}

describe("the '0.126.5' chat-cap migration", () => {
  it('writes maxAgentChats: 8 beside the fields an older section kept', () => {
    const home = seed({ default: 'claude-code', defaultTrustStop: 'autonomy' });
    new ConfigManager(home);
    expect(runtimesOnDisk(home)).toMatchObject({
      default: 'claude-code',
      defaultTrustStop: 'autonomy',
      maxAgentChats: 8,
    });
  });

  it('keeps a number a person already chose', () => {
    const home = seed({ default: 'claude-code', maxAgentChats: 12 });
    new ConfigManager(home);
    expect(runtimesOnDisk(home).maxAgentChats).toBe(12);
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
    seedMaxAgentChats(store);
    seedMaxAgentChats(store);
    expect(writes).toEqual([{ default: 'claude-code', maxAgentChats: 8 }]);

    const empty = { get: () => undefined, set: vi.fn() };
    seedMaxAgentChats(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });
});
