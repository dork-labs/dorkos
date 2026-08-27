import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Conf, { type Schema } from 'conf';
import { z } from 'zod';
import * as semver from 'semver';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  initConfigManager,
  backfillExtensionsDisabled,
  backfillExtensionsApprovedToRun,
  backfillHarnessApprovedHooks,
  backfillHarnessDefaults,
  backfillSidebarDefaults,
  backfillShapesDefaults,
  migrateStatusBarToPins,
  backfillComposerPrefs,
  backfillAutonomyAcknowledgement,
  backfillSidebarSettingsDefaults,
  backfillSidebarRoomSections,
  backfillRoomsDefaults,
  backfillWelcomeBackDefaults,
  backfillConnectorsDefaults,
  backfillClaudeCodeRuntimeDefaults,
  backfillSmartGroupKindDefaults,
  migrateSidebarMembersToItemRefs,
  migrateSidebarSectionPrefs,
  CONF_JSON_SCHEMA,
  GROUPS_HINT_SUGGESTION_ID,
  CONFIG_MIGRATIONS,
  backfillRuntimesDefaults,
  backfillAuthDefaults,
  backfillApprovalsDefaults,
  backfillCloudDefaults,
  backfillWorkbenchDefaults,
  backfillWorkbenchTerminalGraceTtl,
  backfillWorkbenchAutoOpenDiff,
  dropTunnelPasscodeAndSessionSecret,
  backfillProvidersDefaults,
  generalizeTelemetryConsent,
  backfillTelemetryLastPromptedVersion,
  applyTier1OptOutDefaults,
  applyTier1OptInDefaults,
  backfillTelemetryUsageChannel,
  backfillTelemetryLinkAnalyticsToAccount,
  backfillTelemetryAiMetadataChannel,
  scrubRetiredOnboardingSteps,
  backfillProfileDefaults,
  backfillRuntimeExecutionDefaults,
  backfillDefaultTrustStops,
  backfillClaudeCodePersistentSession,
  backfillNotificationDefaults,
  migrateClaudeAccountRegistry,
  backfillPromoDismissals,
  seedFullPowerDecision,
  raiseSchedulerConcurrencyFloor,
  warmClaudeCodeSessionsByDefault,
  seedMemoryProviderDefault,
  seedRoomRepoDefaults,
} from '../config-manager.js';
import { applyConfigPatch } from '../operator/config-patch.js';
import { checkMigrationSafety, extractMigrationBodies } from './migration-safety.js';
import { checkAppendOnly, migrationClosure } from './migration-append-only.js';
import { MERGED_MIGRATION_HASHES } from './merged-migration-hashes.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * Expected `runtimes` section defaults (spec: additional-agent-runtimes +
 * effortless-runtime-switching T1 credential fields + claude-code-accounts).
 */
const RUNTIMES_DEFAULTS = {
  default: 'claude-code',
  defaultTrustStop: null,
  claudeCode: {
    defaultAccount: null,
    accounts: [],
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
    // On: a chat's agent stays running between messages. Graduated out of
    // Experiments and flipped by the schema default (spec
    // `full-power-defaults`, D1); the `0.59.0` backfill that seeded it OFF is
    // unchanged and still pinned below.
    persistentSession: true,
  },
  opencode: {
    enabled: true,
    binaryPath: null,
    port: 0,
    provider: null,
    baseURL: null,
    // No `defaultEffort`: OpenCode's API accepts no effort at all.
    defaultModel: null,
    defaultTrustStop: null,
  },
  codex: {
    enabled: true,
    binaryPath: null,
    credentialRef: null,
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
  },
};

/**
 * Whether a config file in this directory has been backed up and replaced.
 *
 * Backups are timestamped and rotated (DOR-1221), so there is no one name to
 * look for. Matched by suffix rather than by the production module's own
 * pattern, so a change to the naming shows up here as a result rather than
 * being agreed with.
 *
 * @param dir - The data directory holding `config.json`.
 */
function wasBackedUp(dir: string): boolean {
  return fs.readdirSync(dir).some((name) => name.endsWith('.bak'));
}

/** Minimal stand-in for the `conf` store used by migration bodies. */
function createMockStore(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: (key: string) => data[key],
    has: (key: string) => data[key] !== undefined,
    set: (key: string, value: unknown) => {
      data[key] = value;
    },
    delete: (key: string) => {
      delete data[key];
    },
  };
}

describe('ConfigManager', () => {
  const testDir = path.join(os.tmpdir(), 'test-dork-config-' + Date.now());
  const configPath = path.join(testDir, 'config.json');

  beforeEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it('creates config file on first run', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.isFirstRun).toBe(true);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('detects existing config file', () => {
    // Create first instance
    initConfigManager(testDir);
    // Create second instance
    const configManager = initConfigManager(testDir);
    expect(configManager.isFirstRun).toBe(false);
  });

  it('returns default values on first run', () => {
    const configManager = initConfigManager(testDir);
    const config = configManager.getAll();

    expect(config.version).toBe(1);
    expect(config.server.port).toBe(4242);
    expect(config.server.cwd).toBe(null);
    expect(config.tunnel.enabled).toBe(false);
    expect(config.ui.theme).toBe('system');
  });

  it('keeps promo dismissals a person already has across a real load', () => {
    // Over a real file and the real conf/Ajv seam, which is the only place this
    // can be settled: Zod strips unknown keys where Ajv REJECTS them, and a
    // rejected file is replaced wholesale. So what this catches is the schema
    // shape being wrong for the data the cockpit writes — the dismissals would
    // not merely read empty, the person's whole config would be reset behind
    // them. (It deliberately does NOT claim to exercise the migration: Ajv's
    // `useDefaults` supplies `ui.promos` on read whether or not the migration
    // runs, which is measured, and is why the migration is documented as an
    // anchor rather than as the thing that makes the field reachable.)
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark', promos: { dismissedIds: ['remote-access'] } },
        __internal__: { migrations: { version: '0.62.0' } },
      })
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.getDot('ui.promos.dismissedIds')).toEqual(['remote-access']);
    expect(configManager.get('ui').theme).toBe('dark');
  });

  it('fills in notification preferences for a config written before they existed', () => {
    // The upgrade path over a real file and the real conf/Ajv seam, not a mock
    // store: this is a whole new top-level SECTION, and the failure it guards
    // against is the file being condemned rather than the section reading empty.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.63.0' } },
      })
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.get('notifications')).toEqual({
      escalation: { phoneAfterMinutes: 2 },
      sounds: { knock: true, allClear: true, turnEnd: false },
      notifyOnTurnCompleteWhileAway: true,
      browserPermissionPrimerDismissed: false,
    });
    // Nothing else was disturbed on the way in.
    expect(configManager.get('ui').theme).toBe('dark');
  });

  it('keeps notification preferences a person already chose across a real load', () => {
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        notifications: {
          escalation: { phoneAfterMinutes: 'never' },
          sounds: { knock: false, allClear: true, turnEnd: true },
          notifyOnTurnCompleteWhileAway: false,
          browserPermissionPrimerDismissed: true,
        },
        __internal__: { migrations: { version: '0.63.0' } },
      })
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.get('notifications')).toEqual({
      escalation: { phoneAfterMinutes: 'never' },
      sounds: { knock: false, allClear: true, turnEnd: true },
      notifyOnTurnCompleteWhileAway: false,
      browserPermissionPrimerDismissed: true,
    });
  });

  it('lands memory.provider on disk for a config written before memory existed', () => {
    // The upgrade path over a real file and the real conf/Ajv seam (spec
    // `agent-memory`, D7; migration key 0.69.0).
    //
    // **What this proves, and what it deliberately does not.** `memory` is a
    // whole TOP-LEVEL section, and conf merges `defaults` under the stored file
    // and WRITES the result before it runs its first migration key. So the
    // section lands on disk whether or not `seedMemoryProviderDefault` runs, and
    // no assertion at this seam can attribute it to the body — the anchor is
    // unreachable by construction and its docblock says so. Suppress the body
    // and this test stays green, which is the honest outcome for this shape and
    // is exactly what `.claude/rules/safe-defaults.md` says to write down rather
    // than imply otherwise (DOR-1496).
    //
    // The claim that IS load-bearing here: an install that predates the section
    // ends up with `memory.provider: 'builtin'` in `config.json` rather than a
    // file Ajv condemns, and nothing the person had chosen is disturbed.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.68.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      memory?: { provider?: string };
      ui?: { theme?: string };
    };
    expect(onDisk.memory?.provider).toBe('builtin');
    expect(onDisk.ui?.theme).toBe('dark');
    // …and a running DorkOS reads back the same thing, which is a different
    // claim and not a substitute for the one above.
    expect(configManager.getDot('memory.provider')).toBe('builtin');
  });

  it('keeps a memory provider a person already chose across a real load', () => {
    // The case the anchor's absence guard exists for even though it never
    // reaches it: an upgrade must never move somebody off a backend they picked.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        memory: { provider: 'acme-vectors' },
        __internal__: { migrations: { version: '0.68.0' } },
      })
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.getDot('memory.provider')).toBe('acme-vectors');
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      memory?: { provider?: string };
    };
    expect(onDisk.memory?.provider).toBe('acme-vectors');
  });

  it('gets top-level config section', () => {
    const configManager = initConfigManager(testDir);
    const server = configManager.get('server');

    expect(server.port).toBe(4242);
    expect(server.cwd).toBe(null);
  });

  it('gets nested value via dot-path', () => {
    const configManager = initConfigManager(testDir);
    const port = configManager.getDot('server.port');

    expect(port).toBe(4242);
  });

  it('sets top-level config section', () => {
    const configManager = initConfigManager(testDir);
    configManager.set('server', { port: 5000, cwd: '/test', boundary: null });

    expect(configManager.get('server').port).toBe(5000);
    expect(configManager.get('server').cwd).toBe('/test');
  });

  it('sets nested value via dot-path', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);

    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it('warns when setting sensitive config keys', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('tunnel.authtoken', 'test-token');

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('sensitive data');
  });

  it('warns when setting the sensitive cloud.instanceToken key', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('cloud.instanceToken', 'dork_inst_secret');

    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('sensitive data');
  });

  it('does not warn for non-sensitive keys', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('server.port', 5000);

    expect(result.warning).toBeUndefined();
  });

  it('validates valid config', () => {
    const configManager = initConfigManager(testDir);
    const validation = configManager.validate();

    expect(validation.valid).toBe(true);
    expect(validation.errors).toBeUndefined();
  });

  it('resets specific key to default', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);
    configManager.reset('server');

    expect(configManager.getDot('server.port')).toBe(4242);
  });

  it('resets all keys to defaults', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);
    configManager.setDot('tunnel.enabled', true);
    configManager.reset();

    const config = configManager.getAll();
    expect(config.server.port).toBe(4242);
    expect(config.tunnel.enabled).toBe(false);
  });

  it('returns config file path', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.path).toBe(configPath);
  });

  it('recovers from corrupt config by creating backup', () => {
    // Create a valid config first
    const configManager1 = initConfigManager(testDir);
    configManager1.setDot('server.port', 5000);

    // Corrupt the config file
    fs.writeFileSync(configPath, '{ invalid json', 'utf-8');

    // Should recover and create backup
    const configManager2 = initConfigManager(testDir);

    expect(wasBackedUp(testDir)).toBe(true);
    expect(configManager2.get('server').port).toBe(4242); // Reset to defaults
  });

  it('persists config across instances', () => {
    const configManager1 = initConfigManager(testDir);
    configManager1.setDot('server.port', 5000);
    configManager1.setDot('ui.theme', 'dark');

    const configManager2 = initConfigManager(testDir);
    expect(configManager2.getDot('server.port')).toBe(5000);
    expect(configManager2.getDot('ui.theme')).toBe('dark');
  });

  it('exposes extensions.disabled default on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    // `approvedToRun` starts EMPTY on a fresh install, so a brand-new DorkOS runs
    // no user extension's code until a person approves it (DOR-516).
    expect(configManager.get('extensions')).toEqual({
      enabled: [],
      disabled: [],
      approvedToRun: [],
    });
  });

  it('exposes harness defaults (auto-sync on, no hooks allowed) on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('harness')).toEqual({ autoSync: true, approvedHooks: [] });
    expect(configManager.getDot('harness.autoSync')).toBe(true);
  });

  it('exposes runtimes defaults on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('runtimes')).toEqual(RUNTIMES_DEFAULTS);
    expect(configManager.getDot('runtimes.default')).toBe('claude-code');
  });

  it('backfills runtimes on a config file written before the runtimes block existed', () => {
    // Simulate a stale config.json persisted by an older version (no runtimes key).
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 5000, cwd: null, boundary: null, open: true },
      }),
      'utf-8'
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.get('runtimes')).toEqual(RUNTIMES_DEFAULTS);
    // Existing user data survives the upgrade untouched.
    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it('exposes auth.enabled default (false) on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('auth')).toEqual({ enabled: false });
    expect(configManager.getDot('auth.enabled')).toBe(false);
  });

  it('exposes the all-null cloud section on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('cloud')).toEqual({
      instanceToken: null,
      instanceName: null,
      linkedAccountLabel: null,
    });
  });

  it('exposes the empty providers registry on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('providers')).toEqual({});
  });

  it('gains the providers block on load for a pre-providers config; existing keys untouched', () => {
    // A config written before the credential substrate existed: `runtimes` is
    // present in its pre-T1 shape, but there is no top-level `providers` key.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 5000, cwd: null, boundary: null, open: true },
        runtimes: {
          default: 'claude-code',
          opencode: { enabled: true, binaryPath: null, port: 0 },
          codex: { enabled: true, binaryPath: null },
        },
      }),
      'utf-8'
    );

    const configManager = initConfigManager(testDir);
    // The block appears on load (schema default via conf's defaults-merge).
    expect(configManager.get('providers')).toEqual({});
    // Existing user data survives untouched.
    expect(configManager.getDot('server.port')).toBe(5000);
    expect(configManager.getDot('runtimes.default')).toBe('claude-code');
  });

  it('a stale pre-profile config gains the profile block with defaults (user-profile-onboarding)', () => {
    // A real config.json persisted before the profile block existed.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 5000, cwd: null, boundary: null, open: true },
      }),
      'utf-8'
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.get('profile')).toEqual({
      roles: [],
      tools: [],
      displayName: null,
      rolePromptDismissedAt: null,
    });
    // Existing user data survives the upgrade untouched.
    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it('a config with explicit profile values keeps them across a reload', () => {
    const explicit = {
      roles: ['hiring', 'business-ops'],
      tools: ['Gmail', 'Greenhouse'],
      displayName: 'Dorian',
      rolePromptDismissedAt: '2026-07-29T00:00:00.000Z',
    };
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        profile: explicit,
      }),
      'utf-8'
    );

    const configManager = initConfigManager(testDir);
    expect(configManager.get('profile')).toEqual(explicit);
    // And a second manager over the same file still reads the same values.
    const second = new ConfigManager(testDir);
    expect(second.get('profile')).toEqual(explicit);
  });
});

describe('backfillProfileDefaults migration', () => {
  it('backfills the profile section with empty defaults when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillProfileDefaults(store);
    expect(store.data.profile).toEqual({
      roles: [],
      tools: [],
      displayName: null,
      rolePromptDismissedAt: null,
    });
  });

  it('is idempotent (leaves an existing profile untouched)', () => {
    const existing = {
      roles: ['hiring'],
      tools: [],
      displayName: 'Dorian',
      rolePromptDismissedAt: null,
    };
    const store = createMockStore({ profile: existing });
    backfillProfileDefaults(store);
    expect(store.data.profile).toBe(existing);
  });
});

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

describe('seedRoomRepoDefaults migration (project-rooms §3.12, DOR-1591)', () => {
  it('reserves rooms.repo on a `rooms` block that predates it', () => {
    // What this catches: conf merges top-level defaults SHALLOWLY, so an
    // upgrading install with a stored `rooms` block never inherits the new
    // nested section on its own. Drop the body and this reads `undefined`.
    const store = createMockStore({ rooms: { turnLimitsEnabled: true, maxAgentDepth: 30 } });
    seedRoomRepoDefaults(store);
    expect(store.data.rooms).toEqual({
      turnLimitsEnabled: true,
      maxAgentDepth: 30,
      repo: USER_CONFIG_DEFAULTS.rooms.repo,
    });
  });

  it('never overwrites bounds somebody set (idempotent)', () => {
    // What this catches: a re-run — corrupt-recovery instantiates conf twice —
    // slackening a ceiling the person tightened, which is exactly the wipe the
    // operator-only verdict on these paths exists to prevent.
    const chosen = { enabled: false, maxFileBytes: 1024 };
    const store = createMockStore({ rooms: { repo: chosen } });
    seedRoomRepoDefaults(store);
    expect((store.data.rooms as Record<string, unknown>).repo).toBe(chosen);
  });

  it('does nothing when there is no `rooms` block to extend', () => {
    // The schema default supplies the whole section on read in that case, and
    // writing a partial `rooms` here would drop every other default in it.
    const store = createMockStore({ server: { port: 4242 } });
    seedRoomRepoDefaults(store);
    expect(store.data.rooms).toBeUndefined();
  });

  it('a real pre-0.70.0 config file gains rooms.repo on disk (full conf path)', () => {
    // The half neither the mock store nor a `getDot` assertion can reach — see
    // the `backfillPromoDismissals` case above for the measurement this shape
    // comes from (DOR-1496). `rooms` is a nested-leaf case, so this body is the
    // ONLY thing that puts `repo` on the file: suppress it and this goes red
    // while `store.get('rooms').repo` still answers from Ajv's discarded copy.
    //
    // `projectVersion` is stated explicitly because `SERVER_VERSION` resolves to
    // `0.0.0` in a dev tree, which runs no migration at all.
    const dir = path.join(os.tmpdir(), 'test-dork-room-repo-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          rooms: { turnLimitsEnabled: true, maxAgentDepth: 12, replyWaitMinutes: 25 },
          __internal__: { migrations: { version: '0.69.0' } },
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
        projectVersion: '0.70.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        rooms: Record<string, unknown>;
      };
      expect(onDisk.rooms.repo).toEqual({
        enabled: true,
        worktreeReapDays: 14,
        maxFileBytes: 5 * 1024 * 1024,
        maxRepoBytes: 500 * 1024 * 1024,
        maxRoomMdBytes: 24 * 1024,
        mergeQueueWaitMs: 30_000,
      });
      // The upgrade adds a section; it changes nothing the person had set.
      expect(onDisk.rooms.maxAgentDepth).toBe(12);
      expect(onDisk.rooms.replyWaitMinutes).toBe(25);
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('migrateClaudeAccountRegistry migration (billing-account-ladder, DOR-1407)', () => {
  it('carries the chosen account across the rename and drops the old key', () => {
    // The half that is not additive: left behind, the operator's chosen billing
    // account is silently replaced by whatever the environment points at. The
    // old key is dropped so the file converges on one spelling — Ajv would
    // tolerate it (`tolerateUnknownKeys` reopens the object); two keys for one
    // billing setting is what must not survive.
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: '/Users/me/.claude2', accounts: [] },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: { defaultAccount: '/Users/me/.claude2', accounts: [] },
    });
  });

  it('carries a null default across too, rather than dropping the key', () => {
    const store = createMockStore({
      runtimes: { claudeCode: { activeAccount: null, accounts: [] } },
    });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toEqual({ claudeCode: { defaultAccount: null, accounts: [] } });
  });

  it('backfills an id from the label, slugified', () => {
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [{ path: '/Users/me/.claude2', label: 'Acme Corp' }],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: unknown[] } }).claudeCode.accounts
    ).toEqual([{ id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' }]);
  });

  it("falls back to the directory's basename when the account has no label", () => {
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [{ path: '/Users/me/.claude3', label: null }],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }).claudeCode
        .accounts[0]!.id
    ).toBe('claude3');
  });

  it('uniquifies ids that would collide', () => {
    // Two accounts an operator named the same thing, or two directories with the
    // same basename under different parents. A duplicate id would make one of
    // them unreachable and silently repoint every agent naming it.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: null,
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'ACME corp' },
            { path: '/c/.claude', label: 'acme-corp' },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    const ids = (
      store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }
    ).claudeCode.accounts.map((account) => account.id);
    expect(ids).toEqual(['acme-corp', 'acme-corp-2', 'acme-corp-3']);
    expect(new Set(ids).size).toBe(3);
  });

  it('uniquifies against an id an earlier run already assigned', () => {
    // Half-migrated state is reachable: a re-run after a crash, or an operator
    // who hand-added an entry. A second pass must not mint a colliding id.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'Acme Corp' },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);

    expect(
      (store.data.runtimes as { claudeCode: { accounts: { id: string }[] } }).claudeCode.accounts
    ).toEqual([
      { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
      { id: 'acme-corp-2', path: '/b/.claude', label: 'Acme Corp' },
    ]);
  });

  it('is idempotent — a second run changes nothing', () => {
    // What this catches: a re-run (corrupt-recovery instantiates conf twice)
    // re-minting ids and breaking every agent that references one.
    const store = createMockStore({
      runtimes: {
        claudeCode: {
          activeAccount: '/Users/me/.claude2',
          accounts: [
            { path: '/Users/me/.claude2', label: 'Acme Corp' },
            { path: '/Users/me/.claude3', label: null },
          ],
        },
      },
    });

    migrateClaudeAccountRegistry(store);
    const afterFirst = structuredClone(store.data.runtimes);
    migrateClaudeAccountRegistry(store);

    expect(store.data.runtimes).toEqual(afterFirst);
  });

  it('leaves an already-migrated config completely alone', () => {
    const migrated = {
      claudeCode: {
        defaultAccount: '/Users/me/.claude2',
        accounts: [{ id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' }],
      },
    };
    const store = createMockStore({ runtimes: structuredClone(migrated) });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toEqual(migrated);
  });

  it('is a no-op when there is no runtimes block at all', () => {
    const store = createMockStore({ server: { port: 4242 } });
    migrateClaudeAccountRegistry(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('a real pre-0.65.0 config file comes back renamed and referenceable (full conf path)', () => {
    // The mock store never crosses the conf/Ajv boundary, and Ajv is what
    // REJECTS a config the schema no longer admits. This is the only check that
    // an install carrying the old shape survives the upgrade with its billing
    // choice intact rather than being condemned and replaced.
    const dir = path.join(os.tmpdir(), 'test-dork-account-ladder-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      const cfgPath = path.join(dir, 'config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          ...USER_CONFIG_DEFAULTS,
          runtimes: {
            ...USER_CONFIG_DEFAULTS.runtimes,
            claudeCode: {
              activeAccount: '/Users/me/.claude2',
              accounts: [
                { path: '/Users/me/.claude2', label: 'Acme Corp' },
                { path: '/Users/me/.claude3', label: null },
              ],
            },
          },
          __internal__: { migrations: { version: '0.64.0' } },
        })
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        // The SHIPPED schema, tolerances included. Constructing without one was
        // the defect this test had on review: `conf` only runs Ajv when it is
        // given a schema, so the test that claimed to prove the migrated file
        // validates was proving nothing at all.
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.65.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: { claudeCode: Record<string, unknown> };
      };
      expect(onDisk.runtimes.claudeCode).toMatchObject({
        defaultAccount: '/Users/me/.claude2',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' },
          { id: 'claude3', path: '/Users/me/.claude3', label: null },
        ],
      });
      expect(onDisk.runtimes.claudeCode).not.toHaveProperty('activeAccount');

      // And the migrated file is one the live schema accepts, which is the whole
      // point of doing it through conf.
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillAuthDefaults migration', () => {
  it('backfills the auth section with enabled: false when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillAuthDefaults(store);
    expect(store.data.auth).toEqual({ enabled: false });
  });

  it('is idempotent (leaves an existing auth config untouched)', () => {
    const store = createMockStore({ auth: { enabled: true } });
    backfillAuthDefaults(store);
    expect(store.data.auth).toEqual({ enabled: true });
  });
});

describe('backfillCloudDefaults migration', () => {
  it('backfills the cloud section with all-null fields when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillCloudDefaults(store);
    expect(store.data.cloud).toEqual({
      instanceToken: null,
      instanceName: null,
      linkedAccountLabel: null,
    });
  });

  it('is idempotent (leaves an existing linked cloud config untouched)', () => {
    const store = createMockStore({
      cloud: {
        instanceToken: 'dork_inst_live',
        instanceName: 'kai-mbp',
        linkedAccountLabel: 'Kai',
      },
    });
    backfillCloudDefaults(store);
    expect(store.data.cloud).toEqual({
      instanceToken: 'dork_inst_live',
      instanceName: 'kai-mbp',
      linkedAccountLabel: 'Kai',
    });
  });
});

describe('generalizeTelemetryConsent migration', () => {
  it('renames telemetry.enabled -> telemetry.install, preserving an opted-in choice', () => {
    const store = createMockStore({ telemetry: { enabled: true, userHasDecided: true } });
    generalizeTelemetryConsent(store);
    expect(store.data.telemetry).toEqual({
      install: true,
      userHasDecided: true,
      heartbeat: false,
      errorReporting: false,
    });
  });

  it('preserves an opted-out choice through the rename', () => {
    const store = createMockStore({ telemetry: { enabled: false, userHasDecided: true } });
    generalizeTelemetryConsent(store);
    expect(store.data.telemetry).toEqual({
      install: false,
      userHasDecided: true,
      heartbeat: false,
      errorReporting: false,
    });
  });

  it('never enrolls a user in the new channels (defaults OFF)', () => {
    const store = createMockStore({ telemetry: { enabled: true, userHasDecided: true } });
    generalizeTelemetryConsent(store);
    const telemetry = store.data.telemetry as Record<string, boolean>;
    expect(telemetry.heartbeat).toBe(false);
    expect(telemetry.errorReporting).toBe(false);
  });

  it('is idempotent — a fully-migrated block is untouched', () => {
    const migrated = {
      userHasDecided: true,
      install: true,
      heartbeat: true,
      errorReporting: false,
    };
    const store = createMockStore({ telemetry: { ...migrated } });
    generalizeTelemetryConsent(store);
    expect(store.data.telemetry).toEqual(migrated);
  });

  it('backfills only the missing channel flags when install already exists', () => {
    const store = createMockStore({ telemetry: { userHasDecided: true, install: true } });
    generalizeTelemetryConsent(store);
    expect(store.data.telemetry).toEqual({
      userHasDecided: true,
      install: true,
      heartbeat: false,
      errorReporting: false,
    });
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => generalizeTelemetryConsent(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('backfillTelemetryLastPromptedVersion migration', () => {
  it('backfills lastPromptedVersion: null on an existing telemetry block', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, install: true, heartbeat: false, errorReporting: false },
    });
    backfillTelemetryLastPromptedVersion(store);
    expect(store.data.telemetry).toEqual({
      userHasDecided: true,
      install: true,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
    });
  });

  it('never overwrites an existing lastPromptedVersion', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, lastPromptedVersion: '0.46.0' },
    });
    backfillTelemetryLastPromptedVersion(store);
    expect((store.data.telemetry as Record<string, unknown>).lastPromptedVersion).toBe('0.46.0');
  });

  it('is idempotent — a fully-migrated block is untouched', () => {
    const migrated = {
      userHasDecided: false,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
    };
    const store = createMockStore({ telemetry: { ...migrated } });
    backfillTelemetryLastPromptedVersion(store);
    expect(store.data.telemetry).toEqual(migrated);
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillTelemetryLastPromptedVersion(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('applyTier1OptOutDefaults migration', () => {
  it('enrolls a never-answered install: install + heartbeat become true', () => {
    const store = createMockStore({
      telemetry: {
        userHasDecided: false,
        install: false,
        heartbeat: false,
        errorReporting: false,
        lastPromptedVersion: null,
      },
    });
    applyTier1OptOutDefaults(store);
    expect(store.data.telemetry).toEqual({
      userHasDecided: false,
      install: true,
      heartbeat: true,
      errorReporting: false,
      lastPromptedVersion: null,
    });
  });

  it('never touches errorReporting when enrolling a never-answered install', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, install: false, heartbeat: false, errorReporting: true },
    });
    applyTier1OptOutDefaults(store);
    // errorReporting is Tier 2 (opt-in) and must survive untouched.
    expect((store.data.telemetry as Record<string, boolean>).errorReporting).toBe(true);
    expect((store.data.telemetry as Record<string, boolean>).install).toBe(true);
    expect((store.data.telemetry as Record<string, boolean>).heartbeat).toBe(true);
  });

  it('leaves an explicit prior "no" byte-identical (userHasDecided: true)', () => {
    const decidedNo = {
      userHasDecided: true,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: '0.46.0',
    };
    const store = createMockStore({ telemetry: { ...decidedNo } });
    applyTier1OptOutDefaults(store);
    expect(store.data.telemetry).toEqual(decidedNo);
  });

  it('leaves an explicit prior "yes" untouched (userHasDecided: true)', () => {
    const decidedYes = {
      userHasDecided: true,
      install: true,
      heartbeat: true,
      errorReporting: true,
      lastPromptedVersion: '0.46.0',
    };
    const store = createMockStore({ telemetry: { ...decidedYes } });
    applyTier1OptOutDefaults(store);
    expect(store.data.telemetry).toEqual(decidedYes);
  });

  it('is idempotent — an already-enrolled never-answered block is untouched', () => {
    const enrolled = {
      userHasDecided: false,
      install: true,
      heartbeat: true,
      errorReporting: false,
      lastPromptedVersion: null,
    };
    const store = createMockStore({ telemetry: { ...enrolled } });
    applyTier1OptOutDefaults(store);
    expect(store.data.telemetry).toEqual(enrolled);
    // Second application is a no-op too.
    applyTier1OptOutDefaults(store);
    expect(store.data.telemetry).toEqual(enrolled);
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => applyTier1OptOutDefaults(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('backfillTelemetryUsageChannel migration', () => {
  it('sets usage: false for an already-decided install (never widen an explicit choice)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, install: true, heartbeat: false, errorReporting: false },
    });
    backfillTelemetryUsageChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).usage).toBe(false);
  });

  it('sets usage: true for a never-answered install (Tier 1 default, notice-gated at send)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, install: false, heartbeat: false, errorReporting: false },
    });
    backfillTelemetryUsageChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).usage).toBe(true);
  });

  it('treats an absent userHasDecided as never-answered (usage: true)', () => {
    const store = createMockStore({ telemetry: { install: false } });
    backfillTelemetryUsageChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).usage).toBe(true);
  });

  it('never overwrites an existing usage value (idempotent)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, usage: false },
    });
    backfillTelemetryUsageChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).usage).toBe(false);
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillTelemetryUsageChannel(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('backfillTelemetryLinkAnalyticsToAccount migration', () => {
  it('seeds linkAnalyticsToAccount: false on an existing telemetry block (Tier 2 opt-in)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, install: true, heartbeat: true, usage: true },
    });
    backfillTelemetryLinkAnalyticsToAccount(store);
    expect((store.data.telemetry as Record<string, unknown>).linkAnalyticsToAccount).toBe(false);
  });

  it('seeds false even for an already-decided install (never inferred from prior choice)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, install: true, heartbeat: false, usage: false },
    });
    backfillTelemetryLinkAnalyticsToAccount(store);
    expect((store.data.telemetry as Record<string, unknown>).linkAnalyticsToAccount).toBe(false);
  });

  it('never overwrites an existing value (idempotent)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, linkAnalyticsToAccount: true },
    });
    backfillTelemetryLinkAnalyticsToAccount(store);
    expect((store.data.telemetry as Record<string, unknown>).linkAnalyticsToAccount).toBe(true);
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillTelemetryLinkAnalyticsToAccount(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('backfillTelemetryAiMetadataChannel migration', () => {
  it('seeds aiMetadata: false for a never-answered install (Tier 2 opt-in starts off)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: false, install: true, heartbeat: true, usage: true },
    });
    backfillTelemetryAiMetadataChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).aiMetadata).toBe(false);
  });

  it('seeds aiMetadata: false even for an already-decided install (opt-in is never auto-enrolled)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, install: true, heartbeat: true, usage: true },
    });
    backfillTelemetryAiMetadataChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).aiMetadata).toBe(false);
  });

  it('never overwrites an existing aiMetadata value (idempotent, byte-safe)', () => {
    const store = createMockStore({
      telemetry: { userHasDecided: true, aiMetadata: true },
    });
    backfillTelemetryAiMetadataChannel(store);
    expect((store.data.telemetry as Record<string, unknown>).aiMetadata).toBe(true);
  });

  it('running twice is a no-op on the second pass (idempotent)', () => {
    const store = createMockStore({ telemetry: { userHasDecided: false } });
    backfillTelemetryAiMetadataChannel(store);
    const afterFirst = JSON.stringify(store.data.telemetry);
    backfillTelemetryAiMetadataChannel(store);
    expect(JSON.stringify(store.data.telemetry)).toBe(afterFirst);
  });

  it('no-ops when the telemetry section is absent (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillTelemetryAiMetadataChannel(store)).not.toThrow();
    expect(store.data.telemetry).toBeUndefined();
  });
});

describe('backfillWorkbenchDefaults migration', () => {
  it('backfills the workbench section with empty viewer overrides when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillWorkbenchDefaults(store);
    expect(store.data.workbench).toEqual({ defaultViewers: {} });
  });

  it('is idempotent (leaves existing viewer overrides untouched)', () => {
    const store = createMockStore({ workbench: { defaultViewers: { csv: 'file' } } });
    backfillWorkbenchDefaults(store);
    expect(store.data.workbench).toEqual({ defaultViewers: { csv: 'file' } });
  });
});

describe('backfillWorkbenchTerminalGraceTtl migration', () => {
  it('adds the terminal grace TTL to an existing workbench block, preserving overrides', () => {
    const store = createMockStore({ workbench: { defaultViewers: { csv: 'file' } } });
    backfillWorkbenchTerminalGraceTtl(store);
    expect(store.data.workbench).toEqual({
      defaultViewers: { csv: 'file' },
      terminalGraceTtlMinutes: 10,
    });
  });

  it('is idempotent (leaves an already-set TTL untouched)', () => {
    const store = createMockStore({
      workbench: { defaultViewers: {}, terminalGraceTtlMinutes: 30 },
    });
    backfillWorkbenchTerminalGraceTtl(store);
    expect(store.data.workbench).toEqual({ defaultViewers: {}, terminalGraceTtlMinutes: 30 });
  });

  it('is a no-op when the workbench section is absent (backfillWorkbenchDefaults owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillWorkbenchTerminalGraceTtl(store);
    expect(store.data.workbench).toBeUndefined();
  });
});

describe('backfillWorkbenchAutoOpenDiff migration', () => {
  it('adds autoOpenDiff=true to an existing workbench block, preserving other fields', () => {
    const store = createMockStore({
      workbench: { defaultViewers: { csv: 'file' }, terminalGraceTtlMinutes: 10 },
    });
    backfillWorkbenchAutoOpenDiff(store);
    expect(store.data.workbench).toEqual({
      defaultViewers: { csv: 'file' },
      terminalGraceTtlMinutes: 10,
      autoOpenDiff: true,
    });
  });

  it('is idempotent (leaves an already-set autoOpenDiff untouched)', () => {
    const store = createMockStore({
      workbench: { defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: false },
    });
    backfillWorkbenchAutoOpenDiff(store);
    expect(store.data.workbench).toEqual({
      defaultViewers: {},
      terminalGraceTtlMinutes: 10,
      autoOpenDiff: false,
    });
  });

  it('is a no-op when the workbench section is absent (schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillWorkbenchAutoOpenDiff(store);
    expect(store.data.workbench).toBeUndefined();
  });
});

describe('dropTunnelPasscodeAndSessionSecret migration', () => {
  it('removes all four legacy passcode/sessionSecret keys, preserving other tunnel fields', () => {
    const store = createMockStore({
      tunnel: {
        enabled: true,
        domain: null,
        authtoken: 'ngrok-token',
        auth: null,
        passcodeEnabled: true,
        passcodeHash: 'deadbeef',
        passcodeSalt: 'cafe',
      },
      sessionSecret: 'super-secret',
    });

    dropTunnelPasscodeAndSessionSecret(store);

    expect(store.data.tunnel).toEqual({
      enabled: true,
      domain: null,
      authtoken: 'ngrok-token',
      auth: null,
    });
    expect('sessionSecret' in store.data).toBe(false);
  });

  it('is idempotent (running twice is a no-op)', () => {
    const store = createMockStore({
      tunnel: {
        enabled: false,
        domain: null,
        authtoken: null,
        auth: null,
        passcodeEnabled: false,
        passcodeHash: null,
        passcodeSalt: null,
      },
      sessionSecret: 'secret',
    });

    dropTunnelPasscodeAndSessionSecret(store);
    const afterFirst = structuredClone(store.data);
    dropTunnelPasscodeAndSessionSecret(store);

    expect(store.data).toEqual(afterFirst);
    expect(store.data.tunnel).toEqual({
      enabled: false,
      domain: null,
      authtoken: null,
      auth: null,
    });
    expect('sessionSecret' in store.data).toBe(false);
  });

  it('leaves a config without the legacy keys untouched', () => {
    const store = createMockStore({
      tunnel: { enabled: false, domain: null, authtoken: null, auth: null },
    });
    const before = structuredClone(store.data);

    dropTunnelPasscodeAndSessionSecret(store);

    expect(store.data).toEqual(before);
  });
});

describe('backfillProvidersDefaults migration', () => {
  it('adds the top-level providers registry when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillProvidersDefaults(store);
    expect(store.data.providers).toEqual({});
  });

  it('backfills nested credential fields onto an existing runtimes block', () => {
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        opencode: { enabled: true, binaryPath: null, port: 0 },
        codex: { enabled: true, binaryPath: null },
      },
    });
    backfillProvidersDefaults(store);
    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: null },
    });
  });

  it('seeds credential fields to null — never a plaintext secret', () => {
    const store = createMockStore({
      runtimes: { codex: { enabled: true, binaryPath: null }, opencode: {} },
    });
    backfillProvidersDefaults(store);
    const runtimes = store.data.runtimes as {
      codex: { credentialRef: unknown };
      opencode: { provider: unknown; baseURL: unknown };
    };
    expect(runtimes.codex.credentialRef).toBeNull();
    expect(runtimes.opencode.provider).toBeNull();
    expect(runtimes.opencode.baseURL).toBeNull();
  });

  it('is idempotent — leaves already-migrated credential fields untouched', () => {
    const store = createMockStore({
      providers: { anthropic: 'file:anthropic' },
      runtimes: {
        default: 'claude-code',
        opencode: {
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: 'openrouter',
          baseURL: null,
        },
        codex: { enabled: true, binaryPath: null, credentialRef: 'env:CODEX_API_KEY' },
      },
    });
    backfillProvidersDefaults(store);
    expect(store.data.providers).toEqual({ anthropic: 'file:anthropic' });
    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0, provider: 'openrouter', baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: 'env:CODEX_API_KEY' },
    });
  });

  it('skips the nested backfill when there is no runtimes block (schema default supplies it)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillProvidersDefaults(store)).not.toThrow();
    expect(store.data.runtimes).toBeUndefined();
    expect(store.data.providers).toEqual({});
  });
});

describe('backfillHarnessDefaults migration', () => {
  it('backfills the harness section with autoSync: true when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillHarnessDefaults(store);
    expect(store.data.harness).toEqual({ autoSync: true });
  });

  it('is idempotent (leaves an existing harness config untouched)', () => {
    const store = createMockStore({ harness: { autoSync: false } });
    backfillHarnessDefaults(store);
    expect(store.data.harness).toEqual({ autoSync: false });
  });
});

describe('backfillSidebarDefaults migration (DOR-329)', () => {
  const SIDEBAR_DEFAULTS = {
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    groupsHintDismissed: false,
  };

  it('adds ui.sidebar to an existing ui block, preserving other ui fields', () => {
    const store = createMockStore({ ui: { theme: 'dark', dismissedUpgradeVersions: ['1.0.0'] } });
    backfillSidebarDefaults(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      dismissedUpgradeVersions: ['1.0.0'],
      sidebar: SIDEBAR_DEFAULTS,
    });
  });

  it('is idempotent — does not overwrite existing sidebar organization', () => {
    const existing = {
      theme: 'system',
      dismissedUpgradeVersions: [],
      sidebar: {
        pinned: ['/projects/api'],
        groups: [
          {
            id: 'g1',
            name: 'Clients',
            agentPaths: ['/projects/api'],
            sortMode: 'recent',
            collapsed: false,
          },
        ],
        ungroupedSortMode: 'recent',
        ungroupedCollapsed: true,
        recentsCollapsed: false,
        groupsHintDismissed: true,
      },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillSidebarDefaults(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when the ui section is absent (schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillSidebarDefaults(store);
    expect(store.data.ui).toBeUndefined();
  });
});

describe('backfillShapesDefaults migration (DOR-355)', () => {
  const SHAPES_DEFAULTS = {
    active: null,
    agentDefaults: {},
    autoFollowAgent: false,
  };

  it('adds ui.shapes to an existing ui block, preserving other ui fields', () => {
    const store = createMockStore({
      ui: {
        theme: 'dark',
        dismissedUpgradeVersions: ['1.0.0'],
        sidebar: { pinned: [], groups: [] },
      },
    });
    backfillShapesDefaults(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      dismissedUpgradeVersions: ['1.0.0'],
      sidebar: { pinned: [], groups: [] },
      shapes: SHAPES_DEFAULTS,
    });
  });

  it('is idempotent — does not overwrite an existing ui.shapes', () => {
    const existing = {
      theme: 'system',
      dismissedUpgradeVersions: [],
      shapes: {
        active: 'linear-ops',
        agentDefaults: { '/projects/api': 'linear-ops' },
        autoFollowAgent: true,
      },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillShapesDefaults(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when the ui section is absent (schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillShapesDefaults(store);
    expect(store.data.ui).toBeUndefined();
  });
});

describe('backfillAutonomyAcknowledgement migration (spec trust-dial, decision 5)', () => {
  it('fresh install: nobody has acknowledged anything', () => {
    expect(USER_CONFIG_DEFAULTS.ui.autonomyAcknowledgedAt).toBeNull();
  });

  it('upgraded install: seeds null onto an existing ui block, preserving the rest', () => {
    const store = createMockStore({
      ui: { theme: 'dark', statusBar: { pins: ['git'] } },
    });
    backfillAutonomyAcknowledgement(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      statusBar: { pins: ['git'] },
      autonomyAcknowledgedAt: null,
    });
  });

  it('never hands out a consent nobody gave', () => {
    // The direction that matters. An upgrade that seeded a timestamp would
    // silence the door for every existing install, and nobody would have chosen
    // that — so the seeded value is the one that keeps asking.
    const store = createMockStore({ ui: { theme: 'system' } });
    backfillAutonomyAcknowledgement(store);
    const parsed = UserConfigSchema.parse({ version: 1, ui: store.data.ui });
    expect(parsed.ui.autonomyAcknowledgedAt).toBeNull();
  });

  it('is idempotent — never overwrites an acknowledgement already on file', () => {
    const existing = { theme: 'system', autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z' };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillAutonomyAcknowledgement(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('leaves a cleared acknowledgement cleared', () => {
    // `null` is a real, chosen value here — somebody pressed Reset in Settings.
    // Re-running the migration (corrupt recovery, a hand-edited version key)
    // must not read "no timestamp" as "never migrated".
    const store = createMockStore({ ui: { theme: 'system', autonomyAcknowledgedAt: null } });
    backfillAutonomyAcknowledgement(store);
    expect(store.data.ui).toEqual({ theme: 'system', autonomyAcknowledgedAt: null });
  });

  it('is a no-op when the ui section is absent (the defaults merge owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillAutonomyAcknowledgement(store);
    expect(store.data.ui).toBeUndefined();
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

describe('backfillConnectorsDefaults migration (connector-completion, raw-MCP config)', () => {
  it('seeds an empty rawMcpServers list for a config persisted before the section existed', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillConnectorsDefaults(store);
    expect(store.data.connectors).toEqual({ rawMcpServers: [] });
  });

  it('is idempotent and never overwrites a configured server list', () => {
    const configured = {
      rawMcpServers: [
        {
          slug: 'notion',
          displayName: 'Notion',
          url: 'https://mcp.notion.example',
          transport: 'http',
        },
      ],
    };
    const store = createMockStore({ connectors: configured });
    backfillConnectorsDefaults(store);
    backfillConnectorsDefaults(store);
    expect(store.data.connectors).toEqual(configured);
  });

  it('migrates a real pre-0.57.0 config file through a real ConfigManager', () => {
    // A real `conf` store over a real file — the mock never crosses the
    // conf/Ajv seam (`.claude/rules/safe-defaults.md`).
    const dir = path.join(os.tmpdir(), 'test-dork-connectors-mig-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          ...USER_CONFIG_DEFAULTS,
          connectors: undefined,
          __internal__: { migrations: { version: '0.56.0' } },
        })
      );
      const manager = initConfigManager(dir);
      expect(manager.get('connectors')).toEqual({ rawMcpServers: [] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillClaudeCodeRuntimeDefaults migration (claude-code-accounts)', () => {
  it('adds claudeCode to an existing runtimes block without touching its siblings', () => {
    // The case the migration exists for: conf merges top-level defaults shallowly,
    // so a stored `runtimes` object never inherits a new nested section.
    const store = createMockStore({
      runtimes: {
        default: 'opencode',
        opencode: { enabled: true, binaryPath: '/opt/bin/opencode', port: 5111 },
        codex: { enabled: false, binaryPath: null, credentialRef: 'env:CODEX_KEY' },
      },
    });
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toEqual({
      default: 'opencode',
      opencode: { enabled: true, binaryPath: '/opt/bin/opencode', port: 5111 },
      codex: { enabled: false, binaryPath: null, credentialRef: 'env:CODEX_KEY' },
      claudeCode: { activeAccount: null, accounts: [] },
    });
  });

  it('is idempotent and never overwrites a chosen account or a registered roster', () => {
    const configured = {
      default: 'claude-code',
      claudeCode: {
        activeAccount: '/Users/me/.claude2',
        accounts: [{ path: '/Users/me/.claude2', label: 'Acme Corp' }],
      },
    };
    const store = createMockStore({ runtimes: structuredClone(configured) });
    backfillClaudeCodeRuntimeDefaults(store);
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toEqual(configured);
  });

  it('is a no-op when there is no runtimes block (the schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillClaudeCodeRuntimeDefaults(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('a real pre-0.57.0 config file gains the section on disk (full conf path)', () => {
    // A real `conf` store over a real file — the mock never crosses the conf/Ajv
    // seam (`.claude/rules/safe-defaults.md`). `projectVersion` is stated
    // explicitly because SERVER_VERSION resolves to 0.0.0 in a dev tree, which
    // puts the unreleased key outside conf's `(storedVersion, projectVersion]`
    // window and would run no migration at all.
    //
    // The assertion reads the FILE, not the store: Ajv fills the missing section
    // in on every READ, so `store.get('runtimes')` would look right even with the
    // migration deleted. What only the migration does is write it through.
    const dir = path.join(os.tmpdir(), 'test-dork-claudecode-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const priorRuntimes = {
        default: 'claude-code',
        opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
        codex: { enabled: true, binaryPath: null, credentialRef: null },
      };
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          server: { port: 5000, cwd: null, boundary: null, open: true },
          runtimes: priorRuntimes,
          __internal__: { migrations: { version: '0.56.0' } },
        }),
        'utf-8'
      );

      const jsonSchema = z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' }) as {
        properties?: Record<string, unknown>;
      };
      new Conf({
        configName: 'config',
        cwd: dir,
        // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
        // The shipped schema, tolerances included — never rebuilt here (see CONF_JSON_SCHEMA).
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.57.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: Record<string, unknown>;
      };
      expect(onDisk.runtimes.claudeCode).toEqual({
        activeAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
      });
      // The upgrade adds a section; it changes no runtime the person configured.
      expect(onDisk.runtimes).toMatchObject(priorRuntimes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a real config file that already names an account, through Ajv', () => {
    // Ajv, not Zod, is the validator on the config read path, and it REJECTS
    // unknown keys where Zod merely strips them. Booting a real manager over a
    // populated roster is the only way to prove the generated JSON Schema
    // actually admits this shape.
    const dir = path.join(os.tmpdir(), 'test-dork-claudecode-set-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({
          ...USER_CONFIG_DEFAULTS,
          runtimes: {
            ...USER_CONFIG_DEFAULTS.runtimes,
            claudeCode: {
              defaultAccount: '/Users/me/.claude3',
              accounts: [
                { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
                { id: 'claude3', path: '/Users/me/.claude3', label: null },
              ],
            },
          },
        })
      );
      const manager = initConfigManager(dir);
      expect(manager.get('runtimes').claudeCode).toEqual({
        defaultAccount: '/Users/me/.claude3',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
          { id: 'claude3', path: '/Users/me/.claude3', label: null },
        ],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfillSidebarSettingsDefaults migration (DOR-339)', () => {
  it('adds muted + ungroupedDisplayFilter to an existing sidebar, and displayFilter + muted to every group', () => {
    const store = createMockStore({
      ui: {
        theme: 'dark',
        sidebar: {
          pinned: ['/a'],
          groups: [
            { id: 'g1', name: 'Clients', agentPaths: ['/a'], sortMode: 'manual', collapsed: false },
          ],
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          groupsHintDismissed: false,
        },
      },
    });
    backfillSidebarSettingsDefaults(store);
    expect(store.data.ui).toEqual({
      theme: 'dark',
      sidebar: {
        pinned: ['/a'],
        groups: [
          {
            id: 'g1',
            name: 'Clients',
            agentPaths: ['/a'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
          },
        ],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
        muted: [],
        ungroupedDisplayFilter: 'all',
      },
    });
  });

  it('is idempotent — does not overwrite an existing muted/displayFilter choice', () => {
    const existing = {
      theme: 'system',
      sidebar: {
        pinned: [],
        groups: [
          {
            id: 'g1',
            name: 'Experiments',
            agentPaths: ['/x'],
            sortMode: 'manual',
            collapsed: false,
            displayFilter: 'attention',
            muted: true,
          },
        ],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        groupsHintDismissed: false,
        muted: ['/y'],
        ungroupedDisplayFilter: 'active',
      },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillSidebarSettingsDefaults(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when ui.sidebar is absent (schema default / backfillSidebarDefaults own that case)', () => {
    const store = createMockStore({ ui: { theme: 'dark' } });
    backfillSidebarSettingsDefaults(store);
    expect(store.data.ui).toEqual({ theme: 'dark' });
  });

  it('is a no-op when the ui section is absent entirely', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillSidebarSettingsDefaults(store);
    expect(store.data.ui).toBeUndefined();
  });
});

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

describe('backfillRoomsDefaults migration (room cascade ceiling, DOR-526)', () => {
  it('seeds the section on a config persisted before it existed', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillRoomsDefaults(store);
    // Pinned to the literal the release ships. Reading the default out of the
    // schema here would only prove the migration and the schema agree, never
    // that they agree on a number that bounds anything.
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 3,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('is idempotent — keeps a ceiling the user already chose', () => {
    const store = createMockStore({
      rooms: {
        maxAgentDepth: 1,
        maxAutomaticTurnsPerRoomPerHour: 5,
        maxAutomaticTurnsTotalPerHour: 9,
      },
    });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 1,
      maxAutomaticTurnsPerRoomPerHour: 5,
      maxAutomaticTurnsTotalPerHour: 9,
      // Untouched above, seeded here: the two wait bounds are new keys on a
      // block that predates them, which is the additive half of the same rule.
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('keeps an explicit zero, which is a real choice and not an absent section', () => {
    const store = createMockStore({
      rooms: {
        maxAgentDepth: 0,
        maxAutomaticTurnsPerRoomPerHour: 0,
        maxAutomaticTurnsTotalPerHour: 0,
      },
    });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 0,
      maxAutomaticTurnsPerRoomPerHour: 0,
      maxAutomaticTurnsTotalPerHour: 0,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('adds both spend caps to a rooms block that predates them', () => {
    // The upgrade that matters: someone already had `rooms` from an earlier
    // build of this feature, so conf's shallow merge would never give them the
    // caps. Without this they would run with no posture-independent bound.
    const store = createMockStore({ rooms: { maxAgentDepth: 1 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 1,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('adds the engaged-window ceilings to a rooms block that predates them', () => {
    // The upgrade that matters for RP4: `engaged` becomes the channel default in
    // the same release, so an install whose `rooms` block was written before
    // these keys existed would run the new mode with no window bounding it at
    // all — conf's shallow merge never reaches a nested key on a block already
    // on disk. A shorter window somebody chose survives, because the backfill
    // only fills what is absent.
    const store = createMockStore({ rooms: { maxAgentDepth: 3, engagedWindowMinutes: 2 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 3,
      maxAutomaticTurnsPerRoomPerHour: 60,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 2,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });

  it('carries a chosen value across the per-hour cap rename, rather than resetting it', () => {
    // `maxAutomaticTurnsPerHour` only existed on unreleased builds, and was split
    // into a per-room and a total cap. Anyone running one of those builds has
    // picked a number; silently resetting it to the default would be the kind of
    // quiet data loss a migration is supposed to prevent, and leaving the key in
    // place would make the schema reject the whole config.
    const store = createMockStore({ rooms: { maxAgentDepth: 2, maxAutomaticTurnsPerHour: 7 } });
    backfillRoomsDefaults(store);
    expect(store.data.rooms).toEqual({
      maxAgentDepth: 2,
      maxAutomaticTurnsPerRoomPerHour: 7,
      maxAutomaticTurnsTotalPerHour: 240,
      replyWaitMinutes: 10,
      lateReplyCeilingMinutes: 60,
      engagedWindowMinutes: 10,
      engagedWindowPosts: 5,
      collectDebounceMs: 500,
      collectMaxEntries: 20,
    });
  });
});

describe('backfillWelcomeBackDefaults migration (team-room-home D5.2)', () => {
  it('seeds the section on a config persisted before it existed', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillWelcomeBackDefaults(store);
    // Pinned to the literals the release ships. Reading them out of the schema
    // would only prove the migration and the schema agree, never that they
    // agree on numbers that bound anything.
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('is idempotent — a second run keeps what the first wrote', () => {
    const store = createMockStore({});
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('never clobbers a value the person chose', () => {
    const store = createMockStore({
      welcomeBack: { enabled: false, absenceThresholdMinutes: 720, maxPosts: 1 },
    });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: false,
      absenceThresholdMinutes: 720,
      maxPosts: 1,
      offersEnabled: true,
    });
  });

  it('keeps an explicit off, which is a real choice and not an absent section', () => {
    // The failure that would matter most: someone turned the greetings off, and
    // a `!has` guard on the SECTION would leave that alone, while a truthiness
    // check on the VALUE would hand them back a greeting they refused.
    const store = createMockStore({ welcomeBack: { enabled: false } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: false,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('keeps an explicit zero cap for the same reason', () => {
    const store = createMockStore({ welcomeBack: { maxPosts: 0 } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 0,
      offersEnabled: true,
    });
  });

  it('never turns off an offers opt-in somebody paid for', () => {
    // The one leaf here that costs money. Somebody who turned offers ON said
    // yes to a model turn per greeting agent; an upgrade that quietly seeded
    // `false` over it would take that back without asking, and the person would
    // notice only by the offers no longer arriving.
    const store = createMockStore({ welcomeBack: { offersEnabled: true } });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });

  it('never turns offers back ON for somebody who switched them off (DOR-1121)', () => {
    // The mirror, and the one that matters now that the seed is `true`: an
    // explicit `false` is a value, not an absence, so the fill-if-missing rule
    // must not see a gap where a refusal is. Getting this wrong would bill
    // somebody who had said no, once per return, and the only signal would be
    // offers reappearing.
    const store = createMockStore({ welcomeBack: { offersEnabled: false } });
    backfillWelcomeBackDefaults(store);
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: false,
    });
  });

  it('fills only the missing keys of a block written by an earlier build', () => {
    // conf merges top-level defaults SHALLOWLY, so a `welcomeBack` block already
    // on disk never gains a new nested key on its own. Without this, an install
    // upgraded mid-feature would run returns with no post cap at all — and, since
    // DOR-1046, with no answer at all to whether offers may spend a turn.
    const store = createMockStore({ welcomeBack: { enabled: true } });
    backfillWelcomeBackDefaults(store);
    expect(store.data.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
  });
});

describe('welcomeBack on a config written before it existed (real conf + Ajv)', () => {
  // The half of the surface the mock store cannot answer: correctness must NOT
  // depend on the migration having run. A dev tree resolves SERVER_VERSION to
  // 0.0.0 and runs no migrations at all, and a release below the migration key
  // would skip it for everybody — so the Zod defaults have to produce a valid,
  // fully-populated section on their own.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A config file holding a realistic pre-welcomeBack blob. */
  function seedPreWelcomeBack(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-welcome-back-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true },
        rooms: {
          maxAgentDepth: 3,
          maxAutomaticTurnsPerRoomPerHour: 60,
          maxAutomaticTurnsTotalPerHour: 240,
          replyWaitMinutes: 10,
          lateReplyCeilingMinutes: 60,
          engagedWindowMinutes: 10,
          engagedWindowPosts: 5,
        },
        __internal__: { migrations: { version: '0.57.0' } },
      })
    );
    return dir;
  }

  it('reads back the shipped defaults with no migration having run', () => {
    const manager = new ConfigManager(seedPreWelcomeBack());
    expect(manager.get('welcomeBack')).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
    expect(manager.validate()).toEqual({ valid: true });
  });

  it('is written through explicitly once the migration applies to the same file', () => {
    const dir = seedPreWelcomeBack();
    const configPath = path.join(dir, 'config.json');
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

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    expect(onDisk.welcomeBack).toEqual({
      enabled: true,
      absenceThresholdMinutes: 240,
      maxPosts: 3,
      offersEnabled: true,
    });
    expect(new ConfigManager(dir).validate()).toEqual({ valid: true });
  });

  it('refuses an absence shorter than the floor and a cap past the ceiling', () => {
    // The bounds are the honest part of the schema: below a quarter of an hour
    // is a coffee, not an absence, and a return that could post eleven times is
    // the noise the whole feature exists to avoid.
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 14 } })
        .success
    ).toBe(false);
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 10_081 } })
        .success
    ).toBe(false);
    expect(UserConfigSchema.safeParse({ version: 1, welcomeBack: { maxPosts: 11 } }).success).toBe(
      false
    );
    expect(UserConfigSchema.safeParse({ version: 1, welcomeBack: { maxPosts: -1 } }).success).toBe(
      false
    );
    expect(
      UserConfigSchema.safeParse({ version: 1, welcomeBack: { absenceThresholdMinutes: 90.5 } })
        .success
    ).toBe(false);
    // The edges themselves are legal.
    expect(
      UserConfigSchema.safeParse({
        version: 1,
        welcomeBack: { absenceThresholdMinutes: 15, maxPosts: 0 },
      }).success
    ).toBe(true);
  });
});

describe('backfillSmartGroupKindDefaults migration (smart-agent-groups, DOR-338)', () => {
  it('adds kind: "manual" to every existing group missing it', () => {
    const store = createMockStore({
      ui: {
        theme: 'dark',
        sidebar: {
          pinned: [],
          groups: [
            {
              id: 'g1',
              name: 'Clients',
              agentPaths: ['/a'],
              sortMode: 'manual',
              collapsed: false,
              displayFilter: 'all',
              muted: false,
            },
            {
              id: 'g2',
              name: 'Experiments',
              agentPaths: [],
              sortMode: 'name',
              collapsed: false,
              displayFilter: 'active',
              muted: true,
            },
          ],
        },
      },
    });
    backfillSmartGroupKindDefaults(store);
    const groups = (store.data.ui as { sidebar: { groups: { kind: string }[] } }).sidebar.groups;
    expect(groups[0]!.kind).toBe('manual');
    expect(groups[1]!.kind).toBe('manual');
  });

  it('is idempotent — never overwrites an already-set kind (e.g. a smart group)', () => {
    const existing = {
      theme: 'system',
      sidebar: {
        pinned: [],
        groups: [
          {
            id: 'g1',
            name: 'Active now',
            agentPaths: [],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'smart',
            rules: { statuses: ['needs-attention', 'active'] },
          },
        ],
      },
    };
    const store = createMockStore({ ui: structuredClone(existing) });
    backfillSmartGroupKindDefaults(store);
    expect(store.data.ui).toEqual(existing);
  });

  it('is a no-op when ui.sidebar.groups is absent', () => {
    const store = createMockStore({ ui: { theme: 'dark', sidebar: { pinned: [] } } });
    backfillSmartGroupKindDefaults(store);
    expect(store.data.ui).toEqual({ theme: 'dark', sidebar: { pinned: [] } });
  });

  it('is a no-op when ui.sidebar is absent', () => {
    const store = createMockStore({ ui: { theme: 'dark' } });
    backfillSmartGroupKindDefaults(store);
    expect(store.data.ui).toEqual({ theme: 'dark' });
  });

  it('is a no-op when the ui section is absent entirely', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillSmartGroupKindDefaults(store);
    expect(store.data.ui).toBeUndefined();
  });
});

describe('migrateSidebarMembersToItemRefs migration (sidebar-groups, DOR-579)', () => {
  /** The exact `ui.sidebar` shape on disk before DOR-579: three lists of paths. */
  function priorShapeUi() {
    return {
      theme: 'dark',
      sidebar: {
        pinned: ['/projects/alpha', '/projects/beta'],
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
          {
            id: 'g2',
            name: 'Active now',
            agentPaths: [],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'smart',
            rules: { statuses: ['active'] },
          },
        ],
        ungroupedSortMode: 'name',
        ungroupedCollapsed: false,
        recentsCollapsed: false,
        channelsCollapsed: false,
        dmsCollapsed: false,
        threadsCollapsed: false,
        groupsHintDismissed: false,
        muted: ['/projects/beta'],
        ungroupedDisplayFilter: 'all',
      },
    };
  }

  /** The same config after conversion — every string wrapped as an agent ref. */
  const CONVERTED_SIDEBAR = {
    pinned: [
      { kind: 'agent', path: '/projects/alpha' },
      { kind: 'agent', path: '/projects/beta' },
    ],
    groups: [
      {
        id: 'g1',
        name: 'Clients',
        items: [
          { kind: 'agent', path: '/projects/alpha' },
          { kind: 'agent', path: '/projects/gamma' },
        ],
        sortMode: 'manual',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        kind: 'manual',
      },
      {
        id: 'g2',
        name: 'Active now',
        items: [],
        sortMode: 'recent',
        collapsed: false,
        displayFilter: 'all',
        muted: false,
        kind: 'smart',
        rules: { statuses: ['active'] },
      },
    ],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    channelsCollapsed: false,
    dmsCollapsed: false,
    threadsCollapsed: false,
    groupsHintDismissed: false,
    muted: [{ kind: 'agent', path: '/projects/beta' }],
    ungroupedDisplayFilter: 'all',
  };

  it('converts all three lists and renames agentPaths -> members', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', sidebar: CONVERTED_SIDEBAR });
  });

  it('leaves no agentPaths key behind on any group', () => {
    // Not cosmetic: the generated JSON Schema closes each group object
    // (`additionalProperties: false`), so a leftover key fails conf's
    // post-migration validation and hard-fails startup.
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const groups = (store.data.ui as { sidebar: { groups: Record<string, unknown>[] } }).sidebar
      .groups;
    expect(groups.map((g) => 'agentPaths' in g)).toEqual([false, false]);
  });

  it('produces a shape the schema accepts', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const parsed = UserConfigSchema.parse({ version: 1, ui: store.data.ui });
    // Not `toEqual(CONVERTED_SIDEBAR)`: this migration predates the sidebar
    // redesign, so its output still carries the eight per-section keys that
    // release retired, and Zod strips them here. What this test is about — the
    // three converted membership lists — is unaffected either way.
    expect(parsed.ui.sidebar.pinned).toEqual(CONVERTED_SIDEBAR.pinned);
    expect(parsed.ui.sidebar.groups).toEqual(CONVERTED_SIDEBAR.groups);
    expect(parsed.ui.sidebar.muted).toEqual(CONVERTED_SIDEBAR.muted);
  });

  it('a second run is a no-op — same value, and no write at all', () => {
    const store = createMockStore({ ui: priorShapeUi() });
    migrateSidebarMembersToItemRefs(store);
    const afterFirst = store.data.ui;

    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toEqual({ theme: 'dark', sidebar: CONVERTED_SIDEBAR });
    // `store.set` replaces `data.ui` wholesale, so an unchanged object identity
    // is proof the second run never wrote.
    expect(store.data.ui).toBe(afterFirst);
  });

  it('is a no-op on a fresh install (no ui, or a ui with no sidebar)', () => {
    const noUi = createMockStore({ server: { port: 4242 } });
    migrateSidebarMembersToItemRefs(noUi);
    expect(noUi.data.ui).toBeUndefined();

    const noSidebar = createMockStore({ ui: { theme: 'dark' } });
    const before = noSidebar.data.ui;
    migrateSidebarMembersToItemRefs(noSidebar);
    expect(noSidebar.data.ui).toBe(before);
  });

  it('is a no-op on an empty-but-present sidebar', () => {
    const store = createMockStore({
      ui: { theme: 'dark', sidebar: { pinned: [], groups: [], muted: [] } },
    });
    const before = store.data.ui;
    migrateSidebarMembersToItemRefs(store);
    expect(store.data.ui).toBe(before);
  });

  it('still renames an EMPTY agentPaths list (the key itself must go)', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [{ id: 'g1', name: 'Empty', agentPaths: [] }],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { groups: unknown[] } }).sidebar.groups).toEqual([
      { id: 'g1', name: 'Empty', items: [] },
    ]);
  });

  it('keeps an existing members list and drops a residual agentPaths beside it', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [
            {
              id: 'g1',
              name: 'Clients',
              items: [{ kind: 'room', roomId: 'room-1' }],
              agentPaths: ['/projects/stale'],
            },
          ],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { groups: unknown[] } }).sidebar.groups).toEqual([
      { id: 'g1', name: 'Clients', items: [{ kind: 'room', roomId: 'room-1' }] },
    ]);
  });

  it('converts a half-migrated list without duplicating the refs already in it', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [{ kind: 'agent', path: '/projects/alpha' }, '/projects/beta'],
          groups: [],
          muted: [],
        },
      },
    });
    migrateSidebarMembersToItemRefs(store);
    expect((store.data.ui as { sidebar: { pinned: unknown[] } }).sidebar.pinned).toEqual([
      { kind: 'agent', path: '/projects/alpha' },
      { kind: 'agent', path: '/projects/beta' },
    ]);
  });

  it('runs from the 0.57.0 composite — the release that ships this schema', () => {
    // The whole point of composing into 0.57.0 rather than opening 0.58.0:
    // `conf` only runs keys in `(storedVersion, projectVersion]`, so a 0.58.0
    // body would not run on the 0.57.0 release carrying `items`, and every
    // upgraded install would read the Zod default `[]` and lose its groups.
    const store = createMockStore({ ui: priorShapeUi() });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect((store.data.ui as { sidebar: unknown }).sidebar).toMatchObject({
      pinned: CONVERTED_SIDEBAR.pinned,
      muted: CONVERTED_SIDEBAR.muted,
      groups: CONVERTED_SIDEBAR.groups,
    });
  });
});

describe('CONFIG_MIGRATIONS key invariant (DOR-339 regression guard)', () => {
  // Bit once (0.47.0 -> 0.48.0, see config-manager.ts around the '0.48.0' entry)
  // and again later (a '0.54.0' key drafted as "the next unreleased version"
  // went stale the moment v0.54.0 was tagged while its branch was still open).
  // conf only runs a key in `(storedVersion, projectVersion]`, so a key equal to
  // (or behind) an already-tagged release is silently excluded for every
  // upgrading user — no error, no warning, the backfill just never runs.
  //
  // The rule itself lives in `migration-safety.ts`, as a pure function over the
  // source text and the tag list, and its whole failure matrix is fixture-tested
  // next door in `migration-safety.test.ts`. This test is the other half: it
  // feeds that rule the REAL repository. Splitting it that way is what makes the
  // negative cases testable at all — staging "a migration body appended to an
  // already-tagged key" against real git would mean fabricating tags.
  //
  // Two things this guard checks that the previous one did not. It compares the
  // CONTENT of every shipped migration against the release, not merely whether
  // the key is present — a body appended to an already-tagged composite key ships
  // dead while the key sits there looking fine, and that is DOR-988. And it
  // covers every key, not only the newest.
  //
  // Git tags, not package.json, are the ground truth: a feature branch can sit
  // open past a real release without ever touching its own stale copy of that
  // file, which is exactly how the 0.54.0 bug slipped through. Tags are shared
  // across every worktree of a checkout regardless of which commit a branch sits
  // on. A checkout with no tags is a LOUD failure rather than a fallback, because
  // "I cannot see the releases" and "there is nothing wrong" are different
  // answers; CI checks out with `fetch-depth: 0` for exactly this reason
  // (.github/workflows/test.yml).
  const CONFIG_MANAGER_PATH = 'apps/server/src/services/core/config-manager.ts';

  /** Run a git command from the repo root, or return null when it fails. */
  const git = (args: string): string | null => {
    try {
      return execSync(`git ${args}`, {
        encoding: 'utf-8',
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return null;
    }
  };

  it('parses the real migration table into exactly the keys the module exports', () => {
    // Guard the guard: the rule below compares source slices, so a parser that
    // silently matched nothing would report every migration safe.
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config-manager.ts'),
      'utf-8'
    );
    expect(Object.keys(extractMigrationBodies(source))).toEqual(Object.keys(CONFIG_MIGRATIONS));
  });

  it('every migration key is either unreleased-and-newer or byte-identical to its release', () => {
    const source = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config-manager.ts'),
      'utf-8'
    );
    const tags = (git('tag -l "v*"') ?? '')
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => semver.valid(t) !== null);

    const result = checkMigrationSafety({
      workingSource: source,
      tags,
      // `refs/tags/` rather than a bare `v<version>`, so a branch that happens to
      // share a release's name cannot shadow the tag and be read as the release.
      readAtTag: (version) => git(`show refs/tags/v${version}:${CONFIG_MANAGER_PATH}`),
    });

    expect(result.ok, result.problems.join('\n')).toBe(true);
  });
});

describe('CONFIG_MIGRATIONS append-only pins (DOR-1222 regression guard)', () => {
  // The guard above measures against the newest `v*` TAG, which leaves the
  // merge-to-release window open: for a key above the newest tag it says "new
  // work" and permits any rewrite. That window is not empty. `conf` runs a key
  // in `(storedVersion, projectVersion]`, and `projectVersion` is whatever
  // `SERVER_VERSION` resolves to — the version baked into a built CLI bundle or
  // the desktop app, which is bumped in the repository BEFORE the tag exists.
  // The operator's own config was stamped `0.59.0` on 2026-08-12 while `0.59.0`
  // was "unreleased", so both later amendments to that key skipped him without a
  // word. The dogfood machine is always somebody.
  //
  // So this half pins CONTENT per merged key, against `merged-migration-hashes.ts`
  // rather than against git. That is what makes it answerable offline, in a
  // shallow clone, and — the point — inside the window where no tag exists yet to
  // compare with. The rule and its failure matrix are in
  // `migration-append-only.ts` / `migration-append-only.test.ts`.
  const readConfigManager = (): string =>
    fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config-manager.ts'),
      'utf-8'
    );

  it('reaches into the helper a bare table entry names, not just its name', () => {
    // Guard the guard, and the thing this rule exists to cover that the tag rule
    // does not: `'0.60.0': backfillRoomsDefaults` is one identifier in the table,
    // so a pin that hashed the table slice alone would freeze a NAME while the
    // body it points at stayed editable. That is the shape of DOR-1121.
    const closure = migrationClosure('0.60.0', readConfigManager());
    expect(closure).toContain('maxAutomaticTurnsPerRoomPerHour');
    // And it stops at what the key actually reaches: `offersEnabled` lives in
    // `backfillWelcomeBackDefaults`, which only `'0.59.0'` calls.
    expect(closure).not.toContain('offersEnabled');
  });

  it('every merged migration still hashes to what it was pinned at', () => {
    const result = checkAppendOnly(readConfigManager(), MERGED_MIGRATION_HASHES);
    expect(result.ok, result.problems.join('\n\n')).toBe(true);
  });

  it('lists its keys in ascending semver order, after the legacy sentinel', () => {
    // Neither guard sees a REORDER: hashes are per key and the tag comparison is
    // per key too, so swapping two blocks leaves every check green while
    // changing what actually happens — `conf` runs migrations in the table's
    // INSERTION order, not in version order, and several bodies here depend on
    // running after another (`backfillWorkbenchTerminalGraceTtl` after
    // `backfillWorkbenchDefaults`, the trust-stop backfills after the two
    // `runtimes` ones). Ascending order is what makes insertion order and
    // version order the same thing, so it is asserted rather than hashed — a
    // hash of the key list would go red without saying why.
    //
    // `'1.0.0'` is exempt and pinned to the front. It is the legacy sentinel
    // that seeds `version: 1`, and it is above every version this app has ever
    // carried, so `key <= projectVersion` excludes it and it runs for nobody
    // while DorkOS is 0.x. Its position cannot matter until the app reaches
    // 1.0.0, at which point running first is what a seed body wants anyway.
    const keys = Object.keys(CONFIG_MIGRATIONS);
    expect(keys[0]).toBe('1.0.0');
    const rest = keys.slice(1);
    expect(rest).toEqual([...rest].sort((a, b) => semver.compare(a, b)));
  });
});

describe('backfillRuntimesDefaults migration', () => {
  it('backfills the runtimes section (its frozen pre-T1 shape) when absent', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillRuntimesDefaults(store);
    // 0.47.0 is append-only/frozen: it writes the pre-credential shape. The T1
    // credential fields land via `backfillProvidersDefaults` (0.48.0) or the
    // schema default on read — never by editing this shipped migration body.
    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0 },
      codex: { enabled: true, binaryPath: null },
    });
  });

  it('is idempotent — leaves an existing runtimes config untouched', () => {
    const existing = {
      default: 'opencode',
      opencode: { enabled: false, binaryPath: '/usr/local/bin/opencode', port: 5111 },
      codex: { enabled: true, binaryPath: null },
    };
    const store = createMockStore({ runtimes: existing });
    backfillRuntimesDefaults(store);
    // Same reference: the guard short-circuits before any write.
    expect(store.data.runtimes).toBe(existing);
  });

  it('parses runtimes defaults from a minimal config (schema authority)', () => {
    expect(UserConfigSchema.parse({ version: 1 }).runtimes).toEqual(RUNTIMES_DEFAULTS);
  });

  it('keeps the z.toJSONSchema bridge working (conf Ajv validation)', () => {
    expect(() => z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' })).not.toThrow();
  });
});

describe('backfillExtensionsDisabled migration', () => {
  it('backfills disabled: [] and preserves enabled when disabled is absent', () => {
    const store = createMockStore({ extensions: { enabled: ['linear-issues'] } });
    backfillExtensionsDisabled(store);
    expect(store.data.extensions).toEqual({ enabled: ['linear-issues'], disabled: [] });
  });

  it('is idempotent — leaves a config that already has disabled untouched', () => {
    const store = createMockStore({
      extensions: { enabled: ['hello-world'], disabled: ['marketplace'] },
    });
    backfillExtensionsDisabled(store);
    expect(store.data.extensions).toEqual({
      enabled: ['hello-world'],
      disabled: ['marketplace'],
    });
  });

  it('skips when the extensions key is absent (no throw, no write)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    expect(() => backfillExtensionsDisabled(store)).not.toThrow();
    expect(store.data.extensions).toBeUndefined();
  });

  it('backfills when disabled is present but not an array', () => {
    const store = createMockStore({ extensions: { enabled: [], disabled: 'oops' } });
    backfillExtensionsDisabled(store);
    expect(store.data.extensions).toEqual({ enabled: [], disabled: [] });
  });
});

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
    expect(parsed.harness).toEqual({ autoSync: true, approvedHooks: [] });
  });
});

describe('scrubRetiredOnboardingSteps migration (shorter first-run flow)', () => {
  it('removes retired step ids from completedSteps and skippedSteps, keeping valid ones', () => {
    const store = createMockStore({
      onboarding: {
        completedSteps: ['meet-dorkbot', 'adapters'],
        skippedSteps: ['tasks', 'discovery'],
        startedAt: '2026-07-20T00:00:00Z',
        dismissedAt: null,
      },
    });
    scrubRetiredOnboardingSteps(store);
    expect(store.data.onboarding).toEqual({
      completedSteps: ['meet-dorkbot'],
      skippedSteps: ['discovery'],
      startedAt: '2026-07-20T00:00:00Z',
      dismissedAt: null,
      // 'adapters' in completedSteps marks an old-flow finish — backfilled.
      completedAt: '2026-07-20T00:00:00Z',
    });
  });

  it('does not backfill completedAt for a user who never finished the old flow', () => {
    const store = createMockStore({
      onboarding: {
        completedSteps: ['meet-dorkbot'],
        skippedSteps: ['tasks'],
        startedAt: '2026-07-20T00:00:00Z',
        dismissedAt: null,
      },
    });
    scrubRetiredOnboardingSteps(store);
    expect(store.data.onboarding).toEqual({
      completedSteps: ['meet-dorkbot'],
      skippedSteps: [],
      startedAt: '2026-07-20T00:00:00Z',
      dismissedAt: null,
    });
  });

  it('is idempotent — a config with only valid steps is left untouched (same reference fields)', () => {
    const clean = {
      completedSteps: ['meet-dorkbot', 'discovery'],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
      completedAt: '2026-07-21T00:00:00Z',
    };
    const store = createMockStore({ onboarding: structuredClone(clean) });
    scrubRetiredOnboardingSteps(store);
    expect(store.data.onboarding).toEqual(clean);
  });

  it('is a no-op when the onboarding section is absent (schema default owns that case)', () => {
    const store = createMockStore({ server: { port: 4242 } });
    scrubRetiredOnboardingSteps(store);
    expect(store.data.onboarding).toBeUndefined();
  });

  it('preserves other onboarding fields (completedAt) while scrubbing', () => {
    const store = createMockStore({
      onboarding: {
        completedSteps: ['adapters'],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: '2026-07-21T00:00:00Z',
      },
    });
    scrubRetiredOnboardingSteps(store);
    expect(store.data.onboarding).toEqual({
      completedSteps: [],
      skippedSteps: [],
      startedAt: null,
      dismissedAt: null,
      completedAt: '2026-07-21T00:00:00Z',
    });
  });

  it('the narrowed schema rejects a stale onboarding block until the scrub runs', () => {
    const staleOnboarding = {
      completedSteps: ['meet-dorkbot', 'adapters'],
      skippedSteps: ['tasks'],
      startedAt: null,
      dismissedAt: null,
      completedAt: null,
    };
    // Proves the migration is load-bearing: without it, the narrowed enum fails.
    const before = UserConfigSchema.safeParse({ version: 1, onboarding: staleOnboarding });
    expect(before.success).toBe(false);

    const store = createMockStore({ onboarding: structuredClone(staleOnboarding) });
    scrubRetiredOnboardingSteps(store);
    const after = UserConfigSchema.safeParse({ version: 1, onboarding: store.data.onboarding });
    expect(after.success).toBe(true);
  });

  it('an upgrading config carrying retired steps loads without wiping (full conf path)', () => {
    // Faithful reproduction of the ConfigManager conf wiring, but with an
    // explicit projectVersion of 0.55.0 so the migration actually fires in the
    // test env (SERVER_VERSION lags the unreleased key). conf skips validation
    // during migrations, so the stale 'adapters'/'tasks' survive every earlier
    // migration's writes; the scrub then cleans them before the single
    // post-migration validate — proving no corrupt-recovery wipe on upgrade.
    const dir = path.join(os.tmpdir(), 'test-dork-onboarding-scrub-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        server: { port: 5000, cwd: null, boundary: null, open: true },
        onboarding: {
          completedSteps: ['meet-dorkbot', 'discovery', 'adapters'],
          skippedSteps: ['tasks'],
          startedAt: '2026-07-01T00:00:00Z',
          dismissedAt: null,
        },
        __internal__: { migrations: { version: '0.54.0' } },
      }),
      'utf-8'
    );

    const store = new Conf({
      configName: 'config',
      cwd: dir,
      // The shipped schema, tolerances included — never rebuilt here (see CONF_JSON_SCHEMA).
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.55.0',
      migrations: CONFIG_MIGRATIONS,
    });

    const onboarding = store.get('onboarding') as {
      completedSteps: string[];
      skippedSteps: string[];
      completedAt: string | null;
    };
    expect(onboarding.completedSteps).toEqual(['meet-dorkbot', 'discovery']);
    expect(onboarding.skippedSteps).toEqual([]);
    // The retired synthetic 'adapters' completion marked the old flow's finish,
    // so the upgrade backfills the new authoritative signal — an
    // already-onboarded user is never re-onboarded.
    expect(onboarding.completedAt).toBe('2026-07-01T00:00:00Z');
    // Unrelated user data survives the upgrade untouched.
    expect((store.get('server') as { port: number }).port).toBe(5000);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('approvals section — standing permissions (DOR-501)', () => {
  it('fresh install: the schema default has standing permissions switched OFF', () => {
    // A safety feature does not arrive switched on. Nothing changes for anyone
    // until they ask for it.
    expect(USER_CONFIG_DEFAULTS.approvals).toEqual({
      standingGrants: false,
      trustWindowMinutes: 480,
      // Nothing has been voided yet, which is the only honest starting point: an
      // upgrade must not retroactively end permissions (DOR-520).
      standingGrantsVoidBefore: null,
    });
  });

  it('upgraded install: seeds the section OFF and leaves other settings alone', () => {
    const store = createMockStore({ auth: { enabled: true }, server: { port: 5000 } });
    backfillApprovalsDefaults(store);
    expect(store.data.approvals).toEqual({
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    expect(store.data.auth).toEqual({ enabled: true });
    expect(store.data.server).toEqual({ port: 5000 });
  });

  it('never re-relaxes a choice the person already made', () => {
    // Idempotent, and idempotent in the direction that matters: re-running must
    // not turn a live setting back off, nor a deliberate off back on.
    const store = createMockStore({
      approvals: { standingGrants: true, trustWindowMinutes: 60 },
    });
    backfillApprovalsDefaults(store);
    backfillApprovalsDefaults(store);
    expect(store.data.approvals).toEqual({
      standingGrants: true,
      trustWindowMinutes: 60,
      // The second seed reaches an `approvals` block an earlier build of the same
      // unreleased key already wrote, and adds only the missing leaf.
      standingGrantsVoidBefore: null,
    });
  });

  it('a config written before the section existed upgrades without a wipe (full conf path)', () => {
    // The half of the surface a fresh-install test cannot reach: a real stored
    // file from an earlier version, run through the real migration chain.
    // projectVersion is stated explicitly because SERVER_VERSION lags the
    // unreleased key this migration is filed under.
    //
    // What this does NOT prove is that `backfillApprovalsDefaults` ran: suppress
    // that body and every assertion here still passes (measured, DOR-1496).
    // `approvals` is a whole TOP-LEVEL section, and conf merges `defaults` under
    // the parsed file and WRITES the result before its first migration key, so
    // the section reaches disk either way — unlike a nested seed such as
    // `ui.promos`, where the body is the only writer. The body is pinned by the
    // mock-store cases above; this one is about the upgrade boot surviving.
    const dir = path.join(os.tmpdir(), 'test-dork-approvals-backfill-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        server: { port: 5000, cwd: null, boundary: null, open: true },
        auth: { enabled: true },
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.56.0' } },
      }),
      'utf-8'
    );

    const store = new Conf({
      configName: 'config',
      cwd: dir,
      // The shipped schema, tolerances included — never rebuilt here (see CONF_JSON_SCHEMA).
      schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
      defaults: USER_CONFIG_DEFAULTS,
      clearInvalidConfig: false,
      projectVersion: '0.57.0',
      migrations: CONFIG_MIGRATIONS,
    });

    const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      approvals: unknown;
      ui: Record<string, unknown>;
    };
    expect(onDisk.approvals).toEqual({
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    // The upgrade does not disturb what was already there, including the login
    // setting standing permissions depend on.
    expect((store.get('auth') as { enabled: boolean }).enabled).toBe(true);
    expect((store.get('server') as { port: number }).port).toBe(5000);
    expect(onDisk.ui.theme).toBe('dark');
    // The composite key's other body still ran, so composing did not drop it.
    // Read off the FILE, unlike the rest: `ui.statusBar` is a NESTED seed into a
    // `ui` object the stored config already has, so `store.get('ui')` would show
    // it whether or not `migrateStatusBarToPins` ran — Ajv fills it into the copy
    // conf's getter is about to hand back, and the copy is thrown away. That form
    // could not have detected the composition being dropped, which is the one
    // thing this line is here to detect.
    expect(onDisk.ui.statusBar).toEqual({ pins: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('the standing-permission posture floor (DOR-520)', () => {
  // `ConfigManager` is the one seam every writer of these settings travels,
  // including `dorkos config set` in a process with no database and no routes. It
  // records the moment the settings stopped licensing standing permissions so the
  // store can refuse the ones that moment invalidated. This describes the WRITE
  // half; the read half is
  // `services/core/approvals/__tests__/approval-grant-service.test.ts`.
  let dir: string;

  /** Both halves of the posture on, which is the only state a floor can move from. */
  function licensed() {
    const manager = initConfigManager(dir);
    manager.setDot('auth.enabled', true);
    manager.setDot('approvals.standingGrants', true);
    return manager;
  }

  /** The stored floor, or `null` when nothing has narrowed. */
  function floor(manager: ReturnType<typeof initConfigManager>): string | null {
    return manager.get('approvals').standingGrantsVoidBefore;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-void-floor-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts with no floor, because nothing has been voided', () => {
    expect(floor(licensed())).toBeNull();
  });

  it('stamps the floor when the master switch is switched off', () => {
    const manager = licensed();
    manager.setDot('approvals.standingGrants', false);
    expect(floor(manager)).toEqual(expect.any(String));
  });

  it('stamps the floor when login is switched off, which takes the same license away', () => {
    const manager = licensed();
    manager.setDot('auth.enabled', false);
    expect(floor(manager)).toEqual(expect.any(String));
  });

  it('stamps the floor on a whole-section write, which is how `PATCH /api/config` lands', () => {
    const manager = licensed();
    manager.set('approvals', {
      standingGrants: false,
      trustWindowMinutes: 480,
      standingGrantsVoidBefore: null,
    });
    expect(floor(manager)).toEqual(expect.any(String));
  });

  it('stamps the floor on `dorkos config reset`', () => {
    const manager = licensed();
    manager.reset();
    expect(floor(manager)).toEqual(expect.any(String));
  });

  it('stamps the floor on a reset of the approvals section alone', () => {
    const manager = licensed();
    manager.reset('approvals');
    expect(floor(manager)).toEqual(expect.any(String));
  });

  it('moves nothing when an unrelated setting is written', () => {
    // A floor that crept forward on every write would end standing permissions
    // whenever anyone changed the log level — the same bug wearing better clothes.
    const manager = licensed();
    manager.setDot('logging.level', 'debug');
    manager.set('ui', { ...manager.get('ui'), theme: 'dark' });
    expect(floor(manager)).toBeNull();
  });

  it('moves nothing when a setting is switched ON', () => {
    // Turning something on grants nothing and voids nothing. A permission is
    // always a fresh human decision.
    const manager = initConfigManager(dir);
    manager.setDot('auth.enabled', true);
    manager.setDot('approvals.standingGrants', true);
    expect(floor(manager)).toBeNull();
  });

  it('leaves an existing floor alone when the settings are switched back on', () => {
    // The stamp is what a later switch-on must NOT erase: erasing it is exactly
    // how the permissions it voided would come back.
    const manager = licensed();
    manager.setDot('approvals.standingGrants', false);
    const stamped = floor(manager);
    manager.setDot('approvals.standingGrants', true);
    expect(floor(manager)).toBe(stamped);
  });

  it('records the narrowing a SECOND manager performs, which is what the CLI is', () => {
    // The whole point of putting the marker in the config file: `dorkos config
    // set` holds its own manager in its own process, so a marker anywhere the
    // server owns would never be written at all.
    const server = licensed();
    const cli = new ConfigManager(dir);
    cli.setDot('approvals.standingGrants', false);
    cli.setDot('approvals.standingGrants', true);

    expect(floor(server)).toEqual(expect.any(String));
  });
});

describe('the posture floor is monotonic (DOR-520 review)', () => {
  // The floor is only worth anything if it can never go backwards. The first
  // version stamped on the licensed -> unlicensed TRANSITION, which meant any
  // write performed while ALREADY narrowed could put the leaf back to its default
  // and silently delete the marker. Review reproduced a live resurrection through
  // `dorkos config reset` using only verbs this feature claims to cover.
  let dir: string;

  /** Both halves of the posture on. */
  function licensed() {
    const manager = initConfigManager(dir);
    manager.setDot('auth.enabled', true);
    manager.setDot('approvals.standingGrants', true);
    return manager;
  }

  /** The stored floor, or `null` when nothing has narrowed. */
  function floor(manager: ReturnType<typeof initConfigManager>): string | null {
    return manager.get('approvals').standingGrantsVoidBefore;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-floor-monotonic-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives `dorkos config reset` performed while the switch is ALREADY off', () => {
    // The reproduction. Every step is a verb this feature claims to cover.
    const manager = licensed();
    manager.setDot('approvals.standingGrants', false);
    const stamped = floor(manager);
    expect(stamped).toEqual(expect.any(String));

    manager.reset();

    expect(floor(manager)).toBe(stamped);
  });

  it('survives `dorkos config reset approvals` performed while login is ALREADY off', () => {
    // The same hole reached through the other half of the posture.
    const manager = licensed();
    manager.setDot('auth.enabled', false);
    const stamped = floor(manager);
    expect(stamped).toEqual(expect.any(String));

    manager.reset('approvals');

    expect(floor(manager)).toBe(stamped);
  });

  it('survives a whole-section write that carries a stale null, while already narrowed', () => {
    // What a batched `PATCH /api/config` does: `applyConfigPatch` computes the
    // merged value ONCE from the pre-write snapshot, then writes each top-level
    // section in turn. A section written after `auth` narrowed carries the
    // snapshot's `standingGrantsVoidBefore: null` and used to erase the stamp.
    const manager = licensed();
    manager.setDot('auth.enabled', false);
    const stamped = floor(manager);

    manager.set('approvals', {
      standingGrants: true,
      trustWindowMinutes: 60,
      standingGrantsVoidBefore: null,
    });

    expect(floor(manager)).toBe(stamped);
  });

  it('advances the floor on a SECOND narrowing rather than leaving the first one', () => {
    // Defense in depth: the routes refuse to create a permission while the switch
    // is off, so nothing can be granted between the two narrowings today. A floor
    // that silently stopped moving would be a trap for whoever changes that.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T10:00:00.000Z'));
    const manager = licensed();
    manager.setDot('approvals.standingGrants', false);
    const first = floor(manager)!;

    manager.setDot('approvals.standingGrants', true);
    vi.setSystemTime(new Date('2026-07-26T11:00:00.000Z'));
    manager.setDot('approvals.standingGrants', false);
    const second = floor(manager)!;
    vi.useRealTimers();

    expect(first).toBe('2026-07-26T10:00:00.000Z');
    expect(second).toBe('2026-07-26T11:00:00.000Z');
  });

  it('keeps the later floor when the clock goes backwards', () => {
    // A floor that follows a backwards clock is a floor an NTP correction can
    // lower. `max` is what makes the marker monotonic rather than merely current.
    const manager = licensed();
    manager.setDot('approvals.standingGrants', false);
    const first = floor(manager)!;

    manager.setDot('approvals.standingGrants', true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(first) - 60_000));
    manager.setDot('approvals.standingGrants', false);
    vi.useRealTimers();

    expect(floor(manager)).toBe(first);
  });

  it('still writes nothing at all when the posture never narrowed', () => {
    // The churn guard. A rule stated as "stamp whenever the posture is not
    // licensed after the write" would move the floor on EVERY config write for the
    // vast majority of installs, which never switch this feature on.
    const manager = initConfigManager(dir);
    manager.setDot('logging.level', 'debug');
    manager.setDot('server.port', 4300);
    expect(floor(manager)).toBeNull();
  });
});

describe('migrateSidebarSectionPrefs migration (sidebar-now-today-library §D)', () => {
  /**
   * The exact `ui.sidebar` on disk before the redesign, with EVERY retired key
   * set to something the person chose — not to its default. A fixture of
   * defaults would pass a migration that dropped the lot on the floor.
   */
  function priorSidebar(): Record<string, unknown> {
    return {
      pinned: [{ kind: 'agent', path: '/projects/alpha' }],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [{ kind: 'agent', path: '/projects/alpha' }],
          sortMode: 'manual',
          collapsed: true,
          displayFilter: 'attention',
          muted: true,
          kind: 'manual',
        },
      ],
      ungroupedSortMode: 'recent',
      ungroupedCollapsed: true,
      recentsCollapsed: true,
      channelsCollapsed: true,
      dmsCollapsed: true,
      threadsCollapsed: true,
      groupsHintDismissed: true,
      muted: [{ kind: 'agent', path: '/projects/beta' }],
      ungroupedDisplayFilter: 'active',
    };
  }

  /** A store holding {@link priorSidebar} under a realistic `ui` block. */
  function seeded() {
    return createMockStore({ ui: { theme: 'dark', sidebar: priorSidebar() } });
  }

  /** The `ui.sidebar` a store is holding right now. */
  const sidebarOf = (store: { data: Record<string, unknown> }): Record<string, unknown> =>
    (store.data.ui as { sidebar: Record<string, unknown> }).sidebar;

  it('carries every collapse, sort and filter choice into `sections`', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).sections).toEqual({
      agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' },
      channels: { collapsed: true },
      dms: { collapsed: true },
      threads: { collapsed: true },
      recents: { collapsed: true },
    });
  });

  it('translates a dismissed groups hint into a retired suggestion', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({ retired: [GROUPS_HINT_SUGGESTION_ID] });
  });

  it('leaves nothing of the eight retired keys behind', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    const after = sidebarOf(store);
    for (const key of [
      'ungroupedCollapsed',
      'channelsCollapsed',
      'dmsCollapsed',
      'threadsCollapsed',
      'recentsCollapsed',
      'ungroupedSortMode',
      'ungroupedDisplayFilter',
      'groupsHintDismissed',
    ]) {
      expect(key in after).toBe(false);
    }
  });

  it('leaves pins, groups and mutes byte-identical', () => {
    // The person's own manual structure. The programme's promise is that it
    // never moves, so this is asserted rather than assumed.
    const store = seeded();
    const before = priorSidebar();
    migrateSidebarSectionPrefs(store);
    const after = sidebarOf(store);
    expect(after.pinned).toEqual(before.pinned);
    expect(after.groups).toEqual(before.groups);
    expect(after.muted).toEqual(before.muted);
  });

  it('is idempotent — a second run writes nothing at all', () => {
    const store = seeded();
    migrateSidebarSectionPrefs(store);
    const afterFirst = structuredClone(store.data);

    const writes: string[] = [];
    const watched = {
      ...store,
      set: (key: string, value: unknown) => {
        writes.push(key);
        store.set(key, value);
      },
    };
    migrateSidebarSectionPrefs(watched);

    expect(writes).toEqual([]);
    expect(store.data).toEqual(afterFirst);
  });

  it('does not clobber a `sections` record that is already there', () => {
    // Migrated, downgraded, upgraded again: `sections` holds choices made SINCE
    // the retired flags were last written, so a stale flag must not win.
    const store = createMockStore({
      ui: {
        sidebar: {
          ...priorSidebar(),
          sections: { channels: { collapsed: false }, agents: { collapsed: false } },
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    const sections = sidebarOf(store).sections as Record<string, unknown>;
    expect(sections.channels).toEqual({ collapsed: false });
    // The existing entry wins on `collapsed`; the fields it did not answer for
    // still come across.
    expect(sections.agents).toEqual({
      collapsed: false,
      sortMode: 'recent',
      displayFilter: 'active',
    });
  });

  it('keeps a suggestion already retired, and never records it twice', () => {
    const store = createMockStore({
      ui: {
        sidebar: {
          ...priorSidebar(),
          gettingStarted: { retired: ['suggestion:ask-dorkbot', GROUPS_HINT_SUGGESTION_ID] },
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({
      retired: ['suggestion:ask-dorkbot', GROUPS_HINT_SUGGESTION_ID],
    });
  });

  it('writes nothing for `groupsHintDismissed: false`', () => {
    const store = createMockStore({
      ui: { sidebar: { pinned: [], groups: [], muted: [], groupsHintDismissed: false } },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).gettingStarted).toEqual({ retired: [] });
  });

  it('does not carry a value that already equals its old default', () => {
    // A default and an absent key say the same thing on both sides, so copying
    // one would write a block of noise into every config on earth.
    const store = createMockStore({
      ui: {
        sidebar: {
          pinned: [],
          groups: [],
          muted: [],
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          channelsCollapsed: false,
          dmsCollapsed: false,
          threadsCollapsed: false,
          groupsHintDismissed: false,
          ungroupedDisplayFilter: 'all',
        },
      },
    });
    migrateSidebarSectionPrefs(store);
    expect(sidebarOf(store).sections).toEqual({});
    expect('ungroupedCollapsed' in sidebarOf(store)).toBe(false);
  });

  it('produces a valid `sections` for a config missing some of the old flags', () => {
    // Prove the check can fail on absence rather than throwing: a config that
    // predates one of the flags (say, a pre-DOR-525 sidebar with no room
    // sections at all) still migrates.
    const store = createMockStore({
      ui: { sidebar: { pinned: [], groups: [], muted: [], ungroupedCollapsed: true } },
    });
    expect(() => migrateSidebarSectionPrefs(store)).not.toThrow();
    expect(sidebarOf(store).sections).toEqual({ agents: { collapsed: true } });
  });

  it('is a no-op on a store with no `ui` and on one with no `ui.sidebar`', () => {
    const noUi = createMockStore({});
    migrateSidebarSectionPrefs(noUi);
    expect(noUi.data).toEqual({});

    const noSidebar = createMockStore({ ui: { theme: 'dark' } });
    migrateSidebarSectionPrefs(noSidebar);
    expect(noSidebar.data).toEqual({ ui: { theme: 'dark' } });
  });

  it('leaves every other section of the config alone', () => {
    const store = createMockStore({
      ui: { theme: 'dark', sidebar: priorSidebar() },
      telemetry: { userHasDecided: true, install: false },
    });
    migrateSidebarSectionPrefs(store);
    expect(store.data.telemetry).toEqual({ userHasDecided: true, install: false });
    expect((store.data.ui as { theme: string }).theme).toBe('dark');
  });
});

describe('a Claude account registry written before ids, through the real conf load path', () => {
  // The expensive failure lives at the conf/Ajv seam, and the mock-store
  // migration tests above cannot see it: `accounts[].id` is REQUIRED and did not
  // exist before 0.65.0, so EVERY config file ever written is schema-invalid the
  // moment the `'0.65.0'` migration is skipped — and ConfigManager's recovery
  // path then backs up and replaces the WHOLE file, not just the accounts.
  //
  // `new ConfigManager(dir)` resolves SERVER_VERSION to `0.0.0` (the dev
  // /package.json fallback), so NO migration runs. That is what every `pnpm dev`
  // does, and what a release cut below 0.65.0 would do to every user on it.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A config file holding a pre-0.65.0 Claude account registry. */
  function seedPreLadder(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-pre-account-ladder-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        // Unrelated sections carrying real choices, so a silent whole-file reset
        // is visible rather than coincidentally identical to the defaults.
        mesh: { ...USER_CONFIG_DEFAULTS.mesh, scanRoots: ['/projects/alpha'] },
        telemetry: { userHasDecided: true, install: false, heartbeat: false },
        runtimes: {
          ...USER_CONFIG_DEFAULTS.runtimes,
          claudeCode: {
            activeAccount: '/Users/me/.claude2',
            accounts: [
              { path: '/Users/me/.claude2', label: 'Acme Corp' },
              { path: '/Users/me/.claude3', label: null },
            ],
          },
        },
        __internal__: { migrations: { version: '0.64.0' } },
      })
    );
    return { dir, configPath };
  }

  it('is not condemned — no backup is written and the file is not replaced', () => {
    const { dir } = seedPreLadder();
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
  });

  it('keeps every unrelated section, including a telemetry opt-out and the scan roots', () => {
    // The real cost of condemning the file, stated as an assertion: this is what
    // a person loses when a required field lands without a schema tolerance.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);
    expect(manager.get('mesh').scanRoots).toEqual(['/projects/alpha']);
    expect(manager.get('telemetry').userHasDecided).toBe(true);
    expect(manager.get('telemetry').install).toBe(false);
  });

  it('still refuses an id of the WRONG TYPE — tolerance is about absence only', () => {
    // Dropping `id` from `required` must not become "stop validating ids". A
    // number where a slug belongs is damage, not skew.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-bad-account-id-'));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, 'config.json'),
      JSON.stringify({
        version: 1,
        runtimes: {
          ...USER_CONFIG_DEFAULTS.runtimes,
          claudeCode: {
            defaultAccount: null,
            accounts: [{ id: 42, path: '/Users/me/.claude2', label: null }],
          },
        },
        __internal__: { migrations: { version: '0.64.0' } },
      })
    );
    new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(true);
  });

  it('still accepts a settings write while the migration has not run', () => {
    // `applyConfigPatch` re-parses the whole MERGED config with Zod, and Zod is
    // the half that HEALS rather than tolerates. Without the backfill inside
    // `ClaudeCodeAccountsSchema` that parse fails on the missing ids and EVERY
    // settings write in the cockpit is refused — a theme change included —
    // until the migration runs. Ajv tolerance alone does not cover this.
    const { dir, configPath } = seedPreLadder();
    initConfigManager(dir);

    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      ui: { theme: string };
      runtimes: { claudeCode: { accounts: { path: string }[] } };
    };
    // The write landed, and the registry it did not name is untouched — conf
    // persists the sections a patch writes, so the ids are healed on every parse
    // rather than rewritten here. The migration is what settles them on disk.
    expect(onDisk.ui.theme).toBe('light');
    expect(onDisk.runtimes.claudeCode.accounts.map((a) => a.path)).toEqual([
      '/Users/me/.claude2',
      '/Users/me/.claude3',
    ]);
  });

  it("keeps the stored registry readable as-is — the healing is the READER's job", () => {
    // Deliberately NOT a claim about what a launch sees. This file's subject is
    // the conf load path: the file is accepted, and what conf hands back is what
    // is on disk, ids and all still absent until the migration writes them.
    //
    // Parsing it here with Zod would prove only that Zod heals, which is not the
    // question a LAUNCH asks — nothing on the launch path consults Zod. That
    // claim belongs to the seam the ladder actually reads, and it is made
    // against `describeClaudeCodeAccounts` and `resolveLaunchAccountRoot` in
    // `runtimes/claude-code/__tests__/pre-ladder-config.test.ts`.
    const { dir } = seedPreLadder();
    const stored = new ConfigManager(dir).getAll();
    expect(stored.runtimes.claudeCode.accounts.map((a) => a.path)).toEqual([
      '/Users/me/.claude2',
      '/Users/me/.claude3',
    ]);
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

describe('applyTier1OptInDefaults migration', () => {
  it('turns the Tier 1 channels off for an install that never answered', () => {
    // The population the 0.48.0 flip enrolled by silence — including one whose
    // first-run notice has since been shown, so it is sending today.
    const store = createMockStore({
      telemetry: {
        userHasDecided: false,
        install: true,
        heartbeat: true,
        usage: true,
        lastPromptedVersion: '0.56.0',
      },
    });
    applyTier1OptInDefaults(store);
    expect(store.data.telemetry).toMatchObject({
      install: false,
      heartbeat: false,
      usage: false,
      userHasDecided: false,
      // Not re-prompted: the consent surfaces are the way back in.
      lastPromptedVersion: '0.56.0',
    });
  });

  it('never overrides an explicit choice to keep sharing', () => {
    const decidedYes = {
      userHasDecided: true,
      install: true,
      heartbeat: true,
      usage: true,
      errorReporting: false,
    };
    const store = createMockStore({ telemetry: { ...decidedYes } });
    applyTier1OptInDefaults(store);
    expect(store.data.telemetry).toEqual(decidedYes);
  });

  it('never overrides an explicit choice to opt out', () => {
    const decidedNo = { userHasDecided: true, install: false, heartbeat: false, usage: false };
    const store = createMockStore({ telemetry: { ...decidedNo } });
    applyTier1OptInDefaults(store);
    expect(store.data.telemetry).toEqual(decidedNo);
  });

  it('is idempotent and leaves an absent block alone', () => {
    const already = { userHasDecided: false, install: false, heartbeat: false, usage: false };
    const store = createMockStore({ telemetry: { ...already } });
    applyTier1OptInDefaults(store);
    expect(store.data.telemetry).toEqual(already);

    const noBlock = createMockStore({ server: { port: 4242 } });
    applyTier1OptInDefaults(noBlock);
    expect(noBlock.data.telemetry).toBeUndefined();
  });
});

/**
 * The conf/Ajv seam. A schema change is not proven by a mock store: mock stores
 * never construct `conf`, and `UserConfigSchema.parse` strips unknown keys where
 * Ajv rejects them.
 */
describe('Tier 1 opt-in defaults (real conf + Ajv)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(stored: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-tier1-optin-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ version: 1, ...stored }));
    return dir;
  }

  it('gives a brand-new install every Tier 1 channel off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-tier1-optin-'));
    dirs.push(dir);
    const telemetry = new ConfigManager(dir).get('telemetry');
    expect(telemetry).toEqual({
      userHasDecided: false,
      install: false,
      heartbeat: false,
      errorReporting: false,
      lastPromptedVersion: null,
      usage: false,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    });
  });

  it('leaves an explicit decision to keep sharing intact through a real load', () => {
    const dir = seed({
      telemetry: {
        userHasDecided: true,
        install: true,
        heartbeat: true,
        errorReporting: false,
        lastPromptedVersion: '0.56.0',
        usage: true,
        linkAnalyticsToAccount: false,
        aiMetadata: false,
      },
    });
    const manager = new ConfigManager(dir);
    expect(manager.get('telemetry').install).toBe(true);
    expect(manager.get('telemetry').usage).toBe(true);
    expect(manager.validate()).toEqual({ valid: true });
  });
});

describe('backfillRuntimeExecutionDefaults migration (execution-defaults E1)', () => {
  it('seeds the new leaves onto runtime sections already on disk', () => {
    // The case it exists for: conf's defaults-merge is shallow, so a `runtimes`
    // block written by an earlier release never gains a nested key on its own.
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: null, accounts: [] },
        opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
        codex: { enabled: true, binaryPath: null, credentialRef: null },
      },
    });

    backfillRuntimeExecutionDefaults(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: { activeAccount: null, accounts: [], defaultModel: null, defaultEffort: null },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        // OpenCode gets a model and no effort: its API accepts none, so a field
        // there would be a setting that does nothing.
        defaultModel: null,
      },
      codex: {
        enabled: true,
        binaryPath: null,
        credentialRef: null,
        defaultModel: null,
        defaultEffort: null,
      },
    });
  });

  it('never overwrites a value somebody already chose', () => {
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: null, accounts: [], defaultModel: 'opus' },
      },
    });

    backfillRuntimeExecutionDefaults(store);
    backfillRuntimeExecutionDefaults(store);

    expect((store.data.runtimes as Record<string, unknown>).claudeCode).toEqual({
      activeAccount: null,
      accounts: [],
      defaultModel: 'opus',
      defaultEffort: null,
    });
  });

  it('leaves a config with no runtimes block alone', () => {
    // The section-level backfills that run before it own that case.
    const store = createMockStore({ server: { port: 4242 } });
    backfillRuntimeExecutionDefaults(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('rides the newest migration key, after the section it seeds into exists', () => {
    const store = createMockStore({ runtimes: { default: 'claude-code' } });
    CONFIG_MIGRATIONS['0.57.0'](store);
    expect((store.data.runtimes as Record<string, unknown>).claudeCode).toEqual({
      activeAccount: null,
      accounts: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
    });
  });
});

describe('backfillDefaultTrustStops migration (trust-dial, decision 6)', () => {
  it('seeds the global stop and every per-runtime override, all null', () => {
    // `null` is "let the runtime decide" — an upgrade must never move anybody's
    // new sessions to a stop they did not choose, least of all the silent one.
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: null, accounts: [] },
        opencode: { enabled: true, binaryPath: null, port: 0 },
        codex: { enabled: true, binaryPath: null },
      },
    });

    backfillDefaultTrustStops(store);

    const runtimes = store.data.runtimes as Record<string, Record<string, unknown>>;
    expect(runtimes.defaultTrustStop).toBeNull();
    expect(runtimes.claudeCode.defaultTrustStop).toBeNull();
    expect(runtimes.opencode.defaultTrustStop).toBeNull();
    expect(runtimes.codex.defaultTrustStop).toBeNull();
  });

  it('never overwrites a stop somebody already chose, however often it runs', () => {
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: 'autonomy',
        codex: { enabled: true, defaultTrustStop: 'ask' },
      },
    });

    backfillDefaultTrustStops(store);
    backfillDefaultTrustStops(store);

    const runtimes = store.data.runtimes as Record<string, Record<string, unknown>>;
    expect(runtimes.defaultTrustStop).toBe('autonomy');
    expect(runtimes.codex.defaultTrustStop).toBe('ask');
  });

  it('leaves a config with no runtimes block alone', () => {
    const store = createMockStore({ server: { port: 4242 } });
    backfillDefaultTrustStops(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('rides the newest migration key', () => {
    const store = createMockStore({ runtimes: { default: 'claude-code' } });
    CONFIG_MIGRATIONS['0.57.0'](store);
    // Only the leaves the composite's earlier bodies actually seeded a section
    // for: `backfillClaudeCodeRuntimeDefaults` supplies `claudeCode`, and a
    // `runtimes` block with no `codex` object has nothing to add a leaf to.
    const runtimes = store.data.runtimes as Record<string, Record<string, unknown>>;
    expect(runtimes.defaultTrustStop).toBeNull();
    expect(runtimes.claudeCode.defaultTrustStop).toBeNull();
  });
});

describe('backfillClaudeCodePersistentSession migration (persistent-session-runtime P3)', () => {
  it('seeds the opt-in OFF onto a claudeCode section already on disk', () => {
    // The case it exists for: conf's defaults-merge is shallow, so a
    // `runtimes.claudeCode` block written by an earlier release never gains a
    // nested key on its own.
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: null, accounts: [], defaultModel: 'opus' },
        codex: { enabled: true },
      },
    });

    backfillClaudeCodePersistentSession(store);

    expect(store.data.runtimes).toEqual({
      default: 'claude-code',
      claudeCode: {
        activeAccount: null,
        accounts: [],
        defaultModel: 'opus',
        persistentSession: false,
      },
      // Untouched: the setting is claude-code's, and no other section grows one.
      codex: { enabled: true },
    });
  });

  it('never turns off an opt-in somebody already turned on, however often it runs', () => {
    const store = createMockStore({
      runtimes: {
        default: 'claude-code',
        claudeCode: { activeAccount: null, accounts: [], persistentSession: true },
      },
    });

    backfillClaudeCodePersistentSession(store);
    backfillClaudeCodePersistentSession(store);

    expect((store.data.runtimes as Record<string, unknown>).claudeCode).toEqual({
      activeAccount: null,
      accounts: [],
      persistentSession: true,
    });
  });

  it('leaves a config with no runtimes block alone', () => {
    // The section-level backfills in the earlier keys own that case.
    const store = createMockStore({ server: { port: 4242 } });
    backfillClaudeCodePersistentSession(store);
    expect(store.data.runtimes).toBeUndefined();
  });

  it('leaves a runtimes block with no claudeCode section alone', () => {
    const store = createMockStore({ runtimes: { default: 'codex' } });
    backfillClaudeCodePersistentSession(store);
    expect(store.data.runtimes).toEqual({ default: 'codex' });
  });

  it('rides the 0.59.0 key, which is the release that ships the field', () => {
    const store = createMockStore({
      runtimes: { default: 'claude-code', claudeCode: { activeAccount: null, accounts: [] } },
    });

    CONFIG_MIGRATIONS['0.59.0'](store);

    expect((store.data.runtimes as Record<string, Record<string, unknown>>).claudeCode).toEqual({
      activeAccount: null,
      accounts: [],
      persistentSession: false,
    });
  });
});

describe('ConfigManager.onChange (the live-apply primitive)', () => {
  let dir: string;

  beforeEach(() => {
    dir = path.join(os.tmpdir(), 'test-dork-onchange-' + Date.now() + Math.random());
    fs.mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports the section a whole-section write touched', () => {
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.set('runtimes', { ...manager.get('runtimes'), default: 'codex' });

    expect(seen).toEqual([['runtimes']]);
  });

  it('reports the SECTION a dot-path write touched, not the path', () => {
    // Subscribers ask "did my settings change?", and `runtimes.default` and
    // `runtimes` are the same news.
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.setDot('runtimes.default', 'codex');

    expect(seen).toEqual([['runtimes']]);
  });

  it('reports every section on a whole-config reset', () => {
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    manager.reset();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('runtimes');
    expect(seen[0]).toContain('ui');
  });

  it('stops calling a listener that unsubscribed', () => {
    const manager = new ConfigManager(dir);
    const listener = vi.fn();
    manager.onChange(listener)();

    manager.setDot('runtimes.default', 'codex');

    expect(listener).not.toHaveBeenCalled();
  });

  it('lets a throwing listener neither break the write nor silence the next one', () => {
    // The write has already landed by the time listeners run; a subscriber that
    // throws must not turn somebody's settings change into an error.
    const manager = new ConfigManager(dir);
    const second = vi.fn();
    manager.onChange(() => {
      throw new Error('listener blew up');
    });
    manager.onChange(second);

    expect(() => manager.setDot('runtimes.default', 'codex')).not.toThrow();
    expect(manager.getDot('runtimes.default')).toBe('codex');
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('fires for a write made through PATCH /api/config', () => {
    // The path that matters: the Settings screen and the `config_patch` operator
    // tool both reach the store through `applyConfigPatch`, and a person who
    // changes the default runtime there expects it to hold without a restart.
    const manager = initConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.sections]));

    const result = applyConfigPatch({ runtimes: { default: 'codex' } });

    expect(result.ok).toBe(true);
    expect(seen).toEqual([['runtimes']]);
  });
});

describe('config.json holds the EFFECTIVE config, not what was set (DOR-1267)', () => {
  // What these pin, and why they are worth pinning.
  //
  // Deleting `rooms.collectDebounceMs` and `rooms.collectMaxEntries` by hand and
  // watching them come back at 500/20 looks like DorkOS re-persisting defaults
  // behind somebody's back. It is not a DorkOS write path at all: `conf` compiles
  // Ajv with `useDefaults: true` (`conf@15`, `#setupValidator`), and Ajv MUTATES
  // the object it validates, inserting the `default` of every absent property.
  // `Conf.set` then reads the store through that validating getter, sets one key,
  // and assigns the whole thing back — so a write of ANY leaf persists the fill
  // for every other one.
  //
  // The fill is load-bearing rather than incidental, which is the part a reader
  // has to know before touching it: `z.toJSONSchema(UserConfigSchema)` marks every
  // defaulted leaf `required`, and the fill is what satisfies that. The last test
  // is the proof — turning `useDefaults` off does not stop the materialising, it
  // condemns a config file that is missing one leaf and replaces it with defaults.
  //
  // So absence is not a state this design maintains, and making it one means
  // moving default-filling out of Ajv and into a DorkOS read boundary. That is a
  // decision about the config substrate, not a fix, and these tests describe what
  // is true today so that changing it has to be deliberate.
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A materialised config file with two `rooms` leaves deleted by hand — what the
   * 2026-08-15 rooms self-test left behind.
   */
  function seedWithoutCollectLeaves(): { dir: string; configPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-effective-config-'));
    dirs.push(dir);
    const configPath = path.join(dir, 'config.json');
    new ConfigManager(dir);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      rooms: Record<string, unknown>;
    };
    delete stored.rooms.collectDebounceMs;
    delete stored.rooms.collectMaxEntries;
    fs.writeFileSync(configPath, JSON.stringify(stored, undefined, '\t'));
    return { dir, configPath };
  }

  function roomsOnDisk(configPath: string): Record<string, unknown> {
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      rooms: Record<string, unknown>;
    };
    return stored.rooms;
  }

  it('leaves a deleted leaf deleted across a boot', () => {
    // Opening the store is NOT what put them back. `#runMigrations` merges only
    // the TOP-LEVEL `defaults`, and `rooms` is already there, so its
    // `assert.deepEqual` matches and the `_write` beneath it is skipped. No
    // migration runs at this version either, so nothing rewrites the file.
    const { dir, configPath } = seedWithoutCollectLeaves();
    new ConfigManager(dir);
    expect(roomsOnDisk(configPath)).not.toHaveProperty('collectDebounceMs');
    expect(roomsOnDisk(configPath)).not.toHaveProperty('collectMaxEntries');
  });

  it('still reads the deleted leaves back at their defaults', () => {
    const { dir } = seedWithoutCollectLeaves();
    const rooms = new ConfigManager(dir).get('rooms');
    expect(rooms.collectDebounceMs).toBe(500);
    expect(rooms.collectMaxEntries).toBe(20);
  });

  it('puts them back on disk when an unrelated leaf is written', () => {
    const { dir, configPath } = seedWithoutCollectLeaves();
    const manager = new ConfigManager(dir);

    manager.setDot('ui.theme', 'light');

    expect(roomsOnDisk(configPath).collectDebounceMs).toBe(500);
    expect(roomsOnDisk(configPath).collectMaxEntries).toBe(20);
  });

  it('does the same through PATCH /api/config', () => {
    const { dir, configPath } = seedWithoutCollectLeaves();
    initConfigManager(dir);

    const result = applyConfigPatch({ ui: { theme: 'light' } });

    expect(result.ok).toBe(true);
    expect(roomsOnDisk(configPath).collectDebounceMs).toBe(500);
    expect(roomsOnDisk(configPath).collectMaxEntries).toBe(20);
  });

  it('cannot simply stop filling — the generated schema requires every leaf', () => {
    // The one-line "fix" (`ajvOptions: { useDefaults: false }`), against the same
    // file the tests above use. It does not leave the leaves absent; it makes the
    // file fail validation, which `classifyConfigLoadFailure` reads as corruption
    // — backup, delete, start again from defaults. Measured, not reasoned.
    //
    // Structurally analogous to the production construction rather than a copy of
    // it: the shipped schema and cast, but no `migrations`/`projectVersion`, so
    // `#initializeStore` takes its non-migration branch and the throw comes from
    // the store getter rather than from the `_validate` that follows the
    // migration chain. Same validator, same verdict, one call site over.
    const { dir } = seedWithoutCollectLeaves();
    expect(
      () =>
        new Conf({
          configName: 'config',
          cwd: dir,
          // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
          schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
          ajvOptions: { useDefaults: false },
          defaults: USER_CONFIG_DEFAULTS,
          clearInvalidConfig: false,
        })
    ).toThrow(/Config schema violation.*required property 'collectDebounceMs'/);
  });
});

describe('the 0.67.0 bodies (spec full-power-defaults)', () => {
  describe('seedFullPowerDecision', () => {
    it('reserves both halves of the answer, unanswered', () => {
      const store = createMockStore({ ui: { theme: 'system' } });

      seedFullPowerDecision(store);

      expect(store.data.ui).toEqual({
        theme: 'system',
        fullPowerDecidedAt: null,
        fullPowerChoice: null,
      });
    });

    it('never overwrites an answer somebody already gave', () => {
      const store = createMockStore({
        ui: { fullPowerDecidedAt: '2026-08-22T09:00:00.000Z', fullPowerChoice: 'full' },
      });

      seedFullPowerDecision(store);
      seedFullPowerDecision(store);

      expect(store.data.ui).toEqual({
        fullPowerDecidedAt: '2026-08-22T09:00:00.000Z',
        fullPowerChoice: 'full',
      });
    });

    it('does nothing at all when there is no ui block to seed into', () => {
      const store = createMockStore({});

      seedFullPowerDecision(store);

      expect(store.data.ui).toBeUndefined();
    });

    it('touches no consent-gated value (invariant A1)', () => {
      const store = createMockStore({
        ui: { autonomyAcknowledgedAt: null },
        runtimes: { defaultTrustStop: null },
        approvals: { standingGrants: false },
      });

      seedFullPowerDecision(store);

      expect((store.data.ui as Record<string, unknown>).autonomyAcknowledgedAt).toBeNull();
      expect(store.data.runtimes).toEqual({ defaultTrustStop: null });
      expect(store.data.approvals).toEqual({ standingGrants: false });
    });
  });

  describe('raiseSchedulerConcurrencyFloor', () => {
    it('moves exactly the shipped value, and nothing else in the section', () => {
      const store = createMockStore({
        scheduler: { enabled: true, maxConcurrentRuns: 1, timezone: null, retentionCount: 100 },
      });

      raiseSchedulerConcurrencyFloor(store);

      expect(store.data.scheduler).toEqual({
        enabled: true,
        maxConcurrentRuns: 4,
        timezone: null,
        retentionCount: 100,
      });
    });

    it('leaves any other number alone, including one set after the bump', () => {
      const store = createMockStore({ scheduler: { maxConcurrentRuns: 7 } });

      raiseSchedulerConcurrencyFloor(store);
      // Idempotent: the second call sees 4, not 1, so it does nothing either.
      raiseSchedulerConcurrencyFloor(store);

      expect(store.data.scheduler).toEqual({ maxConcurrentRuns: 7 });
    });

    it('is a no-op with no scheduler section', () => {
      const store = createMockStore({});

      raiseSchedulerConcurrencyFloor(store);

      expect(store.data.scheduler).toBeUndefined();
    });
  });

  describe('warmClaudeCodeSessionsByDefault', () => {
    it('turns on exactly the value the 0.59.0 backfill wrote', () => {
      const store = createMockStore({
        runtimes: {
          default: 'claude-code',
          claudeCode: { accounts: [], persistentSession: false },
          codex: { enabled: true },
        },
      });

      warmClaudeCodeSessionsByDefault(store);

      expect(store.data.runtimes).toEqual({
        default: 'claude-code',
        claudeCode: { accounts: [], persistentSession: true },
        // Untouched: the setting is claude-code's, and no other section has one.
        codex: { enabled: true },
      });
    });

    it('is idempotent, so an off chosen afterwards is permanent', () => {
      const store = createMockStore({
        runtimes: { claudeCode: { persistentSession: false } },
      });

      warmClaudeCodeSessionsByDefault(store);
      (
        store.data.runtimes as Record<string, Record<string, unknown>>
      ).claudeCode.persistentSession = false;
      warmClaudeCodeSessionsByDefault(store);
      warmClaudeCodeSessionsByDefault(store);

      // Two more runs after a deliberate off would flip it back only if the body
      // read a version rather than the value. It reads the value.
      expect(store.data.runtimes).toEqual({ claudeCode: { persistentSession: true } });
    });

    it('is a no-op with no runtimes or no claudeCode block', () => {
      const empty = createMockStore({});
      warmClaudeCodeSessionsByDefault(empty);
      expect(empty.data.runtimes).toBeUndefined();

      const noSection = createMockStore({ runtimes: { default: 'codex' } });
      warmClaudeCodeSessionsByDefault(noSection);
      expect(noSection.data.runtimes).toEqual({ default: 'codex' });
    });
  });

  it('composes all three under the 0.67.0 key, and writes nothing consent-gated', () => {
    const store = createMockStore({
      ui: { theme: 'system', autonomyAcknowledgedAt: null },
      scheduler: { maxConcurrentRuns: 1 },
      runtimes: { defaultTrustStop: null, claudeCode: { persistentSession: false } },
      approvals: { standingGrants: false },
      mesh: { scanRoots: [] },
    });

    CONFIG_MIGRATIONS['0.67.0'](store);

    expect(store.data.ui).toEqual({
      theme: 'system',
      autonomyAcknowledgedAt: null,
      fullPowerDecidedAt: null,
      fullPowerChoice: null,
    });
    expect(store.data.scheduler).toEqual({ maxConcurrentRuns: 4 });
    expect(store.data.runtimes).toEqual({
      defaultTrustStop: null,
      claudeCode: { persistentSession: true },
    });
    expect(store.data.approvals).toEqual({ standingGrants: false });
    expect(store.data.mesh).toEqual({ scanRoots: [] });
  });
});
