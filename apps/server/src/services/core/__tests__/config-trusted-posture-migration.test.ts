/**
 * Moving an existing install to the Trusted posture across the real `conf`/Ajv
 * seam (DOR-2739; ADR 261006-225605; spec `trusted-by-default-flip` §5.7).
 *
 * ## Why this is a file of its own
 *
 * `conf` selects a migration only when its key is `<= projectVersion`, and
 * `SERVER_VERSION` resolves to `apps/server/package.json`'s version in a dev
 * tree, so a `0.115.0` body runs under NO default test environment.
 * `DORKOS_VERSION_OVERRIDE` has to be set before `lib/version.ts` is imported.
 *
 * ## Why the assertions read the file
 *
 * `conf`'s store getter re-reads and re-validates on every access, and Ajv's
 * `useDefaults` fills the new schema defaults (`'trusted'`, `'autonomy'`) into
 * that copy, so a manager assertion can pass with the migration body deleted
 * (DOR-1496). Only the file on disk answers what the key wrote.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.115.0';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

/** A config from the release before this key. */
const STORED_VERSION = '0.114.0';
/** When the person answered the retired door. */
const DECIDED = '2026-09-01T09:00:00.000Z';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** What an install one release behind this key may hold. */
interface Stored {
  preset?: string | null;
  choice?: 'full' | 'supervised' | null;
  stop?: string | null;
  claudeCodeStop?: string | null;
  areas?: Record<string, string>;
  actions?: Record<string, string>;
  /** Leave the whole `permissions` section off, as an install from before it. */
  noPermissions?: boolean;
}

/**
 * A temp data directory holding a config one release behind this key.
 *
 * @param stored - The values to write.
 */
function seedUpgradeBoot(stored: Stored): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-trusted-posture-migration-'));
  dirs.push(dir);
  const ui: Record<string, unknown> = { theme: 'dark' };
  if (stored.choice !== undefined) {
    ui.fullPowerDecidedAt = stored.choice === null ? null : DECIDED;
    ui.fullPowerChoice = stored.choice;
  }
  const config: Record<string, unknown> = {
    version: 1,
    ui,
    runtimes: {
      default: 'claude-code',
      defaultTrustStop: stored.stop ?? null,
      claudeCode: { defaultTrustStop: stored.claudeCodeStop ?? null },
    },
    __internal__: { migrations: { version: STORED_VERSION } },
  };
  if (!stored.noPermissions) {
    config.permissions = {
      preset: stored.preset ?? null,
      defaults: { areas: stored.areas ?? {}, actions: stored.actions ?? {} },
      upgradeSweptVersion: null,
    };
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  return dir;
}

/** What is actually on disk after the manager has booted. */
function readDisk(dir: string): {
  permissions: Record<string, unknown>;
  ui: Record<string, unknown>;
  runtimes: Record<string, unknown> & { claudeCode: Record<string, unknown> };
} {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'));
}

/** Boot a manager over a seeded file and return what landed on disk. */
function boot(stored: Stored): ReturnType<typeof readDisk> & { manager: ConfigManager } {
  const dir = seedUpgradeBoot(stored);
  const manager = new ConfigManager(dir);
  return { ...readDisk(dir), manager };
}

describe('the 0.115.0 move to Trusted (real conf + Ajv)', () => {
  it('really is running the 0.115.0 migration, or none of the rest of this file means anything', () => {
    expect(SERVER_VERSION).toBe('0.115.0');
  });

  it('moves an install that never answered to Trusted, Full autonomy, notice armed', () => {
    const disk = boot({ preset: null });
    expect(disk.permissions.preset).toBe('trusted');
    expect(disk.runtimes.defaultTrustStop).toBe('autonomy');
    expect(disk.ui.trustNoticeSeenAt ?? null).toBeNull();
    expect(disk.manager.validate()).toEqual({ valid: true });
  });

  it.each(['full', 'balanced'] as const)('moves a %s install to Trusted', (preset) => {
    const disk = boot({ preset, choice: 'full' });
    expect(disk.permissions.preset).toBe('trusted');
    expect(disk.runtimes.defaultTrustStop).toBe('autonomy');
    expect(disk.ui.trustNoticeSeenAt ?? null).toBeNull();
  });

  it('moves a hand-written unknown preset to Trusted', () => {
    // A value no build wrote survives the load as version skew, and is read
    // as "not Careful".
    const disk = boot({ preset: 'everything' });
    expect(disk.permissions.preset).toBe('trusted');
  });

  it('keeps a Careful install as it is, and marks the notice seen', () => {
    const disk = boot({ preset: 'careful', stop: 'ask', choice: 'supervised' });
    expect(disk.permissions.preset).toBe('careful');
    expect(disk.runtimes.defaultTrustStop).toBe('ask');
    expect(typeof disk.ui.trustNoticeSeenAt).toBe('string');
  });

  it('leaves a Careful install with no stop of its own at no stop', () => {
    const disk = boot({ preset: 'careful', stop: null });
    expect(disk.runtimes.defaultTrustStop).toBeNull();
  });

  it('turns an unmapped "keep asking me" answer into Careful', () => {
    const disk = boot({ preset: null, choice: 'supervised' });
    expect(disk.permissions.preset).toBe('careful');
    expect(disk.runtimes.defaultTrustStop).toBeNull();
    expect(typeof disk.ui.trustNoticeSeenAt).toBe('string');
  });

  it('keeps "keep asking me" Careful on an install from before permissions existed', () => {
    // conf seeds the missing section from the new defaults (`'trusted'`)
    // before any key runs, and `'0.83.0'` then steps aside. That seed is not
    // an answer.
    const disk = boot({ noPermissions: true, choice: 'supervised' });
    expect(disk.permissions.preset).toBe('careful');
    expect(typeof disk.ui.trustNoticeSeenAt).toBe('string');
  });

  it.each([
    ['act', 'autonomy'],
    ['ask', 'ask'],
    ['autonomy', 'autonomy'],
  ])('reads a stored stop of %s as %s', (stop, expected) => {
    const disk = boot({ preset: 'full', stop });
    expect(disk.runtimes.defaultTrustStop).toBe(expected);
  });

  it('leaves a per-runtime stop alone', () => {
    const disk = boot({ preset: null, claudeCodeStop: 'ask' });
    expect(disk.runtimes.claudeCode.defaultTrustStop).toBe('ask');
  });

  it("keeps a person's own Ask and Blocked changes on top of Trusted", () => {
    const disk = boot({
      preset: 'balanced',
      areas: { rooms: 'ask', reach: 'blocked' },
      actions: { 'tasks.delete': 'ask' },
    });
    expect(disk.permissions.preset).toBe('trusted');
    expect(disk.permissions.defaults).toEqual({
      areas: { rooms: 'ask', reach: 'blocked' },
      actions: { 'tasks.delete': 'ask' },
    });
  });

  it.each(['full', 'supervised'] as const)('deletes the retired door fields (%s)', (choice) => {
    const disk = boot({ preset: null, choice });
    expect(disk.ui).not.toHaveProperty('fullPowerDecidedAt');
    expect(disk.ui).not.toHaveProperty('fullPowerChoice');
    expect(disk.ui.theme).toBe('dark');
  });

  it('does not stamp the stores outside config.json — the boot steps do', () => {
    const disk = boot({ preset: null });
    expect(disk.permissions.trustedStoresAppliedAt ?? null).toBeNull();
  });

  it('is idempotent on a second boot', () => {
    const dir = seedUpgradeBoot({ preset: null, choice: 'supervised' });
    new ConfigManager(dir);
    const first = readDisk(dir);
    const second = new ConfigManager(dir);
    expect(readDisk(dir)).toEqual(first);
    expect(second.validate()).toEqual({ valid: true });
  });
});
