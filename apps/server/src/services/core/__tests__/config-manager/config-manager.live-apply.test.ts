import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Conf, { type Schema } from 'conf';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { ConfigManager, initConfigManager, CONF_JSON_SCHEMA } from '../../config-manager.js';
import { applyConfigPatch } from '../../operator/config-patch.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ConfigManager.onChange (the live-apply primitive)', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), 'test-dork-onchange-' + Date.now() + Math.random());
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the section a whole-section write touched', () => {
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.set('runtimes', { ...manager.get('runtimes'), default: 'codex' });

    expect(seen).toEqual([['runtimes']]);
  });

  it('reports the SECTION a dot-path write touched, not the path', () => {
    // Subscribers ask "did my settings change?", and `runtimes.default` and
    // `runtimes` are the same news.
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.setDot('runtimes.default', 'codex');

    expect(seen).toEqual([['runtimes']]);
  });

  it('reports the exact path each write stored, beside its section', () => {
    // The settings broadcast tells remembered Community navigation apart from
    // the rest of `ui` by this, so a dot-path write must name its whole path
    // and a whole-section write must name only the section.
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.paths]));

    manager.setDot('runtimes.default', 'codex');
    manager.set('ui', { ...manager.get('ui'), theme: 'dark' });

    expect(seen).toEqual([['runtimes.default'], ['ui']]);
  });

  it('reports every section on a whole-config reset', () => {
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.reset();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('runtimes');
    expect(seen[0]).toContain('ui');
  });

  it('stops calling a listener that unsubscribed', () => {
    const manager = new ConfigManager(dir);
    const listener = vi.fn();
    manager.onChange(listener)();

    manager.setDot('runtimes.default', 'codex');

    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a throwing listener neither break the write nor silence the next one', () => {
    // The write has already landed by the time listeners run; a subscriber that
    // throws must not turn somebody's settings change into an error.
    const manager = new ConfigManager(dir);
    const second = vi.fn();
    manager.onChange(() => {
      throw new Error('listener blew up');
    });
    manager.onChange(second);

    expect(() => manager.setDot('runtimes.default', 'codex')).not.toThrow();
    expect(manager.getDot('runtimes.default')).toBe('codex');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fires for a write made through PATCH /api/config', () => {
    // The path that matters: the Settings screen and the `config_patch` operator
    // tool both reach the store through `applyConfigPatch`, and a person who
    // changes the default runtime there expects it to hold without a restart.
    const manager = initConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    const result = applyConfigPatch({ runtimes: { default: 'codex' } });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([['runtimes']]);
  });
});

describe('config.json holds the EFFECTIVE config, not what was set (DOR-1267)', () => {
  // What these pin, and why they are worth pinning.
  //
  // Deleting `rooms.collectDebounceMs` and `rooms.collectMaxEntries` by hand and
  // watching them come back at 500/20 looks like DorkOS re-persisting defaults
  // behind somebody's back. It is not a DorkOS write path at all: `conf` compiles
  // Ajv with `useDefaults: true` (`conf@15`, `#setupValidator`), and Ajv MUTATES
  // the object it validates, inserting the `default` of every absent property.
  // `Conf.set` then reads the store through that validating getter, sets one key,
  // and assigns the whole thing back — so a write of ANY leaf persists the fill
  // for every other one.
  //
  // The fill is load-bearing rather than incidental, which is the part a reader
  // has to know before touching it: `z.toJSONSchema(UserConfigSchema)` marks every
  // defaulted leaf `required`, and the fill is what satisfies that. The last test
  // is the proof — turning `useDefaults` off does not stop the materialising, it
  // condemns a config file that is missing one leaf and replaces it with defaults.
  //
  // So absence is not a state this design maintains, and making it one means
  // moving default-filling out of Ajv and into a DorkOS read boundary. That is a
  // decision about the config substrate, not a fix, and these tests describe what
  // is true today so that changing it has to be deliberate.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A materialised config file with two `rooms` leaves deleted by hand — what the
   * 2026-08-15 rooms self-test left behind.
   */
  function seedWithoutCollectLeaves(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-effective-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      rooms: Record<string, unknown>;
    };
    delete stored.rooms.collectDebounceMs;
    delete stored.rooms.collectMaxEntries;
    fs.writeFileSync(configPath, JSON.stringify(stored, undefined, '\t'));
    return { dir, configPath };
  }

  function roomsOnDisk(configPath: string): Record<string, unknown> {
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      rooms: Record<string, unknown>;
    };
    return stored.rooms;
  }

  it('leaves a deleted leaf deleted across a boot', () => {
    // Opening the store is NOT what put them back. `#runMigrations` merges only
    // the TOP-LEVEL `defaults`, and `rooms` is already there, so its
    // `assert.deepEqual` matches and the `_write` beneath it is skipped. No
    // migration runs at this version either, so nothing rewrites the file.
    const { dir, configPath } = seedWithoutCollectLeaves();
    new ConfigManager(dir);
    expect(roomsOnDisk(configPath)).not.toHaveProperty('collectDebounceMs');
    expect(roomsOnDisk(configPath)).not.toHaveProperty('collectMaxEntries');
  });

  it('still reads the deleted leaves back at their defaults', () => {
    const { dir } = seedWithoutCollectLeaves();
    const rooms = new ConfigManager(dir).get('rooms');
    expect(rooms.collectDebounceMs).toBe(500);
    expect(rooms.collectMaxEntries).toBe(20);
  });

  it('puts them back on disk when an unrelated leaf is written', () => {
    const { dir, configPath } = seedWithoutCollectLeaves();
    const manager = new ConfigManager(dir);

    manager.setDot('ui.theme', 'light');

    expect(roomsOnDisk(configPath).collectDebounceMs).toBe(500);
    expect(roomsOnDisk(configPath).collectMaxEntries).toBe(20);
  });

  it('does the same through PATCH /api/config', () => {
    const { dir, configPath } = seedWithoutCollectLeaves();
    initConfigManager(dir);

    const result = applyConfigPatch({ ui: { theme: 'light' } });

    expect(result.ok).toBe(true);
    expect(roomsOnDisk(configPath).collectDebounceMs).toBe(500);
    expect(roomsOnDisk(configPath).collectMaxEntries).toBe(20);
  });

  it('cannot simply stop filling — the generated schema requires every leaf', () => {
    // The one-line "fix" (`ajvOptions: { useDefaults: false }`), against the same
    // file the tests above use. It does not leave the leaves absent; it makes the
    // file fail validation, which `classifyConfigLoadFailure` reads as corruption
    // — backup, delete, start again from defaults. Measured, not reasoned.
    //
    // Structurally analogous to the production construction rather than a copy of
    // it: the shipped schema and cast, but no `migrations`/`projectVersion`, so
    // `#initializeStore` takes its non-migration branch and the throw comes from
    // the store getter rather than from the `_validate` that follows the
    // migration chain. Same validator, same verdict, one call site over.
    const { dir } = seedWithoutCollectLeaves();
    expect(
      () =>
        new Conf({
          configName: 'config',
          cwd: dir,
          // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
          schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
          ajvOptions: { useDefaults: false },
          defaults: USER_CONFIG_DEFAULTS,
          clearInvalidConfig: false,
        })
    ).toThrow(/Config schema violation.*required property 'collectDebounceMs'/);
  });
});
