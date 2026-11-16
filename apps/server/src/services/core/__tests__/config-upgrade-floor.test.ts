import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigBootError, ConfigManager, ConfigUnreadableError } from '../config-manager.js';
import { ConfigUpgradeRequiredError } from '../config/upgrade-floor.js';
import { ConfigRetiredSettingsError, ConfigVersionUnreadableError } from '../config/boot-errors.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function seed(
  version?: unknown,
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

  it.each(
    [null, 135, false, {}, ['0.135.5'], '', '0.57', 'not-a-version'].map((version) => ({ version }))
  )('preserves settings with an unreadable version stamp: $version', ({ version }) => {
    const { dir, file, before } = seed(version);
    let thrown: unknown;
    try {
      new ConfigManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigBootError);
    expect(thrown).toBeInstanceOf(ConfigVersionUnreadableError);
    expect((thrown as Error).message).toContain(
      'DorkOS cannot read the version saved in your settings.'
    );
    expect((thrown as Error).message).toContain('Your settings have not been changed.');
    expect((thrown as Error).message).not.toContain('Upgrade to 0.115');
    expect((thrown as ConfigBootError).configPath).toBe(file);
    expect((thrown as ConfigBootError).advice).toContain('Restore a saved copy');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['sessionSecret', { sessionSecret: 'made-up-secret' }],
    ['tunnel.passcodeEnabled', { tunnel: { passcodeEnabled: false } }],
    ['tunnel.passcodeHash', { tunnel: { passcodeHash: 'made-up-hash' } }],
    ['tunnel.passcodeSalt', { tunnel: { passcodeSalt: 'made-up-salt' } }],
    ['telemetry.enabled', { telemetry: { enabled: false, userHasDecided: true } }],
    ['onboarding.completedSteps: "adapters"', { onboarding: { completedSteps: ['adapters'] } }],
    ['onboarding.skippedSteps: "tasks"', { onboarding: { skippedSteps: ['tasks'] } }],
  ])('names the retired key %s in an unstamped file', (key, extra) => {
    const { dir, file, before } = seed(undefined, extra);
    let thrown: unknown;
    try {
      new ConfigManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigBootError);
    expect(thrown).toBeInstanceOf(ConfigRetiredSettingsError);
    expect((thrown as Error).message).toContain(key);
    expect((thrown as Error).message).toContain('Remove');
    expect((thrown as Error).message).toContain('Your settings have not been changed.');
    expect((thrown as Error).message).not.toContain('Upgrade to 0.115');
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it('names all retired keys without showing their values', () => {
    const { dir, file, before } = seed(undefined, {
      sessionSecret: 'made-up-secret',
      tunnel: { passcodeEnabled: false, passcodeHash: 'made-up-hash' },
      telemetry: { enabled: false },
      onboarding: { completedSteps: ['welcome', 'adapters', 'tasks'] },
    });
    let thrown: unknown;
    try {
      new ConfigManager(dir);
    } catch (error) {
      thrown = error;
    }
    const message = (thrown as Error).message;
    for (const key of [
      'sessionSecret',
      'tunnel.passcodeEnabled',
      'tunnel.passcodeHash',
      'telemetry.enabled',
      'onboarding.completedSteps: "adapters"',
      'onboarding.completedSteps: "tasks"',
    ]) {
      expect(message).toContain(key);
    }
    expect(message).not.toContain('made-up-secret');
    expect(message).not.toContain('made-up-hash');
    expect(message).not.toContain('welcome');
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
