/**
 * Backups of a replaced config file (DOR-1221).
 *
 * The defect: recovery wrote one fixed `config.json.bak`, so the next recovery
 * overwrote the settings the previous one had saved. Five recoveries were
 * logged on one machine and a single backup survived them — holding a config
 * that had already been replaced with defaults, which is the one thing a backup
 * must never be.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CONFIG_BACKUPS_KEPT, backupConfigFile, listConfigBackups } from '../backups.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp directory holding a config file with the given contents.
 *
 * @param contents - What to write into `config.json`.
 */
function seed(contents: string): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-backups-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, contents);
  return { dir, configPath };
}

describe('backupConfigFile', () => {
  it('writes a copy nobody can overwrite by recovering again', () => {
    const { configPath } = seed('first settings');

    const first = backupConfigFile(configPath, new Date(2026, 7, 15, 9, 30, 0, 0));
    fs.writeFileSync(configPath, 'second settings');
    const second = backupConfigFile(configPath, new Date(2026, 7, 15, 14, 2, 11, 5));

    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, 'utf-8')).toBe('first settings');
    expect(fs.readFileSync(second, 'utf-8')).toBe('second settings');
    // Sortable, and no colon — a colon in a filename is not portable to
    // Windows, where the checkout itself fails on one.
    expect(path.basename(first)).toBe('config-20260815-093000-000.json.bak');
    expect(path.basename(second)).toBe('config-20260815-140211-005.json.bak');
  });

  it('does not overwrite a backup written in the same millisecond', () => {
    // Two processes recovering the same file at once is exactly where "that
    // will never collide" stops being true, and the loser must not land on top
    // of somebody's settings.
    const { configPath } = seed('mine');
    const when = new Date(2026, 7, 15, 9, 30, 0, 0);

    const first = backupConfigFile(configPath, when);
    fs.writeFileSync(configPath, 'theirs');
    const second = backupConfigFile(configPath, when);

    expect(second).not.toBe(first);
    expect(fs.readFileSync(first, 'utf-8')).toBe('mine');
    expect(fs.readFileSync(second, 'utf-8')).toBe('theirs');
  });

  it('treats a collision copy as newer than the one it collided with', () => {
    // A plain string sort gets this backwards — `-` (0x2D) sorts below `.`
    // (0x2E), so `config-…-000-2.json.bak` comes before `config-…-000.json.bak`
    // and the NEWER copy would be the first pruned at the ten-backup boundary.
    const { dir, configPath } = seed('first');
    const when = new Date(2026, 7, 15, 9, 30, 0, 0);

    const first = backupConfigFile(configPath, when);
    fs.writeFileSync(configPath, 'second');
    const second = backupConfigFile(configPath, when);

    expect(listConfigBackups(dir)).toEqual([second, first]);
  });

  it('gives up on a name rather than searching for one forever', () => {
    // Unreachable in practice and deliberately bounded anyway: this runs at
    // boot, and a search that never ends would hang the boot it protects.
    const { dir, configPath } = seed('settings');
    const when = new Date(2026, 7, 15, 9, 30, 0, 0);
    // Every name this millisecond can take, already occupied.
    fs.writeFileSync(path.join(dir, 'config-20260815-093000-000.json.bak'), 'taken');
    for (let suffix = 2; suffix <= 100; suffix++) {
      fs.writeFileSync(path.join(dir, `config-20260815-093000-000-${suffix}.json.bak`), 'taken');
    }

    expect(() => backupConfigFile(configPath, when)).toThrow('Could not find a free backup name');
  });

  it('keeps the newest ten and prunes the rest', () => {
    const { dir, configPath } = seed('settings');

    for (let minute = 0; minute < CONFIG_BACKUPS_KEPT + 4; minute++) {
      fs.writeFileSync(configPath, `settings ${minute}`);
      backupConfigFile(configPath, new Date(2026, 7, 15, 9, minute, 0, 0));
    }

    const kept = listConfigBackups(dir);
    expect(kept).toHaveLength(CONFIG_BACKUPS_KEPT);
    // Newest first, and the newest really is the last one written.
    expect(fs.readFileSync(kept[0]!, 'utf-8')).toBe(`settings ${CONFIG_BACKUPS_KEPT + 3}`);
    expect(fs.readFileSync(kept.at(-1)!, 'utf-8')).toBe('settings 4');
  });

  it('never prunes the single backup the older releases wrote', () => {
    // Somebody upgrading may have their only surviving settings in
    // `config.json.bak`. It is not ours to tidy away.
    const { dir, configPath } = seed('settings');
    const legacy = path.join(dir, 'config.json.bak');
    fs.writeFileSync(legacy, 'the settings from before all this');

    for (let minute = 0; minute < CONFIG_BACKUPS_KEPT + 4; minute++) {
      backupConfigFile(configPath, new Date(2026, 7, 15, 9, minute, 0, 0));
    }

    expect(fs.readFileSync(legacy, 'utf-8')).toBe('the settings from before all this');
    expect(listConfigBackups(dir)).not.toContain(legacy);
  });

  it('reports a copy it could not make instead of swallowing it', () => {
    // The caller treats a refused copy as a reason to STOP rather than replace
    // the file anyway, so this failure must not be quietly absorbed.
    const { dir } = seed('settings');

    expect(() => backupConfigFile(path.join(dir, 'not-here.json'))).toThrow();
  });
});

describe('listConfigBackups', () => {
  it('answers for a directory that does not exist', () => {
    expect(listConfigBackups(path.join(os.tmpdir(), 'dorkos-no-such-dir-1221'))).toEqual([]);
  });
});
