/** Standing-permission settings remain available until boot captures them. */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../config-manager.js';

/** The oldest supported upgrade version. */
const STORED_VERSION = '0.115.0';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A supported config carrying an explicit permission preset. */
function seedUpgradeBoot(
  preset: 'full' | 'careful' | null,
  extra: Record<string, unknown> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-permission-preset-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({
      version: 1,
      ui: {
        theme: 'system',
      },
      runtimes: { default: 'claude-code', defaultTrustStop: 'act' },
      permissions: {
        preset,
        defaults: { areas: {}, actions: {} },
        upgradeSweptVersion: null,
      },
      ...extra,
      __internal__: { migrations: { version: STORED_VERSION } },
    })
  );
  return dir;
}

/** The stored file, as the next boot will read it. */
function readDisk(dir: string): {
  permissions?: { preset: unknown; defaults: unknown; upgradeSweptVersion: unknown };
  approvals?: Record<string, unknown>;
  runtimes: { defaultTrustStop: unknown };
} {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
}

describe('retiring the standing-permission settings (phase 2)', () => {
  const SETTINGS = {
    standingGrants: true,
    trustWindowMinutes: 60,
    standingGrantsVoidBefore: '2026-09-01T00:00:00.000Z',
  };

  it('leaves them on disk through the migration and a write, for the capture to read', () => {
    const dir = seedUpgradeBoot('full', { approvals: SETTINGS });
    const manager = new ConfigManager(dir);
    manager.setDot('ui.theme', 'dark');
    expect(readDisk(dir).approvals).toEqual(SETTINGS);
  });

  it('deletes all three once boot asks, and the section once it is empty', () => {
    const dir = seedUpgradeBoot('full', { approvals: SETTINGS });
    new ConfigManager(dir).retireStandingGrantSettings();
    expect(readDisk(dir)).not.toHaveProperty('approvals');
  });

  it('keeps anything else a newer build put in the section', () => {
    const dir = seedUpgradeBoot(null, {
      approvals: { standingGrants: false, trustWindowMinutes: 480, somethingNewer: true },
    });
    new ConfigManager(dir).retireStandingGrantSettings();
    expect(readDisk(dir).approvals).toEqual({ somethingNewer: true });
  });

  it('does nothing to an install that never had the section', () => {
    const dir = seedUpgradeBoot('careful');
    new ConfigManager(dir).retireStandingGrantSettings();
    expect(readDisk(dir)).not.toHaveProperty('approvals');
    expect(readDisk(dir).permissions?.preset).toBe('careful');
  });
});
