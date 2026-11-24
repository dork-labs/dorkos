import { describe, it, expect, afterEach } from 'vitest';
import {
  ConfigManager,
  initConfigManager,
  backfillSidebarRoomSections,
  GROUPS_HINT_SUGGESTION_ID,
  CONFIG_MIGRATIONS,
} from '../../config-manager.js';
import { applyConfigPatch } from '../../operator/config-patch.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { wasBackedUp, createMockStore } from './config-manager.fixtures.js';

describe('backfillSidebarRoomSections migration (rooms sidebar, DOR-525)', () => {
  it('adds both room-section collapse flags to an existing sidebar, expanded', () => {
    const store = createMockStore({
      ui: {
        theme: 'dark',
        sidebar: {
          pinned: ['/a'],
          groups: [],
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: true,
          groupsHintDismissed: false,
          muted: [],
          ungroupedDisplayFilter: 'all',
        },
      },
    });
    backfillSidebarRoomSections(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      sidebar: {
        pinned: ['/a'],
        groups: [],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: true,
        channelsCollapsed: false,
        dmsCollapsed: false,
        threadsCollapsed: false,
        groupsHintDismissed: false,
        muted: [],
        ungroupedDisplayFilter: 'all',
      },
    });
  });

  it('is idempotent — keeps a collapse choice the user already made', () => {
    const existing = {
      theme: 'system',
      sidebar: {
        pinned: [],
        groups: [],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        channelsCollapsed: true,
        dmsCollapsed: true,
        threadsCollapsed: true,
        groupsHintDismissed: false,
        muted: [],
        ungroupedDisplayFilter: 'all',
      },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillSidebarRoomSections(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when ui.sidebar is absent (schema default owns that case)', () => {
    const store = createMockStore({ ui: { theme: 'dark' } });
    backfillSidebarRoomSections(store);
    expect(store.data.ui).toEqual({ theme: 'dark' });
  });

  it('is a no-op when the ui section is absent entirely', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillSidebarRoomSections(store);
    expect(store.data.ui).toBeUndefined();
  });

  it('adds threadsCollapsed to a sidebar that already has the other two', () => {
    // The upgrade path that actually exists: a config written by a release that
    // shipped the Channels and Direct messages flags, reaching one that also has
    // a Threads section. The other two must keep whatever the person chose.
    const store = createMockStore({
      ui: {
        theme: 'dark',
        sidebar: {
          pinned: [],
          groups: [],
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          channelsCollapsed: true,
          dmsCollapsed: false,
          groupsHintDismissed: false,
          muted: [],
          ungroupedDisplayFilter: 'all',
        },
      },
    });
    backfillSidebarRoomSections(store);
    const sidebar = (store.data.ui as { sidebar: Record<string, unknown> }).sidebar;
    expect(sidebar.threadsCollapsed).toBe(false);
    expect(sidebar.channelsCollapsed).toBe(true);
    expect(sidebar.dmsCollapsed).toBe(false);
  });
});

describe('a populated pre-redesign sidebar through the real conf load path', () => {
  // The mock-store tests above cannot see the conf/Ajv seam, which is where the
  // expensive failure lives: the redesign REMOVES eight keys from a closed
  // object, so a config written by yesterday's release is schema-invalid the
  // moment the migration is skipped — and ConfigManager's recovery path then
  // replaces the WHOLE file, not just the sidebar.
  //
  // SERVER_VERSION resolves to `0.0.0` here (the dev/package.json fallback), so
  // no migration runs at all. That is what every `pnpm dev` does.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A config file holding a populated pre-redesign `ui.sidebar`. */
  function seedPreRedesign(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-pre-sidebar-redesign-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        // A privacy choice opposite to the defaults on both fields, so a silent
        // whole-file reset is visible rather than coincidentally identical.
        telemetry: { userHasDecided: true, install: false, heartbeat: false },
        ui: {
          theme: 'dark',
          sidebar: {
            pinned: [{ kind: 'agent', path: '/projects/alpha' }],
            groups: [],
            ungroupedSortMode: 'recent',
            ungroupedCollapsed: true,
            recentsCollapsed: true,
            channelsCollapsed: true,
            dmsCollapsed: true,
            threadsCollapsed: true,
            groupsHintDismissed: true,
            muted: [{ kind: 'agent', path: '/projects/beta' }],
            ungroupedDisplayFilter: 'active',
          },
        },
        __internal__: { migrations: { version: '0.58.0' } },
      })
    );
    return { dir, configPath };
  }

  it('is not condemned — no backup is written and the file is not replaced', () => {
    const { dir } = seedPreRedesign();
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
  });

  it('keeps every unrelated section, including a telemetry opt-out', () => {
    const { dir } = seedPreRedesign();
    const telemetry = new ConfigManager(dir).get('telemetry');
    expect(telemetry.userHasDecided).toBe(true);
    expect(telemetry.install).toBe(false);
    expect(telemetry.heartbeat).toBe(false);
  });

  it('reads the sidebar back with pins and mutes intact and the new blocks present', () => {
    const { dir } = seedPreRedesign();
    const sidebar = new ConfigManager(dir).getAll().ui.sidebar;
    expect(sidebar.pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
    expect(sidebar.muted).toEqual([{ kind: 'agent', path: '/projects/beta' }]);
    // conf hands back the stored object, not a Zod parse, so the retired keys
    // are still sitting there until something writes. Nothing reads them and
    // they are not on the exported type — this asserts what the SIDEBAR gets,
    // which is the fully-defaulted new shape.
    expect(sidebar.sections).toEqual({});
    expect(sidebar.gettingStarted).toEqual({ retired: [] });
    expect(sidebar.digest).toEqual({});
  });

  it('drops the retired keys on the first write, migration or no migration', () => {
    // `applyConfigPatch` re-validates the whole config with Zod, which is strict
    // and was deliberately never widened the way conf's Ajv schema was. So even
    // on an install the migration never reached, the file converges the moment
    // anything writes.
    const { dir, configPath } = seedPreRedesign();
    initConfigManager(dir);
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      ui: { sidebar: Record<string, unknown> };
    };
    expect('ungroupedCollapsed' in onDisk.ui.sidebar).toBe(false);
    expect('groupsHintDismissed' in onDisk.ui.sidebar).toBe(false);
    // …and the person's structure is still there.
    expect(onDisk.ui.sidebar.pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
  });

  it('carries every choice across when the migration does apply to the same file', () => {
    const { dir, configPath } = seedPreRedesign();
    const store = {
      get: (key: string) =>
        (JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>)[key],
      set: (key: string, value: unknown) => {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        raw[key] = value;
        fs.writeFileSync(configPath, JSON.stringify(raw));
      },
    };
    CONFIG_MIGRATIONS['0.59.0'](store);

    const sidebar = new ConfigManager(dir).getAll().ui.sidebar;
    expect(sidebar.sections).toEqual({
      agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' },
      channels: { collapsed: true },
      dms: { collapsed: true },
      threads: { collapsed: true },
      recents: { collapsed: true },
    });
    expect(sidebar.gettingStarted).toEqual({ retired: [GROUPS_HINT_SUGGESTION_ID] });
    expect(sidebar.pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
    expect(sidebar.muted).toEqual([{ kind: 'agent', path: '/projects/beta' }]);
    // Nothing was condemned on the way through.
    expect(wasBackedUp(dir)).toBe(false);
  });

  it('still condemns a section whose stored value is nonsense', () => {
    // The Ajv tolerance widens what yesterday's shape may contain. It must not
    // quietly become "validate nothing", so the section VALUE is still checked.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-bad-section-value-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { sidebar: { sections: { agents: { collapsed: true, sortMode: 'sideways' } } } },
      })
    );
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(true);
  });

  // ── A section id this build has never heard of ──
  //
  // THE most expensive failure this schema can have, and it is not a read
  // failure. conf's Ajv accepts an unknown `sections` key (`z.toJSONSchema`
  // emits no `propertyNames` on its 2019-09 target), so the config boots and is
  // never condemned — and then Zod refuses that key on the write path, where
  // `applyConfigPatch` re-validates the WHOLE config. The result is an install
  // that looks completely healthy and rejects every settings change forever.
  //
  // It is a live hazard rather than a hypothetical: `threads` and `recents` are
  // in the enum only while the pre-redesign sections still render, and P2
  // removes them. Every config THIS migration wrote them into would be the
  // casualty. `dropUnknownSectionIds` is what makes that narrowing a non-event.

  /** A config carrying a section id outside the enum, plus a real one. */
  function seedWithUnknownSection(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-unknown-section-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        ui: {
          theme: 'dark',
          sidebar: {
            pinned: [],
            groups: [],
            muted: [],
            sections: { channels: { collapsed: true }, bogus: { collapsed: true } },
          },
        },
      })
    );
    return dir;
  }

  it('keeps accepting WRITES when the stored sections name a section it does not know', () => {
    // The deliverable assertion. Without the read-time filter this is
    // `ok: false, "ui.sidebar.sections.bogus: Invalid key in record"`, and the
    // person can never change a setting again.
    const dir = seedWithUnknownSection();
    const manager = initConfigManager(dir);
    const result = applyConfigPatch({ ui: { theme: 'light' } });
    expect(result.ok, JSON.stringify('details' in result ? result.details : result)).toBe(true);
    expect(manager.getAll().ui.theme).toBe('light');
  });

  it('drops the unknown section on that write and keeps the known one', () => {
    // `ok: true` alone would still pass if the known section had gone with it.
    const dir = seedWithUnknownSection();
    const configPath = path.join(dir, 'config.json');
    initConfigManager(dir);
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      ui: { sidebar: { sections: Record<string, unknown> } };
    };
    expect(onDisk.ui.sidebar.sections).toEqual({ channels: { collapsed: true } });
  });

  it('is not condemned by the unknown section either', () => {
    const dir = seedWithUnknownSection();
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
  });

  it('accepts a config already in the new shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-post-sidebar-redesign-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: {
          sidebar: {
            pinned: [],
            groups: [],
            sections: { channels: { collapsed: true } },
            muted: [],
            gettingStarted: { retired: [GROUPS_HINT_SUGGESTION_ID] },
            digest: { lastShownDate: '2026-08-09' },
          },
        },
      })
    );
    const manager = new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
    expect(manager.getAll().ui.sidebar.sections).toEqual({ channels: { collapsed: true } });
    expect(manager.getAll().ui.sidebar.digest.lastShownDate).toBe('2026-08-09');
  });
});

describe('a pre-DOR-579 sidebar is converted the first time anything reads it (DOR-588)', () => {
  // DOR-579 renamed how membership is stored. For one release the schema was
  // widened so the old shape still loaded AND every read converted it, in the
  // server and again in the cockpit. DOR-588 keeps the widening — without it Ajv
  // deletes the retired key before anything can look at it — and replaces the
  // per-read conversion with one that runs once per process, on the first read
  // of `ui`, and writes itself through.
  //
  //   * a section's membership (`groups[].agentPaths`) is the case that made
  //     this a MAJOR: that file looks perfectly healthy and would otherwise load
  //     empty and save empty;
  //   * bare path strings in `pinned` / `muted` are converted the same way, in
  //     the same pass. They are the visible half — a person would notice pins
  //     that vanished — but converting them costs nothing extra once the pass
  //     exists, and losing them would be no better for being noticeable.
  //
  // These boot a REAL ConfigManager over a real file, which is the only way to
  // cross the conf/Ajv seam. SERVER_VERSION resolves to `0.0.0` here, so NO
  // migration runs at all — the worst case, on purpose.

  /** Everything old at once: the shape that is now condemned. */
  const fullyLegacyConfig = {
    version: 1,
    // A privacy choice, deliberately opposite to the defaults on both fields, so
    // the salvage below is visible rather than coincidentally identical.
    telemetry: { userHasDecided: true, install: false, heartbeat: false },
    ui: {
      theme: 'dark',
      sidebar: {
        pinned: ['/projects/alpha'],
        groups: [
          {
            id: 'g1',
            name: 'Clients',
            agentPaths: ['/projects/alpha', '/projects/gamma'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'manual',
          },
        ],
        muted: ['/projects/beta'],
      },
    },
  };

  /**
   * The shape that made this a MAJOR: everything a reader would look at first is
   * already canonical, and only the section's membership is not.
   */
  const groupOnlyLegacyConfig = {
    version: 1,
    ui: {
      sidebar: {
        pinned: [{ kind: 'agent', path: '/projects/alpha' }],
        muted: [{ kind: 'agent', path: '/projects/beta' }],
        groups: [
          {
            id: 'g1',
            name: 'Clients',
            agentPaths: ['/projects/alpha', '/projects/gamma'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'manual',
          },
        ],
      },
    },
  };

  function bootOver(config: unknown): { dir: string; configPath: string; manager: ConfigManager } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-pre-579-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(config));
    return { dir, configPath, manager: new ConfigManager(dir) };
  }

  const MEMBERS = [
    { kind: 'agent', path: '/projects/alpha' },
    { kind: 'agent', path: '/projects/gamma' },
  ];

  it('converts a config whose ONLY legacy part is a section’s membership', () => {
    // **The case a reader would not think to try, and the one that lost data.**
    // `pinned` and `muted` are already references here, so nothing about the
    // file looks old — and `agentPaths` loads, reads as an empty section, and is
    // written back empty by the next config change of any kind. Re-seed by
    // deleting the `SidebarGroupSchema` branch of `tolerateRetiredSidebarKeys`
    // (Ajv then strips the key before anything can convert it) or by returning
    // `ui` unchanged from `canonicalSidebar`; either way this goes red.
    const { manager } = bootOver(groupOnlyLegacyConfig);
    expect(manager.getAll().ui.sidebar.groups[0]!.items).toEqual(MEMBERS);
  });

  it('converts it on the ui section read alone, not just on the whole config', () => {
    // `GET /api/config` reads `configManager.get('ui')`, a different path from
    // `getAll()`. Both are read boundaries and both go through the conversion.
    const { manager } = bootOver(groupOnlyLegacyConfig);
    expect(manager.get('ui').sidebar.groups[0]!.items).toEqual(MEMBERS);
  });

  it('writes the conversion through, so the next boot has nothing to do', () => {
    const { manager, configPath } = bootOver(groupOnlyLegacyConfig);
    manager.getAll();
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      ui: { sidebar: { groups: Record<string, unknown>[] } };
    };
    expect(onDisk.ui.sidebar.groups[0]!.agentPaths).toBeUndefined();
    expect(onDisk.ui.sidebar.groups[0]!.items).toEqual(MEMBERS);
  });

  it('keeps the section through a patch that touches ui', () => {
    // `ok: true` alone would still pass if the members had been emptied on the
    // way through, which is exactly the failure this whole block is about.
    const { dir } = bootOver(groupOnlyLegacyConfig);
    const manager = initConfigManager(dir);
    expect(applyConfigPatch({ ui: { theme: 'dark' } }).ok).toBe(true);
    expect(manager.getAll().ui.sidebar.groups[0]!.items).toEqual(MEMBERS);
    expect(manager.getAll().ui.theme).toBe('dark');
  });

  it('converts a config where every list is still the old shape', () => {
    const { dir, manager } = bootOver(fullyLegacyConfig);
    // Not condemned: nothing about this file is unreadable, only old.
    expect(wasBackedUp(dir)).toBe(false);
    const sidebar = manager.getAll().ui.sidebar;
    expect(sidebar.pinned).toEqual([{ kind: 'agent', path: '/projects/alpha' }]);
    expect(sidebar.muted).toEqual([{ kind: 'agent', path: '/projects/beta' }]);
    expect(sidebar.groups[0]!.items).toEqual(MEMBERS);
  });

  it('keeps every unrelated section, including a telemetry opt-out', () => {
    // A rename must never cost somebody their privacy choice. A whole-file reset
    // would flip all three of these at once.
    const { manager } = bootOver(fullyLegacyConfig);
    const telemetry = manager.get('telemetry');
    expect(telemetry.userHasDecided).toBe(true);
    expect(telemetry.install).toBe(false);
    expect(telemetry.heartbeat).toBe(false);
  });

  it('leaves a config already in the canonical encoding untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-post-579-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: {
          sidebar: {
            pinned: [{ kind: 'agent', path: '/projects/alpha' }],
            groups: [{ id: 'g1', name: 'Clients', items: [{ kind: 'room', roomId: '01JROOM' }] }],
            muted: [],
          },
        },
      })
    );
    const manager = new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
    expect(manager.getAll().ui.sidebar.groups[0]!.items).toEqual([
      { kind: 'room', roomId: '01JROOM' },
    ]);
  });

  it('still rejects a genuinely invalid sidebar entry', () => {
    // The conversion handles one known shape. It must not become "accept
    // anything" — the next bad write would then land unnoticed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-invalid-579-'));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({ version: 1, ui: { sidebar: { pinned: [{ kind: 'nonsense' }] } } })
    );
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(true);
  });
});
