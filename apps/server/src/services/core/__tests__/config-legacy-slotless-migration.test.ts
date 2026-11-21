/**
 * The `'0.140.0'` migration lists every extension approval whose stored
 * permission set records no places (`extensions.legacySlotless`, DOR-4891),
 * so the first scan after the upgrade can give each the places its unchanged
 * approved files declare (`extensions/pin/slots-backfill.ts`).
 *
 * The upgrade-boot case reads the FILE, through a real `ConfigManager`, with
 * `DORKOS_VERSION_OVERRIDE` set before `lib/version.ts` loads so the key runs
 * at all; then the first scan and its settle run as `initialize` runs them.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DORKOS_VERSION_OVERRIDE = '0.140.0';
});

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { CONFIG_MIGRATIONS, initConfigManager } from '../config-manager.js';
import { markSlotlessApprovals } from '../config-migrations/v0-90-onward.js';
import { SERVER_VERSION } from '../../../lib/version.js';
import {
  settleLegacyApprovals,
  upkeepApprovals,
} from '../../extensions/pin/extension-approval-upkeep.js';
import { waitingPlacesOf } from '../../extensions/isolation/place-grace.js';
import { isPendingApproval } from '../../extensions/extension-approval-queue.js';

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

const IN_PROCESS = { runtime: 'in-process', net: [], run: [], agents: false };

describe('markSlotlessApprovals', () => {
  it('lists each approved id whose set records no places, and keeps every other member', () => {
    const store = memoryStore({
      extensions: {
        enabled: ['notes', 'mail', 'todo', 'fresh'],
        approvedToRun: ['notes', 'mail', 'todo', 'fresh'],
        approvedSources: { notes: { path: '/p/notes' } },
        approvedPermissions: {
          // No entry for `notes`: the full in-process set, from before sets.
          mail: { runtime: 'subprocess', net: ['imap.example.com'], run: [], agents: false },
          todo: IN_PROCESS,
          fresh: { ...IN_PROCESS, slots: ['pages'] },
        },
      },
    });
    markSlotlessApprovals(store);
    expect(store.data.extensions).toEqual({
      enabled: ['notes', 'mail', 'todo', 'fresh'],
      approvedToRun: ['notes', 'mail', 'todo', 'fresh'],
      approvedSources: { notes: { path: '/p/notes' } },
      approvedPermissions: {
        mail: { runtime: 'subprocess', net: ['imap.example.com'], run: [], agents: false },
        todo: IN_PROCESS,
        fresh: { ...IN_PROCESS, slots: ['pages'] },
      },
      legacySlotless: ['notes', 'mail', 'todo'],
    });
  });

  it('never lists an id that is not approved to run', () => {
    const store = memoryStore({
      extensions: { approvedToRun: [], approvedPermissions: { revoked: IN_PROCESS } },
    });
    markSlotlessApprovals(store);
    expect(store.data.extensions).toEqual({
      approvedToRun: [],
      approvedPermissions: { revoked: IN_PROCESS },
    });
  });

  it('leaves a list that is already there alone, however often it runs', () => {
    const extensions = { approvedToRun: ['notes', 'mail'], legacySlotless: ['notes'] };
    const store = memoryStore({ extensions });
    markSlotlessApprovals(store);
    markSlotlessApprovals(store);
    expect(store.data.extensions).toEqual(extensions);
  });

  it('writes nothing when no approval needs a list, or there is no extensions block', () => {
    const none = memoryStore({
      extensions: {
        approvedToRun: ['fresh'],
        approvedPermissions: { fresh: { ...IN_PROCESS, slots: [] } },
      },
    });
    const before = structuredClone(none.data);
    markSlotlessApprovals(none);
    expect(none.data).toEqual(before);
    const bare = memoryStore({ ui: { theme: 'dark' } });
    markSlotlessApprovals(bare);
    expect(bare.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('is what the 0.140.0 key runs', () => {
    expect(CONFIG_MIGRATIONS['0.140.0']).toBe(markSlotlessApprovals);
  });
});

describe('a real 0.139.0 config file through a real ConfigManager and the first scan', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('really is running the 0.140.0 migration, or the rest of this file means nothing', () => {
    expect(SERVER_VERSION).toBe('0.140.0');
  });

  it('keeps an approved app in its places with no card, then clears the list', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-legacy-slotless-mig-'));
    dirs.push(dir);
    const cfgPath = path.join(dir, 'config.json');
    const appPath = path.join(dir, 'extensions', 'notes');
    const digest = `sha256:${'c'.repeat(64)}`;
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true },
        extensions: {
          enabled: ['notes'],
          disabled: [],
          approvedToRun: ['notes'],
          // As 0.139.0 wrote a person's yes: pinned to the files, no places.
          approvedSources: { notes: { path: appPath, digest, personApprovedDigest: digest } },
          approvedPermissions: {},
          dismissedApprovals: {},
          trustedSources: [],
        },
        __internal__: { migrations: { version: '0.139.0' } },
      }),
      'utf-8'
    );

    // The process-wide manager, so the scan's upkeep below writes to it.
    const manager = initConfigManager(dir);

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      extensions: Record<string, unknown>;
    };
    expect(onDisk.extensions.legacySlotless).toEqual(['notes']);
    expect(manager.validate()).toEqual({ valid: true });

    const notes = {
      id: 'notes',
      origin: 'user',
      status: 'enabled',
      scope: 'global',
      path: appPath,
      realPath: appPath,
      bundleReady: false,
      hasServerEntry: false,
      hasDataProxy: false,
      currentDigest: digest,
      manifest: {
        id: 'notes',
        name: 'Notes',
        version: '1.0.0',
        contributions: { 'command-palette.items': true, dialog: true, canvas: true },
      },
    } as ExtensionRecord;
    // What 0.140.0 does at boot: the first scan, then settle.
    upkeepApprovals([notes], [], dir);
    settleLegacyApprovals();

    const extensions = manager.get('extensions');
    expect(extensions.approvedPermissions!.notes!.slots).toEqual([
      'command-palette.items',
      'dialog',
    ]);
    expect(extensions).not.toHaveProperty('legacySlotless');
    // `canvas` is new with DOR-4282, so only it still waits.
    expect(waitingPlacesOf(notes, extensions)).toEqual(['canvas']);
    expect(
      isPendingApproval(
        {
          ...notes,
          manifest: {
            ...notes.manifest,
            contributions: { 'command-palette.items': true, dialog: true },
          },
        },
        extensions
      )
    ).toBe(false);
  });
});
