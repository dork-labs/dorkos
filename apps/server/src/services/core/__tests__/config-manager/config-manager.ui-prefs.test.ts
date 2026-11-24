import { describe, it, expect } from 'vitest';
import Conf, { type Schema } from 'conf';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  migrateStatusBarToPins,
  backfillComposerPrefs,
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  backfillNotificationDefaults,
  backfillPromoDismissals,
  seedMemoryProviderDefault,
  seedUiPanelTabs,
} from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMockStore } from './config-manager.fixtures.js';

describe('backfillPromoDismissals migration (sidebar-simplification D4)', () => {
  it('reserves ui.promos on a `ui` block that predates it', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `ui` block never inherits the new nested
    // section on its own. Drop the body and this reads `undefined`.
    const store = createMockStore({ ui: { theme: 'dark', dismissedUpgradeVersions: ['0.1.0'] } });
    backfillPromoDismissals(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      dismissedUpgradeVersions: ['0.1.0'],
      promos: { dismissedIds: [] },
    });
  });

  it('never erases a dismissal it finds (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // seeding `[]` over ids the person had already waved away, so every promo
    // they dismissed would come back.
    const store = createMockStore({ ui: { promos: { dismissedIds: ['remote-access'] } } });
    backfillPromoDismissals(store);
    expect(store.data.ui).toEqual({ promos: { dismissedIds: ['remote-access'] } });
  });

  it('does nothing when there is no `ui` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `ui` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    backfillPromoDismissals(store);
    expect(store.data.ui).toBeUndefined();
  });

  it('a real pre-0.63.0 config file gains ui.promos on disk (full conf path)', () => {
    // The half the mock store cannot reach, and the half a `getDot` assertion
    // cannot reach either. `backfillPromoDismissals` was documented for a while
    // as a no-op anchor — something Ajv's `useDefaults` would supply whether or
    // not it ran — and no test contradicted that, because none of them looked at
    // the file. Measured in DOR-1496, the claim is false: conf's `store` getter
    // re-parses `config.json` on every access and validates the throwaway copy
    // it is about to return, so `useDefaults` fills `ui.promos` into that copy
    // and the copy is discarded, and conf's own `defaults` merge is shallow, so
    // a `ui` object already on disk never gains a new member from it. This body
    // is the only thing that puts the section on the file.
    //
    // The counterfactual, measured both ways: suppress the body and this case
    // goes red, while the same upgrade boot read back as `store.get('ui').promos`
    // still answers `{ dismissedIds: [] }`. That in-memory form is what the
    // "anchor" belief rested on, and it could not have told the two apart.
    //
    // `projectVersion` is stated explicitly because `SERVER_VERSION` resolves to
    // `0.0.0` in a dev tree, which runs no migration at all.
    const dir = path.join(os.tmpdir(), 'test-dork-promos-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          ui: { theme: 'dark', statusBar: { pins: ['git'] } },
          __internal__: { migrations: { version: '0.62.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        // The shipped schema, tolerances included — never rebuilt here (see CONF_JSON_SCHEMA).
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.63.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        ui: Record<string, unknown>;
      };
      expect(onDisk.ui.promos).toEqual({ dismissedIds: [] });
      // The upgrade adds a section; it changes nothing the person had set.
      expect(onDisk.ui.theme).toBe('dark');
      expect(onDisk.ui.statusBar).toEqual({ pins: ['git'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillNotificationDefaults migration (notification-system, DOR-1385)', () => {
  it('seeds the whole section on a config that predates it', () => {
    // Unlike the nested backfills above, there is no partial block to merge
    // into: `notifications` is a new top-level section, so the body writes it
    // whole. Drop it and an upgrading install reads `undefined` until Ajv's
    // `useDefaults` fills it in.
    const store = createMockStore({ ui: { theme: 'dark' } });
    backfillNotificationDefaults(store);
    expect(store.data.notifications).toEqual({
      escalation: { phoneAfterMinutes: 2 },
      sounds: { knock: true, allClear: true, turnEnd: false },
      notifyOnTurnCompleteWhileAway: true,
      browserPermissionPrimerDismissed: false,
    });
  });

  it('never overwrites choices it finds (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // re-seeding the defaults over a person who had turned the knock off and
    // told DorkOS never to ring their phone.
    const chosen = {
      escalation: { phoneAfterMinutes: 'never' },
      sounds: { knock: false, allClear: false, turnEnd: true },
      notifyOnTurnCompleteWhileAway: false,
      browserPermissionPrimerDismissed: true,
    };
    const store = createMockStore({ notifications: chosen });
    backfillNotificationDefaults(store);
    expect(store.data.notifications).toBe(chosen);
  });
});

describe('seedMemoryProviderDefault migration (agent-memory, DOR-1533)', () => {
  it('seeds the whole section on a config that predates it', () => {
    // Same shape as `backfillNotificationDefaults` above, and the same caveat:
    // `memory` is a new TOP-LEVEL section, so conf's own defaults pre-write
    // lands it on a real file whatever this body does. What is asserted here is
    // the body's own behaviour in isolation — that it writes the schema's
    // default rather than a literal of its own, so the table can never document
    // an intent that differs from what ships.
    const store = createMockStore({ ui: { theme: 'dark' } });
    seedMemoryProviderDefault(store);
    expect(store.data.memory).toEqual({ provider: 'builtin' });
  });

  it('never overwrites a backend somebody chose (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // moving an operator off the memory backend they configured, which would
    // point every agent at an empty file and read to them as amnesia.
    const chosen = { provider: 'acme-vectors' };
    const store = createMockStore({ memory: chosen });
    seedMemoryProviderDefault(store);
    expect(store.data.memory).toBe(chosen);
  });
});

describe('seedUiPanelTabs migration (DOR-2867)', () => {
  it('reserves an empty list on a `ui` block that predates it', () => {
    const store = createMockStore({ ui: { theme: 'dark', composer: { richText: true } } });
    seedUiPanelTabs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', composer: { richText: true }, panelTabs: [] });
  });

  it('keeps a saved placement, and writes nothing (idempotent)', () => {
    const saved = [{ tab: 'social-queue:queue', show: { agents: ['a'], rooms: [], pages: [] } }];
    const store = createMockStore({ ui: { panelTabs: saved } });
    seedUiPanelTabs(store);
    expect(store.writes).toEqual([]);
    expect(store.data.ui).toEqual({ panelTabs: saved });
  });

  it('a real pre-0.112.0 config file gains the leaf on disk (full conf path)', () => {
    const dir = path.join(os.tmpdir(), 'test-dork-ui-panel-tabs-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const { panelTabs: _drop, ...uiWithout } = USER_CONFIG_DEFAULTS.ui;
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          ui: { ...uiWithout, theme: 'dark' },
          __internal__: { migrations: { version: '0.111.0' } },
        }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.112.0',
        migrations: CONFIG_MIGRATIONS,
      });
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        ui: Record<string, unknown>;
      };
      expect(onDisk.ui).toHaveProperty('panelTabs', []);
      expect(onDisk.ui.theme).toBe('dark');
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migrateStatusBarToPins migration (DOR-431, DOR-452)', () => {
  /** The retired ten-boolean visibility shape, only ever written pre-release. */
  const RETIRED_TOGGLES = {
    cwd: true,
    git: true,
    runtime: true,
    model: true,
    cache: true,
    context: true,
    usage: true,
    permission: true,
    sound: true,
    polling: true,
  };

  it('fresh install: the schema default seeds ui.statusBar with nothing pinned', () => {
    // A brand-new config comes from the schema, not a migration — the quiet line
    // starts with no pins at all.
    expect(USER_CONFIG_DEFAULTS.ui.statusBar).toEqual({ pins: [] });
  });

  it('upgraded install: adds ui.statusBar to an existing ui block, preserving other ui fields', () => {
    const store = createMockStore({
      ui: {
        theme: 'dark',
        dismissedUpgradeVersions: ['1.0.0'],
        sidebar: { pinned: [], groups: [] },
        shapes: { active: null, agentDefaults: {}, autoFollowAgent: false },
      },
    });
    migrateStatusBarToPins(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      dismissedUpgradeVersions: ['1.0.0'],
      sidebar: { pinned: [], groups: [] },
      shapes: { active: null, agentDefaults: {}, autoFollowAgent: false },
      statusBar: { pins: [] },
    });
  });

  it('replaces the retired ten-boolean shape with an empty pin list — a deliberate one-time reset', () => {
    // The semantics inverted: the booleans were "hide this", pins are "always
    // show this". Mapping visible→pinned would hand anyone on the defaults ten
    // pins and erase the quiet line, so the old choices are dropped, not
    // translated (spec composer-status-redesign §5.1).
    const store = createMockStore({
      ui: { theme: 'system', statusBar: { ...RETIRED_TOGGLES, git: false, model: false } },
    });
    migrateStatusBarToPins(store);
    expect(store.data.ui).toEqual({ theme: 'system', statusBar: { pins: [] } });
  });

  it('is idempotent — never clears pins someone already chose', () => {
    const existing = {
      theme: 'system',
      dismissedUpgradeVersions: [],
      statusBar: { pins: ['git', 'usage'] },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    migrateStatusBarToPins(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when the ui section is absent (the defaults merge owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    migrateStatusBarToPins(store);
    expect(store.data.ui).toBeUndefined();
  });

  it('leaves no shape behind that the schema would reject', () => {
    // conf validates the WHOLE store once migrations finish, and `ui.statusBar`
    // is a closed object requiring `pins`. Parsing the post-migration `ui`
    // through the schema is the guard that a stale boolean can never survive
    // into that final validation and hard-fail startup.
    const store = createMockStore({
      ui: {
        theme: 'dark',
        dismissedUpgradeVersions: [],
        sidebar: {},
        shapes: {},
        statusBar: RETIRED_TOGGLES,
      },
    });
    migrateStatusBarToPins(store);
    const parsed = UserConfigSchema.parse({ version: 1, ui: store.data.ui });
    expect(parsed.ui.statusBar).toEqual({ pins: [] });
  });

  it('is registered in CONFIG_MIGRATIONS under the 0.57.0 composite', () => {
    // The key is shared with the DOR-501 `approvals` backfill (an object literal
    // cannot repeat a key), so this asserts the EFFECT rather than the identity
    // of the function: composing must not drop either body.
    //
    // It used to assert that 0.57.0 was the LAST key in the table, which stopped
    // meaning anything the moment v0.57.0 shipped: every migration after it is
    // authored under a newer key by the rule on CONFIG_MIGRATIONS, so "newest"
    // now goes stale on every release rather than catching anything.
    expect(Object.keys(CONFIG_MIGRATIONS)).toContain('0.57.0');

    const store = createMockStore({ ui: { theme: 'dark' } });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect(store.data.ui).toMatchObject({ statusBar: { pins: [] } });
    expect(store.data.approvals).toEqual({
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    // The connector-completion `connectors` backfill rides the same composite.
    expect(store.data.connectors).toEqual({ rawMcpServers: [] });
  });

  it('composes the autonomy-acknowledgement backfill into the same key', () => {
    // The standing Full-autonomy acknowledgement (spec `trust-dial`, decision 5)
    // rides this composite too — asserted by effect, since the key is shared.
    const store = createMockStore({ ui: { theme: 'dark' } });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect(store.data.ui).toMatchObject({ autonomyAcknowledgedAt: null });
  });

  it('composes the claude-code-accounts backfill into the same key', () => {
    // `runtimes.claudeCode` rides this composite too, and a stored `runtimes`
    // block is the case it exists for — conf's shallow defaults-merge never
    // reaches inside one.
    const store = createMockStore({
      runtimes: { default: 'claude-code', codex: { enabled: true, binaryPath: null } },
    });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      // The trust-stop backfill rides the same composite, last of the three.
      defaultTrustStop: null,
      // The execution-defaults backfill rides the same composite, and rides it
      // AFTER the section above exists.
      codex: {
        enabled: true,
        binaryPath: null,
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      },
      claudeCode: {
        activeAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      },
    });
  });
});

describe('backfillComposerPrefs migration (composer-rich-text, DOR-948)', () => {
  it('fresh install: the schema default seeds ui.composer with rich text ON', () => {
    // A brand-new config comes from the schema, not a migration — and since the
    // owner's 2026-08-12 call it lands on the formatting box.
    expect(USER_CONFIG_DEFAULTS.ui.composer).toEqual({ richText: true });
  });

  it('upgraded install: adds ui.composer to an existing ui block, preserving other ui fields', () => {
    // The case the migration exists for: conf's defaults-merge is SHALLOW, so a
    // `ui` object already on disk never grows a newly-added nested section.
    const store = createMockStore({
      ui: {
        theme: 'dark',
        dismissedUpgradeVersions: ['1.0.0'],
        statusBar: { pins: ['git'] },
      },
    });
    backfillComposerPrefs(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      dismissedUpgradeVersions: ['1.0.0'],
      statusBar: { pins: ['git'] },
      composer: { richText: true },
    });
  });

  it('is idempotent — never overwrites a preference someone already set', () => {
    // `false` is the interesting direction now that the seed is `true`: this is
    // somebody who turned formatting OFF, and an upgrade must not turn it back
    // on under them.
    const existing = { theme: 'system', composer: { richText: false } };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillComposerPrefs(store);
    backfillComposerPrefs(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when the ui section is absent (the defaults merge owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillComposerPrefs(store);
    expect(store.data.ui).toBeUndefined();
  });

  it.each([
    ['an array', []],
    ['a string', 'true'],
    ['a number', 1],
    ['an object of the wrong shape', { rich: 'yes' }],
  ])('replaces a stored ui.composer that is %s', (_label, stored) => {
    // `typeof [] === 'object'`, so a shape check that only asks "is it an
    // object?" leaves an array in place and conf's Ajv then condemns the whole
    // file on the next boot — the DOR-584 lesson. The schema is the only honest
    // judge of whether what is on disk is a ComposerPrefs.
    const store = createMockStore({ ui: { theme: 'dark', composer: stored } });
    backfillComposerPrefs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', composer: { richText: true } });
  });

  it('leaves a shape the schema accepts', () => {
    // conf validates the WHOLE store once migrations finish, and `ui.composer`
    // is a closed object. Parsing the post-migration `ui` through the schema is
    // the guard that this backfill can never hard-fail startup.
    const store = createMockStore({ ui: { theme: 'dark', dismissedUpgradeVersions: [] } });
    backfillComposerPrefs(store);
    const parsed = UserConfigSchema.parse({ version: 1, ui: store.data.ui });
    expect(parsed.ui.composer).toEqual({ richText: true });
  });

  it('seeds the same value the schema default declares', () => {
    // The seed and the default have to agree, and this is the assertion that
    // says so rather than two literals that happen to match. The body was
    // EDITED from `false` to `true` on the owner's 2026-08-12 call instead of
    // being superseded by a second key, which is sound only because 0.59.0 is
    // untagged — the test below is what notices if it ever ships.
    const store = createMockStore({ ui: { theme: 'dark' } });
    backfillComposerPrefs(store);
    expect((store.data.ui as { composer: unknown }).composer).toEqual(
      USER_CONFIG_DEFAULTS.ui.composer
    );
  });

  it('is registered in CONFIG_MIGRATIONS under a key above the tag it shipped after', () => {
    // This body rides `0.59.0`, which is no longer the LAST key — RP8 opened
    // `0.60.0` above it once v0.59.0 was tagged. What matters here is unchanged:
    // this body is registered under the key it was written for, and running that
    // key applies it. The migration-safety guard is what enforces the rule about
    // which key a NEW body may use.
    expect(Object.keys(CONFIG_MIGRATIONS)).toContain('0.59.0');

    const store = createMockStore({ ui: { theme: 'dark' } });
    CONFIG_MIGRATIONS['0.59.0'](store);
    expect(store.data.ui).toMatchObject({ composer: { richText: true } });
  });
});
