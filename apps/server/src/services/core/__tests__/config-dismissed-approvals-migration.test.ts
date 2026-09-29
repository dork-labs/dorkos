/**
 * The `'0.92.0'` migration: `extensions.dismissedApprovals` is seeded as an
 * empty map (DOR-2517), the extension copies a person said "Not now" to in the
 * Activity inbox.
 *
 * A nested leaf under a block every stored config already has, so conf's
 * shallow defaults-merge never adds it: the full-path case reads the FILE,
 * because a manager-level read would pass with the body deleted (DOR-1496).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  seedExtensionsDismissedApprovals,
} from '../config-manager.js';

/** A minimal conf-like store over one plain object. */
function memoryStore(initial: Record<string, unknown>) {
  const data = structuredClone(initial);
  return {
    data,
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
  };
}

describe('seedExtensionsDismissedApprovals', () => {
  it('seeds an empty map and keeps every other extensions member', () => {
    const store = memoryStore({
      extensions: {
        enabled: ['flow'],
        disabled: [],
        approvedToRun: ['flow'],
        approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
      },
    });

    seedExtensionsDismissedApprovals(store);

    expect(store.data.extensions).toEqual({
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
      dismissedApprovals: {},
    });
  });

  it('leaves a map that is already there alone', () => {
    const extensions = {
      enabled: [],
      dismissedApprovals: {
        flow: { path: '/p/flow', version: '1.0.0', dismissedAt: '2026-09-28T00:00:00.000Z' },
      },
    };
    const store = memoryStore({ extensions });
    seedExtensionsDismissedApprovals(store);
    seedExtensionsDismissedApprovals(store);
    expect(store.data.extensions).toEqual(extensions);
  });

  it('skips a config with no extensions block', () => {
    const bare = memoryStore({ ui: { theme: 'dark' } });
    seedExtensionsDismissedApprovals(bare);
    expect(bare.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('is what the 0.92.0 key runs', () => {
    const store = memoryStore({ extensions: { enabled: [] } });
    CONFIG_MIGRATIONS['0.92.0'](store);
    expect(store.data.extensions).toEqual({ enabled: [], dismissedApprovals: {} });
  });
});

describe('a real pre-0.92.0 config file (full conf path)', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gains the empty map on disk', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-dismissed-approvals-mig-'));
    const cfgPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        extensions: {
          enabled: ['flow'],
          disabled: [],
          approvedToRun: [],
          approvedSources: {},
        },
        __internal__: { migrations: { version: '0.91.0' } },
      }),
      'utf-8'
    );

    new Conf({
      configName: 'config',
      cwd: dir,
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.92.0',
      migrations: CONFIG_MIGRATIONS,
    });

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      extensions: Record<string, unknown>;
    };
    expect(onDisk.extensions.dismissedApprovals).toEqual({});
    expect(onDisk.extensions.enabled).toEqual(['flow']);
  });
});
