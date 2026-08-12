/**
 * The `runtimes.claudeCode.persistentSession` backfill (DOR-1173) across the
 * real `conf`/Ajv seam.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.59.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported,
 * which means before this file's imports, which means a separate module
 * registry — the same reasoning `config-composer-prefs-migration.test.ts` gives.
 * A test that skipped this would pass while exercising nothing.
 *
 * ## Why a real manager rather than a mock store
 *
 * `.claude/rules/safe-defaults.md`: mock stores never cross the `conf`/Ajv seam,
 * and `UserConfigSchema.parse` cannot substitute — Zod strips unknown keys where
 * Ajv rejects them. Only a real file, read by a real `ConfigManager`, answers
 * whether an upgraded config still validates once the leaf lands in it.
 *
 * ## What these assert, and what they deliberately do not
 *
 * They assert the OUTCOME of an upgrade boot: the setting is there, it is off,
 * an existing `true` survives, and the file is not condemned. They are not a
 * test of the migration body — conf builds Ajv with `useDefaults`, so the
 * declared default is written into a stored `runtimes.claudeCode` block during
 * validation whether or not the migration runs, which is what makes
 * `backfillClaudeCodePersistentSession` an anchor rather than the mechanism. The
 * body itself is pinned by `config-manager.test.ts`'s mock-store suite, where
 * breaking it does go red. Both bars are needed: one says the intent is written
 * down, the other says the person's upgrade actually works.
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

/** A config from before the persistent-session opt-in existed. */
const STORED_VERSION = '0.58.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A temp data directory holding a valid config one upgrade behind this key.
 *
 * @param claudeCode - The `runtimes.claudeCode` block, as an upgrading machine carries it.
 */
function seedUpgradeBoot(claudeCode: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-persistent-session-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: null,
        claudeCode,
        opencode: {
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: null,
          baseURL: null,
          defaultModel: null,
          defaultTrustStop: null,
        },
        codex: {
          enabled: true,
          binaryPath: null,
          credentialRef: null,
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
        },
      },
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** The `claudeCode` block as v0.58.0 wrote it — every leaf but the new one. */
function priorClaudeCodeBlock(): Record<string, unknown> {
  return {
    activeAccount: '/Users/me/.claude2',
    accounts: [{ path: '/Users/me/.claude2', label: 'Acme Corp' }],
    defaultModel: 'opus',
    defaultEffort: 'high',
    defaultTrustStop: null,
  };
}

describe('runtimes.claudeCode.persistentSession on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.59.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.59.0');
  });

  it('adds the opt-in, off, to a config that predates it', () => {
    const dir = seedUpgradeBoot(priorClaudeCodeBlock());

    const manager = new ConfigManager(dir);

    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(false);
    // The rest of the section is untouched — the backfill spreads the stored block.
    expect(manager.get('runtimes').claudeCode.activeAccount).toBe('/Users/me/.claude2');
    expect(manager.get('runtimes').claudeCode.defaultModel).toBe('opus');
    expect(manager.get('runtimes').claudeCode.accounts).toEqual([
      { path: '/Users/me/.claude2', label: 'Acme Corp' },
    ]);
  });

  it('leaves the file valid, so the upgrade boot is not condemned', () => {
    const dir = seedUpgradeBoot(priorClaudeCodeBlock());

    const manager = new ConfigManager(dir);

    expect(manager.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
    // A second boot reads the migrated file cleanly rather than looping.
    expect(new ConfigManager(dir).getDot('runtimes.claudeCode.persistentSession')).toBe(false);
  });

  it('never turns off an opt-in somebody already turned on', () => {
    const dir = seedUpgradeBoot({ ...priorClaudeCodeBlock(), persistentSession: true });

    expect(new ConfigManager(dir).getDot('runtimes.claudeCode.persistentSession')).toBe(true);
  });

  it('a fresh install gets the leaf from the schema, off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-persistent-session-fresh-'));
    dirs.push(dir);

    const manager = new ConfigManager(dir);

    expect(manager.get('runtimes').claudeCode.persistentSession).toBe(false);
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('accepts the setting turned on and hands it back through a real load', () => {
    // The write path a person or `config_patch` takes: Ajv must ADMIT `true`,
    // not merely tolerate the default. A schema that typed this wrong would
    // condemn the whole file here rather than fail an assertion.
    const dir = seedUpgradeBoot(priorClaudeCodeBlock());
    const manager = new ConfigManager(dir);

    manager.set('runtimes', {
      ...manager.get('runtimes'),
      claudeCode: { ...manager.get('runtimes').claudeCode, persistentSession: true },
    });

    expect(new ConfigManager(dir).getDot('runtimes.claudeCode.persistentSession')).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});
