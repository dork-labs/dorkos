/**
 * The `a2a.enabled` seed (DOR-1304) across the real `conf`/Ajv seam.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.62.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported,
 * which means before this file's imports, which means a separate module registry
 * — the same reasoning `config-persistent-session-migration.test.ts` gives. A
 * test that skipped this would pass while exercising nothing.
 *
 * ## Why a real manager rather than a mock store
 *
 * `.claude/rules/safe-defaults.md`: mock stores never cross the `conf`/Ajv seam,
 * and `UserConfigSchema.parse` cannot substitute — Zod strips unknown keys where
 * Ajv rejects them. `a2a` is a whole new top-level SECTION, and a config file
 * written before it existed has no such key, so the only question worth asking is
 * whether a real `ConfigManager` reading a real file still validates once the
 * section lands. Nothing short of that answers it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.62.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from before the `a2a` section existed. */
const STORED_VERSION = '0.61.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a valid config one upgrade behind this key.
 *
 * @param extra - Extra top-level sections to write, e.g. an `a2a` block a person already has.
 */
function seedUpgradeBoot(extra: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-a2a-migration-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      relay: { enabled: true, dataDir: null },
      ...extra,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

describe('a2a.enabled on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.62.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.62.0');
  });

  it('seeds the gate CLOSED on a config that predates the section', () => {
    const dir = seedUpgradeBoot();

    const manager = new ConfigManager(dir);

    expect(manager.getDot('a2a.enabled')).toBe(false);
    // The section beside it is untouched.
    expect(manager.get('relay').enabled).toBe(true);
  });

  it('leaves the file valid, so the upgrade boot is not condemned', () => {
    const dir = seedUpgradeBoot();

    const manager = new ConfigManager(dir);

    expect(manager.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
    // A second boot reads the migrated file cleanly rather than looping.
    expect(new ConfigManager(dir).getDot('a2a.enabled')).toBe(false);
  });

  it('never closes a gate somebody already opened', () => {
    const dir = seedUpgradeBoot({ a2a: { enabled: true } });

    expect(new ConfigManager(dir).getDot('a2a.enabled')).toBe(true);
  });

  it('a fresh install gets the section from the schema, off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-a2a-fresh-'));
    dirs.push(dir);

    const manager = new ConfigManager(dir);

    expect(manager.get('a2a').enabled).toBe(false);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('accepts the setting turned on and hands it back through a real load', () => {
    // The write path Settings takes through `PATCH /api/config`: Ajv must ADMIT
    // `true`, not merely tolerate the default. A schema that typed this wrong
    // would condemn the whole file here rather than fail an assertion.
    const dir = seedUpgradeBoot();
    const manager = new ConfigManager(dir);

    manager.set('a2a', { enabled: true });

    expect(new ConfigManager(dir).getDot('a2a.enabled')).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});
