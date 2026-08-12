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
 * ## What these assert, and what they deliberately do not
 *
 * They assert the OUTCOME of an upgrade boot: the section is there, it is on
 * (the owner's 2026-08-12 call), and the file is not condemned. They are not a
 * test of the migration body, and
 * emptying `CONFIG_MIGRATIONS['0.59.0']` leaves them green — measured, not
 * assumed. conf builds Ajv with `useDefaults`, so a declared default is written
 * into a stored `ui` block during validation whether or not a migration runs,
 * which is what makes `backfillComposerPrefs` a no-op anchor rather than the
 * mechanism. The body itself is pinned by `config-manager.test.ts`'s mock-store
 * suite, where breaking it does go red. Both bars are needed: one says the
 * intent is written down, the other says the person's upgrade actually works.
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

describe('ui.composer on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.59.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.59.0');
  });

  it('adds ui.composer with rich text on to a config that predates it', () => {
    const dir = seedUpgradeBoot({ theme: 'dark', statusBar: { pins: ['git'] } });

    const manager = new ConfigManager(dir);

    expect(manager.getDot('ui.composer.richText')).toBe(true);
    // The rest of `ui` is untouched — the backfill spreads the stored block.
    expect(manager.get('ui').theme).toBe('dark');
    expect(manager.get('ui').statusBar.pins).toEqual(['git']);
  });

  it('leaves the file valid, so the upgrade boot is not condemned', () => {
    const dir = seedUpgradeBoot({ theme: 'system' });

    const manager = new ConfigManager(dir);

    expect(manager.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
    // A second boot reads the migrated file cleanly rather than looping.
    expect(new ConfigManager(dir).getDot('ui.composer.richText')).toBe(true);
  });

  it('never turns on a preference someone already turned off', () => {
    // The direction that matters now the seed is `true`: somebody who used the
    // Settings switch to go back to the plain box keeps it across the upgrade.
    const dir = seedUpgradeBoot({ theme: 'system', composer: { richText: false } });

    expect(new ConfigManager(dir).getDot('ui.composer.richText')).toBe(false);
  });

  it('a fresh install gets the section from the schema, with rich text on', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-composer-prefs-fresh-'));
    dirs.push(dir);

    const manager = new ConfigManager(dir);

    expect(manager.get('ui').composer).toEqual({ richText: true });
    expect(manager.validate()).toEqual({ valid: true });
  });
});
