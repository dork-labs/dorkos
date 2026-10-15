/**
 * The `'0.116.0'` key writes `server.lanAccess: false` into a stored `server`
 * section that predates it (DOR-2930), across the real `conf`/Ajv seam.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev
 * tree's own version runs no `0.116.0` body. The assertions read the FILE:
 * Ajv's `useDefaults` fills `false` into every read copy, so a manager read
 * passes with the body deleted (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.116.0';
});

import { ConfigManager, seedLanAccess } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A data directory holding a config from the release before this key. */
function seed(server: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'lan-access-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({ version: 1, server, __internal__: { migrations: { version: '0.115.0' } } })
  );
  return home;
}

/** The `server` section as it sits on disk. */
function serverOnDisk(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).server;
}

describe("the '0.116.0' Wi-Fi access migration", () => {
  it('writes lanAccess: false beside the fields an older server section kept', () => {
    const home = seed({ port: 4300, cwd: '/work', boundary: null, open: false });
    new ConfigManager(home);
    expect(serverOnDisk(home)).toEqual({
      port: 4300,
      cwd: '/work',
      boundary: null,
      open: false,
      lanAccess: false,
    });
  });

  it('keeps a switch a person already turned on', () => {
    const home = seed({ port: 4242, cwd: null, boundary: null, open: true, lanAccess: true });
    new ConfigManager(home);
    expect(serverOnDisk(home).lanAccess).toBe(true);
  });

  it('changes nothing when run twice, and leaves a missing section alone', () => {
    const writes: unknown[] = [];
    const store = {
      value: { port: 4242 } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    seedLanAccess(store);
    seedLanAccess(store);
    expect(writes).toEqual([{ port: 4242, lanAccess: false }]);

    const empty = { get: () => undefined, set: vi.fn() };
    seedLanAccess(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });
});
