import { describe, it, expect } from 'vitest';
import Conf, { type Schema } from 'conf';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  backfillExtensionsApprovedToRun,
  seedExtensionsApprovedSources,
  backfillHarnessApprovedHooks,
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  seedHarnessAutoAdopt,
  seedHarnessGlobal,
  seedHarnessRefusedHooks,
} from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMockStore } from './config-manager.fixtures.js';

describe('backfillExtensionsApprovedToRun migration (DOR-516)', () => {
  it('seeds an EMPTY list, approving nothing the user already had installed', () => {
    // The whole point. Backfilling from `enabled` would read "the person once
    // toggled this on" as "the person reviewed this code", and an agent can turn an
    // extension on through an ungated route. An upgrade must never hand out an
    // approval nobody gave — the one click this costs an upgrading user is the
    // deliberate price.
    const store = createMockStore({
      extensions: { enabled: ['my-ext', 'another-ext'], disabled: ['marketplace'] },
    });
    backfillExtensionsApprovedToRun(store);
    expect(store.data.extensions).toEqual({
      enabled: ['my-ext', 'another-ext'],
      disabled: ['marketplace'],
      approvedToRun: [],
    });
  });

  it('is idempotent — leaves an existing approval list untouched', () => {
    const store = createMockStore({
      extensions: { enabled: ['my-ext'], disabled: [], approvedToRun: ['my-ext'] },
    });
    backfillExtensionsApprovedToRun(store);
    backfillExtensionsApprovedToRun(store);
    expect(store.data.extensions).toEqual({
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: ['my-ext'],
    });
  });

  it('skips when the extensions key is absent (no throw, no write)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillExtensionsApprovedToRun(store)).not.toThrow();
    expect(store.data.extensions).toBeUndefined();
  });

  it('repairs a non-array approvedToRun rather than trusting it', () => {
    const store = createMockStore({
      extensions: { enabled: [], disabled: [], approvedToRun: 'oops' },
    });
    backfillExtensionsApprovedToRun(store);
    expect(store.data.extensions).toEqual({ enabled: [], disabled: [], approvedToRun: [] });
  });

  it('leaves the migrated config parseable by the schema', () => {
    const store = createMockStore({ extensions: { enabled: ['my-ext'], disabled: [] } });
    backfillExtensionsApprovedToRun(store);
    const parsed = UserConfigSchema.parse({ version: 1, ...store.data });
    expect(parsed.extensions).toEqual({
      enabled: ['my-ext'],
      disabled: [],
      approvedToRun: [],
      approvedSources: {},
      approvedPermissions: {},
      dismissedApprovals: {},
      trustedSources: [],
    });
  });
});

describe('seedExtensionsApprovedSources migration (DOR-2383)', () => {
  it('seeds an EMPTY map and binds no existing approval to any copy', () => {
    // Which copy an id-only approval was for is a question about the disk, and a
    // migration runs before anything looked at it. The first discovery binds each
    // one to its direct install (`ExtensionManager.reload`); guessing here could
    // bind it to a copy the person never saw.
    const store = createMockStore({
      extensions: { enabled: ['flow'], disabled: [], approvedToRun: ['flow'] },
    });
    seedExtensionsApprovedSources(store);
    expect(store.data.extensions).toEqual({
      enabled: ['flow'],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: {},
    });
  });

  it('is idempotent — leaves recorded copies untouched', () => {
    const extensions = {
      enabled: [],
      disabled: [],
      approvedToRun: ['flow'],
      approvedSources: {
        flow: { path: '/h/.dork/plugins/flow/.dork/extensions/flow', plugin: 'flow' },
      },
    };
    const store = createMockStore({ extensions });
    seedExtensionsApprovedSources(store);
    seedExtensionsApprovedSources(store);
    expect(store.data.extensions).toEqual(extensions);
  });

  it('skips when the extensions key is absent (no throw, no write)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => seedExtensionsApprovedSources(store)).not.toThrow();
    expect(store.data.extensions).toBeUndefined();
  });

  it('repairs a non-object approvedSources rather than trusting it', () => {
    const store = createMockStore({
      extensions: { enabled: [], disabled: [], approvedToRun: [], approvedSources: ['oops'] },
    });
    seedExtensionsApprovedSources(store);
    expect(store.data.extensions).toEqual({
      enabled: [],
      disabled: [],
      approvedToRun: [],
      approvedSources: {},
    });
  });
});

describe('backfillHarnessApprovedHooks migration (DOR-522)', () => {
  it('seeds an EMPTY list, allowing nothing an installed package already wanted to run', () => {
    // Same choice, and the same reason, as the extension approval list: an
    // upgrade must never hand out an approval nobody gave. Anyone already running
    // a hook-shipping plugin is asked once, on their next install.
    const store = createMockStore({ harness: { autoSync: true } });
    backfillHarnessApprovedHooks(store);
    expect(store.data.harness).toEqual({ autoSync: true, approvedHooks: [] });
  });

  it('is idempotent — leaves an existing list untouched', () => {
    const store = createMockStore({ harness: { autoSync: false, approvedHooks: ['flow@abc'] } });
    backfillHarnessApprovedHooks(store);
    backfillHarnessApprovedHooks(store);
    expect(store.data.harness).toEqual({ autoSync: false, approvedHooks: ['flow@abc'] });
  });

  it('skips when the harness key is absent (no throw, no write)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillHarnessApprovedHooks(store)).not.toThrow();
    expect(store.data.harness).toBeUndefined();
  });

  it('repairs a non-array approvedHooks rather than trusting it', () => {
    const store = createMockStore({ harness: { autoSync: true, approvedHooks: 'oops' } });
    backfillHarnessApprovedHooks(store);
    expect(store.data.harness).toEqual({ autoSync: true, approvedHooks: [] });
  });

  it('leaves the migrated config parseable by the schema', () => {
    const store = createMockStore({ harness: { autoSync: true } });
    backfillHarnessApprovedHooks(store);
    const parsed = UserConfigSchema.parse({ version: 1, ...store.data });
    expect(parsed.harness).toEqual({
      autoSync: true,
      autoAdopt: false,
      approvedHooks: [],
      refusedHooks: [],
      approvedFolderConfig: [],
      approvedFolderConfigParts: {},
      refusedFolderConfig: [],
      folderConfigPinned: false,
      // Repo and worktree settings outside an agent home (DOR-3298).
      approvedRepoConfig: [],
      refusedRepoConfig: [],
      repoBaselines: {},
      repoBaselinesPinned: false,
      global: { harnesses: [], askedAt: null },
    });
  });
});

describe('seedHarnessRefusedHooks migration (DOR-1849)', () => {
  it('reserves the leaf on a `harness` block that predates it', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `harness` block never inherits the new
    // leaf on its own. Drop the body and it reads `undefined`.
    const store = createMockStore({ harness: { autoSync: true, approvedHooks: ['flow@abc'] } });
    seedHarnessRefusedHooks(store);
    expect(store.data.harness).toEqual({
      autoSync: true,
      approvedHooks: ['flow@abc'],
      refusedHooks: [],
    });
  });

  it("seeds an EMPTY list, so an upgrade turns nothing down on a person's behalf", () => {
    // The mirror image of `backfillHarnessApprovedHooks`: an upgrade must not
    // hand out an approval nobody gave, and it must not record a refusal nobody
    // made either. Everything a person has not decided about stays undecided,
    // which is what makes the CLI ask rather than assume.
    const store = createMockStore({ harness: { autoSync: false } });
    seedHarnessRefusedHooks(store);
    expect(store.data.harness).toEqual({ autoSync: false, refusedHooks: [] });
  });

  it('never overwrites a list already on file (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // erasing refusals somebody made, which would silently re-arm every package
    // they turned down.
    const store = createMockStore({
      harness: { autoSync: true, approvedHooks: [], refusedHooks: ['evil@abc'] },
    });
    seedHarnessRefusedHooks(store);
    seedHarnessRefusedHooks(store);
    expect(store.data.harness).toEqual({
      autoSync: true,
      approvedHooks: [],
      refusedHooks: ['evil@abc'],
    });
  });

  it('repairs a non-array refusedHooks rather than trusting it', () => {
    const store = createMockStore({ harness: { autoSync: true, refusedHooks: 'oops' } });
    seedHarnessRefusedHooks(store);
    expect(store.data.harness).toEqual({ autoSync: true, refusedHooks: [] });
  });

  it('does nothing when there is no `harness` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `harness` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => seedHarnessRefusedHooks(store)).not.toThrow();
    expect(store.data.harness).toBeUndefined();
  });

  it('a real pre-0.75.0 config file gains harness.refusedHooks on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedRoomRepoDefaults` above for the DOR-1496 measurement this shape comes
    // from). `harness.refusedHooks` is a nested-leaf case, so this body is the
    // ONLY thing that puts the leaf on the file: suppress it and this goes red
    // while `store.get('harness').refusedHooks` still answers `[]` from Ajv's
    // discarded copy.
    //
    // `projectVersion` is stated explicitly because `SERVER_VERSION` resolves to
    // `0.0.0` in a dev tree, which runs no migration at all.
    const dir = path.join(os.tmpdir(), 'test-dork-refused-hooks-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          harness: { autoSync: false, approvedHooks: ['flow@abc'] },
          __internal__: { migrations: { version: '0.74.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.75.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        harness: Record<string, unknown>;
      };
      expect(onDisk.harness.refusedHooks).toEqual([]);
      // The upgrade adds a leaf; it changes nothing the person had set.
      expect(onDisk.harness.autoSync).toBe(false);
      expect(onDisk.harness.approvedHooks).toEqual(['flow@abc']);
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedHarnessGlobal migration (DOR-1924, case 9)', () => {
  it('adds harness.global to a stored section that has the three older leaves and nothing else', () => {
    // The upgrade path this key exists for: somebody who already has a `harness`
    // section gains ONE member and keeps every answer they gave. conf's
    // pre-write merge is shallow, so a stored `harness` object wins wholesale
    // and never gains a nested leaf on its own.
    const store = createMockStore({
      harness: { autoSync: false, approvedHooks: ['flow@abc'], refusedHooks: ['evil@def'] },
    });
    seedHarnessGlobal(store);
    expect(store.data.harness).toEqual({
      autoSync: false,
      approvedHooks: ['flow@abc'],
      refusedHooks: ['evil@def'],
      global: { harnesses: [], askedAt: null },
    });
  });

  it('seeds the door CLOSED and the question UNASKED', () => {
    // Both halves matter and they are different claims. An empty `harnesses`
    // list means an upgrade shares nothing into a home directory that was not
    // shared before; `askedAt: null` means the upgrade did not answer the
    // question either, so the CLI still asks once.
    const store = createMockStore({ harness: { autoSync: true } });
    seedHarnessGlobal(store);
    expect(store.data.harness).toEqual({
      autoSync: true,
      global: { harnesses: [], askedAt: null },
    });
  });

  it('never overwrites an answer already on file (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // forgetting which agent tools somebody shared with, which would strand
    // every link DorkOS put in their home directory (the sweep only looks in
    // directories the CURRENT plan targets).
    const store = createMockStore({
      harness: {
        autoSync: true,
        global: { harnesses: ['codex'], askedAt: '2026-09-09T00:00:00.000Z' },
      },
    });
    seedHarnessGlobal(store);
    seedHarnessGlobal(store);
    expect(store.data.harness).toEqual({
      autoSync: true,
      global: { harnesses: ['codex'], askedAt: '2026-09-09T00:00:00.000Z' },
    });
  });

  it('repairs a non-object global rather than trusting it', () => {
    const store = createMockStore({ harness: { autoSync: true, global: 'oops' } });
    seedHarnessGlobal(store);
    expect(store.data.harness).toEqual({
      autoSync: true,
      global: { harnesses: [], askedAt: null },
    });
  });

  it('does nothing when there is no `harness` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `harness` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => seedHarnessGlobal(store)).not.toThrow();
    expect(store.data.harness).toBeUndefined();
  });

  it('a real pre-0.77.0 config file gains harness.global on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedRoomRepoDefaults` above for the DOR-1496 measurement this shape comes
    // from). `harness.global` is a nested-leaf case, so this body is the ONLY
    // thing that puts the leaf on the file: suppress it and this goes red while
    // `store.get('harness').global` still answers the default from Ajv's
    // discarded copy.
    //
    // `projectVersion` is stated explicitly because `SERVER_VERSION` resolves to
    // `0.0.0` in a dev tree, which runs no migration at all.
    const dir = path.join(os.tmpdir(), 'test-dork-harness-global-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          harness: { autoSync: false, approvedHooks: ['flow@abc'], refusedHooks: [] },
          __internal__: { migrations: { version: '0.76.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.77.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        harness: Record<string, unknown>;
      };
      expect(onDisk.harness.global).toEqual({ harnesses: [], askedAt: null });
      // The upgrade adds a leaf; it changes nothing the person had set.
      expect(onDisk.harness.autoSync).toBe(false);
      expect(onDisk.harness.approvedHooks).toEqual(['flow@abc']);
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedHarnessAutoAdopt migration (DOR-1853, case 25)', () => {
  it('adds harness.autoAdopt to a stored section that has the four older leaves and nothing else', () => {
    // The upgrade path this key exists for: somebody who already has a `harness`
    // section gains ONE member and keeps every answer they gave. conf's
    // pre-write merge is shallow, so a stored `harness` object wins wholesale
    // and never gains a nested leaf on its own.
    const store = createMockStore({
      harness: {
        autoSync: false,
        approvedHooks: ['flow@abc'],
        refusedHooks: ['evil@def'],
        global: { harnesses: [], askedAt: null },
      },
    });
    seedHarnessAutoAdopt(store);
    expect(store.data.harness).toEqual({
      autoSync: false,
      autoAdopt: false,
      approvedHooks: ['flow@abc'],
      refusedHooks: ['evil@def'],
      global: { harnesses: [], askedAt: null },
    });
  });

  it('seeds the gate CLOSED', () => {
    // The whole posture in one assertion: upgrading must never start moving a
    // person's own skill folders on their behalf.
    const store = createMockStore({ harness: { autoSync: true } });
    seedHarnessAutoAdopt(store);
    expect(store.data.harness).toEqual({ autoSync: true, autoAdopt: false });
  });

  it('never overwrites an answer already on file (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // switching off automatic adoption for somebody who turned it on.
    const store = createMockStore({ harness: { autoSync: true, autoAdopt: true } });
    seedHarnessAutoAdopt(store);
    seedHarnessAutoAdopt(store);
    expect(store.data.harness).toEqual({ autoSync: true, autoAdopt: true });
  });

  it('repairs a non-boolean autoAdopt rather than trusting it', () => {
    const store = createMockStore({ harness: { autoSync: true, autoAdopt: 'yes' } });
    seedHarnessAutoAdopt(store);
    expect(store.data.harness).toEqual({ autoSync: true, autoAdopt: false });
  });

  it('does nothing when there is no `harness` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `harness` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => seedHarnessAutoAdopt(store)).not.toThrow();
    expect(store.data.harness).toBeUndefined();
  });

  it('a real pre-0.78.0 config file gains harness.autoAdopt on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach (see
    // `seedRoomRepoDefaults` above for the DOR-1496 measurement this shape comes
    // from). `harness.autoAdopt` is a nested-leaf case, so this body is the ONLY
    // thing that puts the leaf on the file: suppress it and this goes red while
    // `store.get('harness').autoAdopt` still answers `false` from Ajv's
    // discarded copy.
    //
    // `projectVersion` is stated explicitly because `SERVER_VERSION` resolves to
    // `0.0.0` in a dev tree, which runs no migration at all.
    const dir = path.join(os.tmpdir(), 'test-dork-auto-adopt-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          harness: {
            autoSync: false,
            approvedHooks: ['flow@abc'],
            refusedHooks: [],
            global: { harnesses: [], askedAt: null },
          },
          __internal__: { migrations: { version: '0.77.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.78.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        harness: Record<string, unknown>;
      };
      expect(onDisk.harness.autoAdopt).toBe(false);
      // The upgrade adds a leaf; it changes nothing the person had set.
      expect(onDisk.harness.autoSync).toBe(false);
      expect(onDisk.harness.approvedHooks).toEqual(['flow@abc']);
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
