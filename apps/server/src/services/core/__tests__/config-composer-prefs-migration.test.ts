/** Composer preferences survive supported upgrades in the file, not just Ajv copies. */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';

/** The oldest supported config, after its composer migration already ran. */
const STORED_VERSION = '0.115.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temporary directory holding a config at the supported upgrade floor.
 *
 * @param ui - The `ui` block to store, as a machine that upgraded would carry it.
 */
function seedUpgradeBoot(ui: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-composer-prefs-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ui,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/**
 * The `ui` block the boot actually left in `config.json`.
 *
 * Read straight off the file rather than through the manager, because the
 * manager cannot tell the difference between a value a migration wrote and one
 * Ajv invented on the way out.
 *
 * @param dir - The data directory holding `config.json`.
 */
function storedUi(dir: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
    ui: Record<string, unknown>;
  };
  return raw.ui;
}

describe('ui.composer across a supported upgrade (real conf + Ajv)', () => {
  it('never turns on a preference someone already turned off', () => {
    // The direction that matters now the seed is `true`: somebody who used the
    // Settings switch to go back to the plain box keeps it across the upgrade —
    // in the file, which is where they will still have it next launch.
    const dir = seedUpgradeBoot({
      theme: 'dark',
      statusBar: { pins: ['git'] },
      composer: { richText: false },
    });

    const manager = new ConfigManager(dir);
    expect(manager.validate()).toEqual({ valid: true });
    expect(manager.getDot('ui.composer.richText')).toBe(false);
    new ConfigManager(dir);
    expect(storedUi(dir).theme).toBe('dark');
    expect(storedUi(dir).statusBar).toEqual({ pins: ['git'] });
    expect(fs.readdirSync(dir)).toEqual(['config.json']);

    expect(storedUi(dir).composer).toEqual({ richText: false });
  });

  it('a fresh install gets the section from the schema, with rich text on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-composer-prefs-fresh-'));
    dirs.push(dir);

    const manager = new ConfigManager(dir);

    expect(manager.get('ui').composer).toEqual({ richText: true });
    expect(manager.validate()).toEqual({ valid: true });
  });
});
