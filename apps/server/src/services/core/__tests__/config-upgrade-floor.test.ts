import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.135.5';
});

import { createHash } from 'node:crypto';
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

function seed(version?: string, sidebar?: unknown): { dir: string; file: string; before: Buffer } {
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
        extensions: { approvedToRun: ['fixture-extension'] },
        harness: { approvedHooks: ['fixture-hooks@digest'] },
        runtimes: {
          defaultTrustStop: 'ask',
          claudeCode: {
            defaultAccount: '/fixture/account',
            accounts: [
              {
                id: 'fixture-account',
                path: '/fixture/account',
                label: 'Fixture',
                renamedFrom: 'default',
              },
            ],
          },
        },
        ui: { theme: 'dark', ...(sidebar === undefined ? {} : { sidebar }) },
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
    '0.57.0',
    '0.59.0',
    '0.60.0',
    '0.62.0',
    '0.63.0',
    '0.64.0',
    '0.65.0',
    '0.66.0',
    '0.67.0',
    '0.68.0',
    '0.69.0',
    '0.70.0',
    '0.73.0',
    '0.75.0',
    '0.76.0',
    '0.77.0',
    '0.78.0',
    '0.79.0',
    '0.80.0',
    '0.81.0',
    '0.82.0',
    '0.83.0',
    '0.84.0',
    '0.85.0',
    '0.86.0',
    '0.87.0',
    '0.89.0',
    '0.114.9',
    '0.115.0-beta.1',
    undefined,
  ])('refuses %s before defaults, migrations, or recovery can write', (version) => {
    const { dir, file, before } = seed(version);
    const write = vi.spyOn(fs, 'writeFileSync');
    const open = vi.spyOn(fs, 'openSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync');
    let thrown: unknown;
    try {
      new ConfigManager(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigUpgradeRequiredError);
    expect(thrown).toBeInstanceOf(ConfigBootError);
    expect((thrown as ConfigUpgradeRequiredError).advice).toMatch(/0\.115 first/);
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(
      open.mock.calls.filter(([, flags]) =>
        typeof flags === 'string'
          ? /[wa+]/.test(flags)
          : (flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                fs.constants.O_APPEND)) !==
            0
      )
    ).toEqual([]);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(
      createHash('sha256').update(before).digest('hex')
    );
    expect(fs.readdirSync(dir)).toEqual(['config.json']);
  });

  it.each([
    { pinned: ['/fixture/project'] },
    { muted: ['/fixture/project'] },
    { groups: [{ id: 'fixture-group', name: 'Projects', agentPaths: ['/fixture/project'] }] },
    { groups: [{ id: 'fixture-group', name: 'Projects', items: ['/fixture/project'] }] },
    { ungroupedCollapsed: true },
  ])('refuses retired sidebar encodings even with a supported marker: %j', (sidebar) => {
    const { dir, file, before } = seed('0.115.0', sidebar);
    expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);
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
      expect(stored.extensions.approvedToRun).toEqual(['fixture-extension']);
      expect(stored.harness.approvedHooks).toEqual(['fixture-hooks@digest']);
      expect(stored.runtimes.defaultTrustStop).toBe('ask');
      expect(stored.runtimes.claudeCode.defaultAccount).toBe('/fixture/account');
      expect(stored.runtimes.claudeCode.accounts).toEqual([
        {
          id: 'fixture-account',
          path: '/fixture/account',
          label: 'Fixture',
          renamedFrom: 'default',
        },
      ]);
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
