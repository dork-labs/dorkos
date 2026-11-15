/**
 * The `ui.composer` backfill (DOR-948) across the real `conf`/Ajv seam.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.59.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported,
 * which means before this file's imports, which means a separate module
 * registry — the same reasoning `config-load-failure-migration.test.ts` gives.
 * A test that skipped this would pass while exercising nothing.
 *
 * ## Why a real manager rather than a mock store
 *
 * `.claude/rules/safe-defaults.md`: mock stores never cross the `conf`/Ajv seam,
 * and `UserConfigSchema.parse` cannot substitute — Zod strips unknown keys where
 * Ajv rejects them. Only a real file, read by a real `ConfigManager`, answers
 * whether an upgraded config still validates once the section lands in it.
 *
 * ## Why these read `config.json` instead of calling `getDot`
 *
 * They used to call `getDot`, on a docblock that said so proudly: emptying
 * `CONFIG_MIGRATIONS['0.59.0']` left them green, and that was written up as
 * proof that `backfillComposerPrefs` is a no-op anchor Ajv's `useDefaults` makes
 * redundant. The measurement was real; the conclusion was backwards (DOR-1496).
 *
 * conf's `store` GETTER re-reads and re-parses `config.json` on every access and
 * validates the copy it is about to hand back, so `useDefaults` decorates that
 * copy and the copy is then discarded. Nothing it filled is written down. And
 * the one merge conf DOES write — the shallow `Object.assign` of `defaults`
 * under the file, which runs before the first migration key — cannot help here,
 * because an upgrading config already has a `ui` object and a stored object wins
 * that merge whole. So `ui.composer` reaches the file if and only if this body
 * runs, and a `getDot` assertion was reading conf's fill rather than the
 * migration's work.
 *
 * Hence: every claim about what the upgrade LEFT BEHIND is made against the
 * file. Suppressing the body now turns this file red, which is the property the
 * old version lacked. `getDot` still appears where the claim really is about
 * what a running DorkOS sees.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.59.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from before the composer preference existed. */
const STORED_VERSION = '0.57.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a valid config one upgrade behind this key.
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
 * Ajv invented on the way out. See the note at the top of this file.
 *
 * @param dir - The data directory holding `config.json`.
 */
function storedUi(dir: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
    ui: Record<string, unknown>;
  };
  return raw.ui;
}

describe('ui.composer on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.59.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.59.0');
  });

  it('writes ui.composer, rich text on, INTO THE FILE of a config that predates it', () => {
    const dir = seedUpgradeBoot({ theme: 'dark', statusBar: { pins: ['git'] } });

    const manager = new ConfigManager(dir);

    expect(storedUi(dir).composer).toEqual({ richText: true });
    // The rest of `ui` is untouched — the backfill spreads the stored block.
    expect(storedUi(dir).theme).toBe('dark');
    expect(storedUi(dir).statusBar).toEqual({ pins: ['git'] });
    // …and that is what a running DorkOS reads back.
    expect(manager.getDot('ui.composer.richText')).toBe(true);
  });

  it('leaves the file valid, so the upgrade boot is not condemned', () => {
    const dir = seedUpgradeBoot({ theme: 'system' });

    const manager = new ConfigManager(dir);

    expect(manager.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
    // A second boot reads the migrated file cleanly rather than looping, and
    // leaves the section where the first one put it.
    new ConfigManager(dir);
    expect(storedUi(dir).composer).toEqual({ richText: true });
  });

  it('never turns on a preference someone already turned off', () => {
    // The direction that matters now the seed is `true`: somebody who used the
    // Settings switch to go back to the plain box keeps it across the upgrade —
    // in the file, which is where they will still have it next launch.
    const dir = seedUpgradeBoot({ theme: 'system', composer: { richText: false } });

    new ConfigManager(dir);

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
