import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigBootError, ConfigManager, ConfigUnreadableError } from '../config-manager.js';
import { ConfigUpgradeRequiredError } from '../config/upgrade-floor.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(version?: string): { dir: string; file: string; before: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-floor-'));
  dirs.push(dir);
  const file = path.join(dir, 'config.json');
  const before = Buffer.from(
    JSON.stringify(
      {
        version: 1,
        auth: { enabled: true },
        telemetry: {
          userHasDecided: true,
          install: false,
          heartbeat: false,
          usage: false,
          errorReporting: false,
          aiMetadata: false,
          linkAnalyticsToAccount: false,
        },
        permissions: { preset: 'careful' },
        runtimes: { defaultTrustStop: 'ask' },
        ui: { theme: 'dark' },
        ...(version === undefined ? {} : { __internal__: { migrations: { version } } }),
      },
      null,
      4
    ) + '\n'
  );
  fs.writeFileSync(file, before);
  return { dir, file, before };
}

describe('config upgrade floor through a real manager', () => {
  it.each([
    '0.44.0',
    '0.45.0',
    '0.46.0',
    '0.48.0',
    '0.50.0',
    '0.52.0',
    '0.55.0',
    '0.89.0',
    '0.114.9',
    '0.115.0-beta.1',
    undefined,
  ])('refuses %s before defaults, migrations, or recovery can write', (version) => {
    const { dir, file, before } = seed(version);
    let thrown: unknown;
    try {
      new ConfigManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigUpgradeRequiredError);
    expect(thrown).toBeInstanceOf(ConfigBootError);
    expect((thrown as ConfigUpgradeRequiredError).advice).toMatch(/0\.115 first/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it.each(['0.115.0', '0.135.5', '0.136.0'])(
    'opens supported %s without losing choices',
    (version) => {
      const { dir, file } = seed(version);
      const manager = new ConfigManager(dir);
      expect(manager.get('auth').enabled).toBe(true);
      expect(manager.get('ui').theme).toBe('dark');
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(stored.auth.enabled).toBe(true);
      expect(stored.ui.theme).toBe('dark');
      expect(stored.telemetry.install).toBe(false);
      expect(stored.telemetry.usage).toBe(false);
      expect(stored.permissions.preset).toBe('careful');
      expect(stored.runtimes.defaultTrustStop).toBe('ask');
      expect(fs.readdirSync(dir)).toEqual(['config.json']);
    }
  );

  it('creates and reopens a new install', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-floor-new-'));
    dirs.push(dir);
    expect(new ConfigManager(dir).isFirstRun).toBe(true);
    expect(new ConfigManager(dir).isFirstRun).toBe(false);
  });

  it('does not mistake an unreadable file for an old or corrupt config', () => {
    const { dir, file, before } = seed('0.114.0');
    const read = fs.readFileSync.bind(fs);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((name: unknown, options?: unknown) => {
      if (name === file) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' });
      return read(name as fs.PathOrFileDescriptor, options as BufferEncoding);
    }) as typeof fs.readFileSync);
    expect(() => new ConfigManager(dir, { retryDelaysMs: [] })).toThrow(ConfigUnreadableError);
    vi.restoreAllMocks();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });
});
