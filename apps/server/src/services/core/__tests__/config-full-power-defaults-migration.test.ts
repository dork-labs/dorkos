/**
 * The `0.66.0` migration (spec `full-power-defaults`, D2) across the real
 * `conf`/Ajv seam.
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree — `0.63.0` as this is written — so a `0.66.0` body runs under NO default
 * test environment. `DORKOS_VERSION_OVERRIDE` has to be set before
 * `lib/version.ts` is imported, which means before this file's imports, which
 * means a separate module registry. The same reasoning
 * `config-persistent-session-migration.test.ts` gives. A test that skipped this
 * would pass while exercising nothing, so the first case below asserts the
 * override took.
 *
 * ## Why a real manager rather than a mock store
 *
 * `.claude/rules/safe-defaults.md`: mock stores never cross the `conf`/Ajv seam,
 * and `UserConfigSchema.parse` cannot substitute — Zod strips unknown keys where
 * Ajv rejects them. Only a real file, read by a real `ConfigManager`, answers
 * whether an upgraded config still validates once these leaves land in it. The
 * bodies themselves are pinned separately by `config-manager.test.ts`'s
 * mock-store suite.
 *
 * ## Invariant A1 has its own case here
 *
 * Nothing this key touches is consent-gated, and the last describe block is what
 * keeps that true: an upgrade boot must leave `runtimes.defaultTrustStop`,
 * `ui.autonomyAcknowledgedAt` and `approvals.standingGrants` exactly where it
 * found them, whichever side of the door the person is on.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// Hoisted above the imports below: `SERVER_VERSION` is a module-level const, so
// the override has to be in the environment before `lib/version.ts` loads.
vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.66.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config written by the release immediately before this key. */
const STORED_VERSION = '0.65.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** The `runtimes.claudeCode` block as an upgrading machine carries it. */
function claudeCodeBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultAccount: null,
    accounts: [],
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
    persistentSession: false,
    ...overrides,
  };
}

/**
 * A temp data directory holding a valid config one release behind this key.
 *
 * @param overrides - Sections to replace on the stored file, merged shallowly
 *   over the block an upgrading machine really carries.
 */
function seedUpgradeBoot(overrides: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-full-power-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ui: {
        theme: 'system',
        dismissedUpgradeVersions: [],
        statusBar: { pins: [] },
        composer: { richText: true },
        autonomyAcknowledgedAt: null,
      },
      scheduler: { enabled: true, maxConcurrentRuns: 1, timezone: null, retentionCount: 100 },
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: null,
        claudeCode: claudeCodeBlock(),
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
      ...overrides,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

describe('the 0.66.0 migration on an upgrade boot (real conf + Ajv)', () => {
  it('really is running the 0.66.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.66.0');
  });

  it('reserves both halves of the power-door answer, unanswered, ON DISK', () => {
    // Asserted against the FILE, and that is not fussiness — a `getDot`
    // assertion here is vacuous. Measured with the body suppressed: `getDot`
    // still answers `null`, because conf's `store` getter re-parses the file on
    // every access and validates that throwaway copy, so Ajv's `useDefaults`
    // fills the object being returned and is then discarded. Nothing reaches the
    // file but this body — the only merge that runs before it is conf's
    // top-level shallow `Object.assign`, which a stored `ui` object wins
    // wholesale. See {@link seedFullPowerDecision}'s docs.
    const dir = seedUpgradeBoot();

    const manager = new ConfigManager(dir);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      ui: Record<string, unknown>;
    };
    expect(onDisk.ui).toHaveProperty('fullPowerDecidedAt', null);
    expect(onDisk.ui).toHaveProperty('fullPowerChoice', null);
    expect(manager.getDot('ui.fullPowerDecidedAt')).toBeNull();
    expect(manager.getDot('ui.fullPowerChoice')).toBeNull();
  });

  it('raises a stored scheduler concurrency of exactly 1 to 4', () => {
    const manager = new ConfigManager(seedUpgradeBoot());

    expect(manager.getDot('scheduler.maxConcurrentRuns')).toBe(4);
    // The rest of the section is untouched — the body spreads the stored block.
    expect(manager.get('scheduler').retentionCount).toBe(100);
    expect(manager.get('scheduler').enabled).toBe(true);
  });

  it('turns warm agents on for a config the 0.59.0 backfill stored them off in', () => {
    const manager = new ConfigManager(seedUpgradeBoot());

    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(true);
  });

  it('leaves a concurrency the person chose alone', () => {
    const dir = seedUpgradeBoot({
      scheduler: { enabled: true, maxConcurrentRuns: 7, timezone: null, retentionCount: 100 },
    });

    expect(new ConfigManager(dir).getDot('scheduler.maxConcurrentRuns')).toBe(7);
  });

  it('leaves warm agents alone for somebody who had already turned them on', () => {
    const dir = seedUpgradeBoot({
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: null,
        claudeCode: claudeCodeBlock({ persistentSession: true, defaultModel: 'opus' }),
      },
    });

    const manager = new ConfigManager(dir);

    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(true);
    expect(manager.getDot('runtimes.claudeCode.defaultModel')).toBe('opus');
  });

  it('never re-answers a door the person already answered', () => {
    const dir = seedUpgradeBoot({
      ui: {
        theme: 'system',
        dismissedUpgradeVersions: [],
        statusBar: { pins: [] },
        composer: { richText: true },
        autonomyAcknowledgedAt: null,
        fullPowerDecidedAt: '2026-08-22T09:00:00.000Z',
        fullPowerChoice: 'supervised',
      },
    });

    const manager = new ConfigManager(dir);

    expect(manager.getDot('ui.fullPowerDecidedAt')).toBe('2026-08-22T09:00:00.000Z');
    expect(manager.getDot('ui.fullPowerChoice')).toBe('supervised');
  });

  it('leaves the file valid, so the upgrade boot is not condemned', () => {
    const dir = seedUpgradeBoot();

    const manager = new ConfigManager(dir);

    expect(manager.validate()).toEqual({ valid: true });
    expect(fs.existsSync(path.join(dir, 'config.json.bak'))).toBe(false);
  });

  it('is a no-op the second time, including for a value moved back afterwards', () => {
    const dir = seedUpgradeBoot();
    new ConfigManager(dir);

    // The person changes their mind after the migration has run and stamped the
    // version. A second boot must not undo either choice.
    const manager = new ConfigManager(dir);
    manager.set('scheduler', { ...manager.get('scheduler'), maxConcurrentRuns: 1 });
    manager.set('runtimes', {
      ...manager.get('runtimes'),
      claudeCode: { ...manager.get('runtimes').claudeCode, persistentSession: false },
    });

    const reopened = new ConfigManager(dir);

    expect(reopened.getDot('scheduler.maxConcurrentRuns')).toBe(1);
    expect(reopened.getDot('runtimes.claudeCode.persistentSession')).toBe(false);
    expect(reopened.validate()).toEqual({ valid: true });
  });

  it('a fresh install lands on the new values from the schema alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-full-power-fresh-'));
    dirs.push(dir);

    const manager = new ConfigManager(dir);

    expect(manager.getDot('scheduler.maxConcurrentRuns')).toBe(4);
    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(true);
    expect(manager.getDot('ui.fullPowerDecidedAt')).toBeNull();
    expect(manager.getDot('ui.fullPowerChoice')).toBeNull();
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('accepts an answered door through a real load, both ways', () => {
    // The write path the door itself takes: Ajv must ADMIT these values, not
    // merely tolerate the defaults. A schema that typed either wrong would
    // condemn the whole file here rather than fail an assertion.
    const dir = seedUpgradeBoot();
    const manager = new ConfigManager(dir);

    manager.set('ui', {
      ...manager.get('ui'),
      fullPowerDecidedAt: '2026-08-22T12:00:00.000Z',
      fullPowerChoice: 'full',
    });

    const reopened = new ConfigManager(dir);
    expect(reopened.getDot('ui.fullPowerChoice')).toBe('full');
    expect(reopened.getDot('ui.fullPowerDecidedAt')).toBe('2026-08-22T12:00:00.000Z');
    expect(reopened.validate()).toEqual({ valid: true });
  });
});

describe('the 0.66.0 migration and invariant A1 (nothing consent-gated flips)', () => {
  it('leaves every consent-gated value exactly as it found it', () => {
    const manager = new ConfigManager(seedUpgradeBoot());

    expect(manager.getDot('runtimes.defaultTrustStop')).toBeNull();
    expect(manager.getDot('runtimes.claudeCode.defaultTrustStop')).toBeNull();
    expect(manager.getDot('runtimes.codex.defaultTrustStop')).toBeNull();
    expect(manager.getDot('runtimes.opencode.defaultTrustStop')).toBeNull();
    expect(manager.getDot('ui.autonomyAcknowledgedAt')).toBeNull();
    expect(manager.getDot('approvals.standingGrants')).toBe(false);
    expect(manager.getDot('mesh.scanRoots')).toEqual([]);
  });

  it('does not disturb a person who had already accepted full autonomy', () => {
    const dir = seedUpgradeBoot({
      ui: {
        theme: 'system',
        dismissedUpgradeVersions: [],
        statusBar: { pins: [] },
        composer: { richText: true },
        autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z',
      },
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: 'autonomy',
        claudeCode: claudeCodeBlock(),
      },
      approvals: {
        standingGrants: true,
        trustWindowMinutes: 60,
        standingGrantsVoidBefore: null,
      },
    });

    const manager = new ConfigManager(dir);

    expect(manager.getDot('runtimes.defaultTrustStop')).toBe('autonomy');
    expect(manager.getDot('ui.autonomyAcknowledgedAt')).toBe('2026-08-01T09:30:00.000Z');
    expect(manager.getDot('approvals.standingGrants')).toBe(true);
    // …and the safety-neutral flips still happened for them.
    expect(manager.getDot('scheduler.maxConcurrentRuns')).toBe(4);
    expect(manager.getDot('runtimes.claudeCode.persistentSession')).toBe(true);
  });
});
