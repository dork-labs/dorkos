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

function seed(
  version?: string,
  extra: Record<string, unknown> = {}
): { dir: string; file: string; before: Buffer } {
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
        ...extra,
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
    expect((thrown as Error).message).toMatch(/cannot upgrade these settings directly/);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a root sessionSecret', { sessionSecret: 'made-up-secret' }],
    ['a tunnel passcode', { tunnel: { enabled: false, passcodeHash: 'made-up-hash' } }],
    ['telemetry.enabled', { telemetry: { enabled: false, userHasDecided: true } }],
    ['a retired onboarding step', { onboarding: { completedSteps: ['adapters'] } }],
  ])('refuses an unstamped file with %s, which only a pre-0.115 release wrote', (_, extra) => {
    const { dir, file, before } = seed(undefined, extra);
    expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('opens an unstamped current file and stamps it as this version', () => {
    const { dir, file } = seed(undefined);
    const manager = new ConfigManager(dir);
    expect(manager.isFirstRun).toBe(false);
    expect(manager.get('auth').enabled).toBe(true);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.__internal__.migrations.version).toBe('0.135.5');
    expect(stored.ui.theme).toBe('dark');
    expect(stored.telemetry.install).toBe(false);
    expect(stored.permissions.preset).toBe('careful');
  });

  it('opens a hand-written file that names one setting, as the docs suggest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-floor-hand-'));
    dirs.push(dir);
    const file = path.join(dir, 'config.json');
    const caPath = path.join(dir, 'example-ca.pem');
    fs.writeFileSync(file, JSON.stringify({ network: { extraCaCertsPath: caPath } }, null, 2));
    const manager = new ConfigManager(dir);
    expect(manager.get('network').extraCaCertsPath).toBe(caPath);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(stored.__internal__.migrations.version).toBe('0.135.5');
    expect(stored.network.extraCaCertsPath).toBe(caPath);
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
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(stored.__internal__.migrations.version).toBe('0.135.5');
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
