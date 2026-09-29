/**
 * The `'0.94.0'` migration: `extensions.trustedSources` is seeded as an empty
 * list (spec `flow-multiproject` §9.3), the code sources a person trusts
 * outright.
 *
 * A nested leaf under a block every stored config already has, so conf's
 * shallow defaults-merge never adds it: the upgrade-boot case reads the FILE,
 * because a manager-level read would pass with the body deleted (DOR-1496).
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads so a real
 * {@link ConfigManager} runs the key at all.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.94.0';
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONFIG_MIGRATIONS,
  ConfigManager,
  seedExtensionsTrustedSources,
} from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';

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

describe('seedExtensionsTrustedSources', () => {
  it('seeds an empty list and keeps every other extensions member', () => {
    const store = memoryStore({
      extensions: {
        enabled: ['flow'],
        disabled: [],
        approvedToRun: ['flow'],
        approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
        dismissedApprovals: {},
      },
    });

    seedExtensionsTrustedSources(store);

    expect(store.data.extensions).toEqual({
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
      dismissedApprovals: {},
      trustedSources: [],
    });
  });

  it('leaves a list that is already there alone, however often it runs', () => {
    const extensions = {
      enabled: [],
      trustedSources: [{ source: 'dork-labs/marketplace', trustedAt: '2026-09-29T00:00:00.000Z' }],
    };
    const store = memoryStore({ extensions });
    seedExtensionsTrustedSources(store);
    seedExtensionsTrustedSources(store);
    expect(store.data.extensions).toEqual(extensions);
  });

  it('skips a config with no extensions block', () => {
    const bare = memoryStore({ ui: { theme: 'dark' } });
    seedExtensionsTrustedSources(bare);
    expect(bare.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('is what the 0.94.0 key runs', () => {
    const store = memoryStore({ extensions: { enabled: [] } });
    CONFIG_MIGRATIONS['0.94.0'](store);
    expect(store.data.extensions).toEqual({ enabled: [], trustedSources: [] });
  });
});

describe('a real pre-0.94.0 config file through a real ConfigManager', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('really is running the 0.94.0 migration, or the rest of this file means nothing', () => {
    expect(SERVER_VERSION).toBe('0.94.0');
  });

  it('gains the empty list on disk and keeps every approval', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-trusted-sources-mig-'));
    dirs.push(dir);
    const cfgPath = path.join(dir, 'config.json');
    // What a person on 0.93.0 who turned Flow on has on disk.
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true },
        extensions: {
          enabled: ['flow'],
          disabled: [],
          approvedToRun: ['flow'],
          approvedSources: {
            flow: { path: '/work/app/.dork/plugins/flow/.dork/extensions/flow', plugin: 'flow' },
          },
          dismissedApprovals: {},
        },
        __internal__: { migrations: { version: '0.93.0' } },
      }),
      'utf-8'
    );

    const manager = new ConfigManager(dir);

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      extensions: Record<string, unknown>;
    };
    expect(onDisk.extensions.trustedSources).toEqual([]);
    expect(onDisk.extensions.approvedToRun).toEqual(['flow']);
    expect(manager.validate()).toEqual({ valid: true });
    expect(manager.get('extensions').trustedSources).toEqual([]);
  });
});
