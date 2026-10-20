/**
 * The accounts kept out of automatic moves (Re-seat P0, Security's review):
 * the `'0.124.1'` migration flips one account's flag, the first boot after
 * records exactly one permission-history line for it, a later boot records
 * nothing, and the line's Undo lets agents move there on their own again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PermissionChangedMetadata } from '@dorkos/shared/permissions';

import { keepAccountOutOfAutoMoves } from '../../config-migrations/v0-90-onward.js';
import {
  KEPT_FROM_AUTO_MOVES_NOTE,
  configAutoMoveFlagPort,
  recordKeptFromAutoMoves,
  setAutoMoveFlagPort,
  type KeptFromAutoMovesDeps,
} from '../kept-from-auto-moves.js';
import { personWriter } from '../permission-history.js';
import { createPermissionWorld } from './permission-fixtures.js';

const AB1 = { id: 'claude-ab1', path: '/Users/me/.claude-ab1', label: 'AB1', color: null };
const OTHER = { id: 'claude2', path: '/Users/me/.claude2', label: null, color: null };
const LOCAL = personWriter('local-trust');

const dirs: string[] = [];
afterEach(() => {
  setAutoMoveFlagPort(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A config holding the given account rows, read and written like `configManager`. */
function configWith(accounts: unknown[]) {
  // Copies, so no test's write reaches the shared row constants another test reads.
  const store = {
    runtimes: {
      claudeCode: { accounts: accounts.map((row) => ({ ...(row as object) })) },
    } as unknown,
    get: (_key: string) => store.runtimes,
    set: (_key: string, value: unknown) => {
      store.runtimes = value;
    },
  };
  return store;
}

/** The stored rows. */
function rows(store: { runtimes: unknown }): Array<Record<string, unknown>> {
  return (store.runtimes as { claudeCode: { accounts: Array<Record<string, unknown>> } }).claudeCode
    .accounts;
}

/** A boot after the migration: the port wired, the record's dependencies. */
function boot(store: ReturnType<typeof configWith>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-out-'));
  dirs.push(dir);
  const world = createPermissionWorld();
  const port = configAutoMoveFlagPort(store);
  setAutoMoveFlagPort(port);
  const deps: KeptFromAutoMovesDeps = {
    doneFile: path.join(dir, 'permissions', 'kept-from-auto-moves.json'),
    port,
    activity: world.activity,
    priorRecord: async () =>
      world.events.some(
        (e) => (e.metadata as { note?: unknown } | null)?.note === KEPT_FROM_AUTO_MOVES_NOTE
      ),
    logger: { info: vi.fn(), error: vi.fn() },
  };
  return { world, deps };
}

describe('the migration and its one history line', () => {
  it('keeps only that account out, and writes one line naming it', async () => {
    const store = configWith([OTHER, AB1]);
    keepAccountOutOfAutoMoves(store);
    expect(rows(store)[0]).not.toHaveProperty('noAutoMove');
    expect(rows(store)[1]).toMatchObject({ id: 'claude-ab1', noAutoMove: true });

    const { world, deps } = boot(store);
    expect(await recordKeptFromAutoMoves(deps)).toBe(1);

    expect(world.events).toHaveLength(1);
    const event = world.events[0]!;
    expect(event.actorLabel).toBe('Upgrade');
    expect(event.summary).toBe('AB1: Not used for automatic moves');
    const metadata = event.metadata as unknown as PermissionChangedMetadata;
    expect(metadata).toMatchObject({
      surface: 'upgrade',
      attribution: 'upgrade',
      note: KEPT_FROM_AUTO_MOVES_NOTE,
    });
    expect(metadata.changes).toEqual([
      {
        target: { kind: 'default' },
        key: { kind: 'account', accountId: 'claude-ab1', accountName: 'AB1' },
        before: null,
        after: 'on',
      },
    ]);
  });

  it('writes nothing on a later boot, done file or not', async () => {
    const store = configWith([AB1]);
    keepAccountOutOfAutoMoves(store);
    keepAccountOutOfAutoMoves(store);
    const { world, deps } = boot(store);
    await recordKeptFromAutoMoves(deps);

    expect(await recordKeptFromAutoMoves(deps)).toBeNull();
    fs.rmSync(deps.doneFile);
    expect(await recordKeptFromAutoMoves(deps)).toBeNull();
    expect(world.events).toHaveLength(1);
  });

  it('on an install without that account, writes no line and never records a flag set later', async () => {
    const store = configWith([OTHER]);
    keepAccountOutOfAutoMoves(store);
    const { world, deps } = boot(store);
    expect(await recordKeptFromAutoMoves(deps)).toBe(0);
    expect(fs.existsSync(deps.doneFile)).toBe(true);

    rows(store)[0]!.noAutoMove = true;
    expect(await recordKeptFromAutoMoves(deps)).toBeNull();
    expect(world.events).toHaveLength(0);
  });
});

describe('Undo of the line', () => {
  it('lets agents move there again, and its own Undo keeps the account out again', async () => {
    const store = configWith([OTHER, AB1]);
    keepAccountOutOfAutoMoves(store);
    const { world, deps } = boot(store);
    await recordKeptFromAutoMoves(deps);

    const undone = await world.service.undo(world.events[0]!.id, {}, LOCAL);
    expect(rows(store)[1]).toMatchObject({ id: 'claude-ab1', noAutoMove: false });
    expect(rows(store)[0]).not.toHaveProperty('noAutoMove');
    expect(undone.skipped).toEqual([]);
    expect(undone.changes).toEqual([expect.objectContaining({ before: 'on', after: null })]);
    expect(world.events[1]!.summary).toBe('Undo: AB1: Used for automatic moves');
    expect((world.events[1]!.metadata as unknown as PermissionChangedMetadata).undoOf).toBe(
      world.events[0]!.id
    );

    await world.service.undo(world.events[1]!.id, {}, LOCAL);
    expect(rows(store)[1]).toMatchObject({ noAutoMove: true });
  });

  it('reports an account that is no longer registered, and changes nothing', async () => {
    const store = configWith([AB1]);
    keepAccountOutOfAutoMoves(store);
    const { world, deps } = boot(store);
    await recordKeptFromAutoMoves(deps);
    store.runtimes = { claudeCode: { accounts: [OTHER] } };

    const result = await world.service.undo(world.events[0]!.id, {}, LOCAL);
    expect(result.changes).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'gone' })]);
    expect(rows(store)).toEqual([OTHER]);
  });
});
