/**
 * The `'0.98.0'` migration: `extensions.approvedPermissions` is seeded as an
 * empty map (DOR-2686), the permission set each extension approval covers.
 *
 * A nested leaf under a block every stored config already has, so conf's
 * shallow defaults-merge never adds it: the upgrade-boot case reads the FILE,
 * because a manager-level read would pass with the body deleted (DOR-1496).
 * `DORKOS_VERSION_OVERRIDE` is set before `lib/version.ts` loads so a real
 * {@link ConfigManager} runs the key at all. Seeding it empty must leave every
 * existing approval running: an absent entry is the full in-process set.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.98.0';
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CONFIG_MIGRATIONS,
  ConfigManager,
  seedExtensionsApprovedPermissions,
} from '../config-manager.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import { mayRunExtensionCode } from '../../extensions/extension-load-policy.js';

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

describe('seedExtensionsApprovedPermissions', () => {
  it('seeds an empty map and keeps every other extensions member', () => {
    const store = memoryStore({
      extensions: {
        enabled: ['flow'],
        approvedToRun: ['flow'],
        approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
      },
    });
    seedExtensionsApprovedPermissions(store);
    expect(store.data.extensions).toEqual({
      enabled: ['flow'],
      approvedToRun: ['flow'],
      approvedSources: { flow: { path: '/p/flow', plugin: 'flow' } },
      approvedPermissions: {},
    });
  });

  it('leaves a map that is already there alone, however often it runs', () => {
    const extensions = {
      approvedPermissions: {
        mail: { runtime: 'subprocess', net: ['imap.example.com:993'], run: [], agents: false },
      },
    };
    const store = memoryStore({ extensions });
    seedExtensionsApprovedPermissions(store);
    seedExtensionsApprovedPermissions(store);
    expect(store.data.extensions).toEqual(extensions);
  });

  it('repairs a non-object value and skips a config with no extensions block', () => {
    const broken = memoryStore({ extensions: { approvedPermissions: ['oops'] } });
    seedExtensionsApprovedPermissions(broken);
    expect(broken.data.extensions).toEqual({ approvedPermissions: {} });
    const bare = memoryStore({ ui: { theme: 'dark' } });
    seedExtensionsApprovedPermissions(bare);
    expect(bare.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('is what the 0.98.0 key runs', () => {
    const store = memoryStore({ extensions: { enabled: [] } });
    CONFIG_MIGRATIONS['0.98.0'](store);
    expect(store.data.extensions).toEqual({ enabled: [], approvedPermissions: {} });
  });
});

describe('a real pre-0.98.0 config file through a real ConfigManager', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('really is running the 0.98.0 migration, or the rest of this file means nothing', () => {
    expect(SERVER_VERSION).toBe('0.98.0');
  });

  it('gains the empty map on disk, and every existing approval still runs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-approved-permissions-mig-'));
    dirs.push(dir);
    const cfgPath = path.join(dir, 'config.json');
    const flowPath = '/work/app/.dork/plugins/flow/.dork/extensions/flow';
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true },
        extensions: {
          enabled: ['flow'],
          disabled: [],
          approvedToRun: ['flow'],
          approvedSources: { flow: { path: flowPath, plugin: 'flow' } },
          dismissedApprovals: {},
          trustedSources: [],
        },
        __internal__: { migrations: { version: '0.97.0' } },
      }),
      'utf-8'
    );

    const manager = new ConfigManager(dir);

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      extensions: Record<string, unknown>;
    };
    expect(onDisk.extensions.approvedPermissions).toEqual({});
    expect(manager.validate()).toEqual({ valid: true });
    const extensions = manager.get('extensions');
    // The approved copy runs as before, in-process or moved to subprocess.
    const flow = {
      id: 'flow',
      origin: 'user' as const,
      path: flowPath,
      sourcePlugin: 'flow',
      manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
    };
    expect(mayRunExtensionCode(flow, extensions)).toBe(true);
    expect(
      mayRunExtensionCode(
        {
          ...flow,
          manifest: {
            ...flow.manifest,
            serverCapabilities: {
              serverEntry: './server.ts',
              runtime: 'subprocess' as const,
              allow: { net: ['api.example.com'], run: [], agents: false },
            },
          },
        },
        extensions
      )
    ).toBe(true);
  });
});
