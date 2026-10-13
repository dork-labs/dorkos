import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Conf from 'conf';
import { cacheStoreReads, storeReadStats } from '../cached-store-reads.js';

/**
 * `conf` read, parsed and validated the whole config file on every read
 * (DOR-2898). The wrapper answers from memory while the file is unchanged, and
 * must still see every change, in process or out, and hand out copies.
 */

type Shape = { auth: { enabled: boolean; users: string[] }; ui: { theme: string } };

let dir: string;
let store: Conf<Shape>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cached-conf-'));
  store = cacheStoreReads(
    new Conf<Shape>({
      cwd: dir,
      configName: 'config',
      defaults: { auth: { enabled: false, users: ['a'] }, ui: { theme: 'dark' } },
    })
  );
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cacheStoreReads', () => {
  it('reads the file once while it is unchanged', () => {
    store.get('auth');
    const before = { ...storeReadStats(store)! };
    for (let i = 0; i < 10; i++) store.get('auth');
    expect(storeReadStats(store)!.misses).toBe(before.misses);
    expect(storeReadStats(store)!.hits).toBe(before.hits + 10);
  });

  it('sees its own writes', () => {
    store.get('ui');
    store.set('ui', { theme: 'light' });
    expect(store.get('ui')).toEqual({ theme: 'light' });
    store.set('auth.enabled', true);
    expect(store.get('auth.enabled')).toBe(true);
  });

  it('sees another process replacing the file', () => {
    store.get('ui');
    const replacement = path.join(dir, 'replacement.json');
    fs.writeFileSync(replacement, JSON.stringify({ ...store.store, ui: { theme: 'sepia' } }));
    fs.renameSync(replacement, store.path);
    expect(store.get('ui')).toEqual({ theme: 'sepia' });
  });

  it('sees a replacement of the same size and time, by its inode', () => {
    // A whole-second time, so both files can carry exactly the same one.
    const second = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(store.path, second, second);
    store.get('ui');
    const before = fs.statSync(store.path);
    const text = fs.readFileSync(store.path, 'utf8').replace('"dark"', '"dusk"');
    const replacement = path.join(dir, 'replacement.json');
    fs.writeFileSync(replacement, text);
    fs.utimesSync(replacement, second, second);
    fs.renameSync(replacement, store.path);
    const after = fs.statSync(store.path);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);

    expect(store.get('ui')).toEqual({ theme: 'dusk' });
  });

  it('sees an edit made in place', () => {
    store.get('ui');
    const text = fs.readFileSync(store.path, 'utf8').replace('"dark"', '"solarized"');
    fs.writeFileSync(store.path, text);
    expect(store.get('ui')).toEqual({ theme: 'solarized' });
  });

  it('hands out copies, so a caller changing one cannot change the next read', () => {
    const auth = store.get('auth');
    auth.users.push('intruder');
    auth.enabled = true;
    const whole = store.store;
    whole.ui.theme = 'changed';

    expect(store.get('auth')).toEqual({ enabled: false, users: ['a'] });
    expect(store.store.ui.theme).toBe('dark');
  });

  it('answers has and a default as conf does', () => {
    expect(store.has('auth.enabled')).toBe(true);
    expect(store.has('nope' as never)).toBe(false);
    const fallback = { theme: 'x' };
    expect((store.get as (k: string, d: unknown) => unknown)('missing', fallback)).toBe(fallback);
  });

  it('sees an in-place edit that put the old size and modification time back', () => {
    // `cp -p` and `rsync -t` do this; the change time is the one they cannot set.
    const second = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(store.path, second, second);
    store.get('ui');
    const before = fs.statSync(store.path);
    const text = fs.readFileSync(store.path, 'utf8').replace('"dark"', '"dusk"');
    fs.writeFileSync(store.path, text);
    fs.utimesSync(store.path, second, second);
    const after = fs.statSync(store.path);
    expect([after.ino, after.size, after.mtimeMs]).toEqual([
      before.ino,
      before.size,
      before.mtimeMs,
    ]);

    expect(store.get('ui')).toEqual({ theme: 'dusk' });
  });

  it('keeps the top level free of Object.prototype, as conf does', () => {
    expect(store.has('toString' as never)).toBe(false);
    expect(store.get('toString' as never)).toBeUndefined();
    expect(Object.getPrototypeOf(store.store)).toBeNull();
    expect(Object.getPrototypeOf(store.get(undefined as never))).toBeNull();
  });

  it('drops the cached copy on delete, clear and reset', () => {
    store.get('ui');
    store.delete('ui');
    expect(store.get('ui')).toBeUndefined();
    store.set('ui', { theme: 'light' });
    store.reset('ui');
    expect(store.get('ui')).toEqual({ theme: 'dark' });
    store.clear();
    expect(store.get('auth')).toEqual({ enabled: false, users: ['a'] });
  });

  it('never lends the cached copy out after a read that threw', () => {
    store.get('ui');
    fs.writeFileSync(store.path, '{ not json');
    expect(() => store.get('ui')).toThrow();
    fs.writeFileSync(
      store.path,
      JSON.stringify({ auth: { enabled: false, users: ['a'] }, ui: { theme: 'dark' } })
    );
    const whole = store.store;
    whole.ui.theme = 'changed';
    expect(store.get('ui')).toEqual({ theme: 'dark' });
  });

  it('refuses a file that stopped matching the schema after it was cached', () => {
    const checked = cacheStoreReads(
      new Conf<{ port: number }>({
        cwd: dir,
        configName: 'schema',
        schema: { port: { type: 'number' } },
        defaults: { port: 4242 },
      })
    );
    expect(checked.get('port')).toBe(4242);
    fs.writeFileSync(checked.path, JSON.stringify({ port: 'not a number' }));
    expect(() => checked.get('port')).toThrow(/schema/i);
  });

  it('goes back to the file after the file is deleted', () => {
    store.get('ui');
    fs.rmSync(store.path);
    expect(store.get('ui')).toBeUndefined();
  });
});
