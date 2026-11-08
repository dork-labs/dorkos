/**
 * The `'0.133.0'` key moves every everyone-level per-action setting stored under
 * `commitments.add|update|list` to `todo_promises.add|update|list` (DOR-3933), across the real
 * `conf`/Ajv seam, so a Blocked promise tool stays Blocked after the rename.
 *
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads, because a dev tree's own
 * version runs no `0.133.0` body. The assertions read the FILE (DOR-1496).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.133.0';
});

import { ConfigManager, renameTodoPromiseActions } from '../config-manager.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A data directory holding a config from the release before this key. */
function seed(actions: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), 'todo-promise-actions-config-'));
  homes.push(home);
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      permissions: { preset: 'careful', defaults: { areas: { rooms: 'ask' }, actions } },
      __internal__: { migrations: { version: '0.132.0' } },
    })
  );
  return home;
}

/** The `permissions` section as it sits on disk. */
function permissionsOnDisk(home: string): {
  preset: string;
  defaults: { areas: Record<string, string>; actions: Record<string, string> };
} {
  return JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).permissions;
}

describe("the '0.133.0' promise-tool rename migration", () => {
  it('moves each old id to its new one, state unchanged, and keeps everything else', () => {
    const home = seed({
      'commitments.add': 'blocked',
      'commitments.update': 'ask',
      'commitments.list': 'allowed',
      'memory.write': 'blocked',
    });
    new ConfigManager(home);
    const permissions = permissionsOnDisk(home);
    expect(permissions.preset).toBe('careful');
    expect(permissions.defaults.areas).toEqual({ rooms: 'ask' });
    expect(permissions.defaults.actions).toEqual({
      'memory.write': 'blocked',
      'todo_promises.add': 'blocked',
      'todo_promises.update': 'ask',
      'todo_promises.list': 'allowed',
    });
  });

  it('keeps a setting already stored under the new id', () => {
    const home = seed({ 'commitments.add': 'allowed', 'todo_promises.add': 'blocked' });
    new ConfigManager(home);
    expect(permissionsOnDisk(home).defaults.actions).toEqual({ 'todo_promises.add': 'blocked' });
  });

  it('changes nothing when run twice, or when nothing names an old id', () => {
    const writes: unknown[] = [];
    const store = {
      value: {
        preset: 'trusted',
        defaults: { areas: {}, actions: { 'commitments.add': 'blocked' } },
      } as unknown,
      get: () => store.value,
      set: (_key: string, value: unknown) => {
        writes.push(value);
        store.value = value;
      },
    };
    renameTodoPromiseActions(store);
    renameTodoPromiseActions(store);
    expect(writes).toEqual([
      { preset: 'trusted', defaults: { areas: {}, actions: { 'todo_promises.add': 'blocked' } } },
    ]);

    const empty = { get: () => undefined, set: vi.fn() };
    renameTodoPromiseActions(empty);
    expect(empty.set).not.toHaveBeenCalled();
  });
});
