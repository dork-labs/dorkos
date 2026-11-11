/** A2A defaults and explicit choices survive supported upgrades and real writes. */
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

/** A supported config missing the optional A2A section. */
const STORED_VERSION = '0.115.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temporary directory holding a config at the supported upgrade floor.
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
  it('leaves the gate CLOSED, on the file, for a config that predates the section', () => {
    const dir = seedUpgradeBoot();

    const manager = new ConfigManager(dir);

    // On the file as well as in memory: a value only conf's read-time fill knows
    // about is one the person does not really have, and the two are worth
    // telling apart even where — as here — the same launch supplies both.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      a2a: unknown;
    };
    expect(onDisk.a2a).toEqual({ enabled: false });
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
