import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Conf, { type Schema } from 'conf';
import * as semver from 'semver';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  readClaudeAccountSettings,
  defaultRemoteAccessSettings,
} from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  initConfigManager,
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  seedWorkingHoursDefaults,
  seedDoeDefaultModel,
  seedUiPanelTabs,
  seedFirstRunOnboardingLeaves,
  seedCloudCreditsChoices,
  seedCodexTransport,
  raiseEngagedWindowDefaults,
  seedCloudRemoteAccess,
  seedSpacesOfficial,
} from '../config-manager.js';
import { applyConfigPatch } from '../operator/config-patch.js';
import { checkMigrationSafety, extractMigrationBodies } from './migration-safety.js';
import { checkAppendOnly, migrationClosure } from './migration-append-only.js';
import {
  declarationPool,
  extractTopLevelDeclarations,
  reachedDeclarations,
} from './migration-closure.js';
import type { ClosureSources } from './migration-closure.js';
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
  doe: { enabled: true, inference: null, defaultModel: null, defaultTrustStop: null },
  environment: { inherit: { claudeCode: [], codex: [], opencode: [], doe: [] } },
  default: 'claude-code',
  // Trusted by default (ADR 261006-225605): the global stop ships at Full
  // autonomy, and each runtime's own stop ships `null` so it follows it.
  defaultTrustStop: 'autonomy',
  maxAgentChats: 8,
  claudeCode: {
    defaultAccount: null,
    accounts: [],
    defaultAccountColor: null,
    defaultAccountOnlyProjects: null,
    projectAccounts: {},
    dismissedFolders: [],
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
    // On: a chat's agent stays running between messages. Graduated out of
    // Experiments and flipped by the schema default (spec
    // `full-power-defaults`, D1). The earlier OFF seed is retired.
    persistentSession: true,
    maxWarmProcesses: null,
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
    transport: 'auto',
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
  /** Every key a body wrote, so "it made no write at all" is assertable. */
  const writes: string[] = [];
  return {
    data,
    writes,
    get: (key: string) => data[key],
    has: (key: string) => data[key] !== undefined,
    set: (key: string, value: unknown) => {
      writes.push(key);
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

  it('lands keepAwake on disk for a config written before it existed, with no migration', () => {
    // Spec `keep-awake`: a whole new TOP-LEVEL section, so there is no
    // CONFIG_MIGRATIONS entry at all — conf merges `defaults` under the stored
    // file and writes the result before any migration key runs. This pins that
    // measured behaviour against the real store, so the "no migration needed"
    // decision breaks loudly if conf ever stops doing it. Both defaults are the
    // ones the schema declares twice (field and section literal).
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.97.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      keepAwake?: unknown;
      ui?: { theme?: string };
    };
    expect(onDisk.keepAwake).toEqual({ whileAgentsWork: true, wakeForScheduledTasks: false });
    expect(onDisk.ui?.theme).toBe('dark');
    expect(configManager.get('keepAwake')).toEqual(USER_CONFIG_DEFAULTS.keepAwake);
  });

  it('lands activity.retentionDays on disk for a config written before it existed, with no migration', () => {
    // Spec `audit-trail` §3.5: a whole new TOP-LEVEL section, like `keepAwake`
    // above, so there is no CONFIG_MIGRATIONS entry — conf writes the default
    // section before any key runs. Pinned so that decision breaks loudly if
    // conf ever stops doing it.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.98.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      activity?: unknown;
    };
    expect(onDisk.activity).toEqual({ retentionDays: 365 });
    expect(configManager.get('activity').retentionDays).toBe(365);
  });

  it('lands heartbeats.enabled on disk for a config written before it existed, with no migration', () => {
    // Spec `heartbeats` §3.6: a whole new TOP-LEVEL section, like `keepAwake`,
    // so there is no CONFIG_MIGRATIONS entry — conf writes the default section
    // before any key runs. Pinned so that decision breaks loudly if conf ever
    // stops doing it.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.105.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { heartbeats?: unknown };
    expect(onDisk.heartbeats).toEqual({
      enabled: true,
      triageOnCredits: null,
      idleAlertRoomId: null,
    });
    expect(configManager.get('heartbeats').enabled).toBe(true);
  });

  it('lands network.extraCaCertsPath on disk for a config written before it existed, with no migration', () => {
    // DOR-3361: a whole new TOP-LEVEL section, like `keepAwake`, so there is
    // no CONFIG_MIGRATIONS entry — conf writes the default section before any
    // key runs. Pinned so that decision breaks loudly if conf ever stops doing
    // it. The desktop app reads this leaf straight off disk, so on-disk is the
    // claim that matters.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        ui: { theme: 'dark' },
        __internal__: { migrations: { version: '0.125.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { network?: unknown };
    expect(onDisk.network).toEqual({ extraCaCertsPath: null });
    expect(configManager.get('network').extraCaCertsPath).toBeNull();
  });

  it('reads a stored heartbeats section without triageOnCredits as not chosen', () => {
    // Spec `heartbeats` §6.3: the leaf has no migration because its absence
    // already says "nobody answered the offer". Pinned so a later default that
    // is not `null` breaks here instead of spending credits nobody chose.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        heartbeats: { enabled: true },
        __internal__: { migrations: { version: '0.105.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    expect(configManager.get('heartbeats').triageOnCredits ?? null).toBeNull();
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
      approvedSources: {},
      approvedPermissions: {},
      dismissedApprovals: {},
      trustedSources: [],
    });
  });

  it('exposes harness defaults (auto-sync on, no hooks allowed) on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('harness')).toEqual({
      autoSync: true,
      // DorkOS moves nothing on its own until somebody turns this on, and even
      // then only inside the folders it owns (DOR-1853).
      autoAdopt: false,
      approvedHooks: [],
      refusedHooks: [],
      // Each agent's own folder settings, pinned on first use (DOR-3068).
      approvedFolderConfig: [],
      approvedFolderConfigParts: {},
      refusedFolderConfig: [],
      folderConfigPinned: false,
      // Repo and worktree settings outside an agent home (DOR-3298).
      approvedRepoConfig: [],
      refusedRepoConfig: [],
      repoBaselines: {},
      repoBaselinesPinned: false,
      // Nothing installed for all your projects is shared into a home directory
      // until somebody says which agent tools may see it, and `askedAt: null`
      // says the question has never been put (DOR-1924).
      global: { harnesses: [], askedAt: null },
    });
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
      previousLinkProof: null,
      credits: { defaults: {}, offer: 'none', agents: [], linkedTo: null },
      remote: {
        mode: 'off',
        enrolmentId: null,
        consentVersion: null,
        instanceId: null,
        credentialRef: null,
        credentialId: null,
        fingerprint: null,
        hosts: [],
        edgeProofRef: null,
        edgeProofHeader: null,
      },
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
      displayNameSource: null,
      rolePromptDismissedAt: null,
      identityPromptDismissedAt: null,
      timezone: null,
      workingHours: null,
      away: null,
    });
    // Existing user data survives the upgrade untouched.
    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it('a config with explicit profile values keeps them across a reload', () => {
    const explicit = {
      roles: ['hiring', 'business-ops'],
      tools: ['Gmail', 'Greenhouse'],
      displayName: 'Dorian',
      // A name this install DOES know the provenance of: DorkBot proposed it and
      // nobody has saved one since (DOR-1022). Carried through a reload like
      // every other leaf, because a hint that survived only until the next boot
      // would be worse than none.
      displayNameSource: { kind: 'agent', agentName: 'DorkBot' },
      rolePromptDismissedAt: '2026-07-29T00:00:00.000Z',
      identityPromptDismissedAt: '2026-09-25T00:00:00.000Z',
      timezone: 'Europe/Berlin',
      workingHours: { days: [1, 2, 3, 4], start: '08:30', end: '16:00' },
      away: { until: '2026-10-20T00:00:00.000Z', note: 'On holiday' },
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

describe('seedWorkingHoursDefaults migration (DOR-2788)', () => {
  it('reserves the three hours leaves on a `profile` block that predates them', () => {
    // conf's pre-migration merge is shallow, so a stored `profile` never gains a
    // member on its own. Drop the body and these read `undefined`.
    const store = createMockStore({ profile: { roles: ['Engineer'], displayName: 'Dorian' } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toEqual({
      roles: ['Engineer'],
      displayName: 'Dorian',
      timezone: null,
      workingHours: null,
      away: null,
    });
  });

  it('keeps a leaf a person already set and fills only the missing ones', () => {
    const store = createMockStore({ profile: { timezone: 'Europe/Berlin' } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toEqual({
      timezone: 'Europe/Berlin',
      workingHours: null,
      away: null,
    });
  });

  it('leaves a profile that already has all three alone (idempotent, by identity)', () => {
    const profile = { timezone: null, workingHours: null, away: null };
    const store = createMockStore({ profile });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toBe(profile);
  });

  it('does nothing when there is no `profile` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedWorkingHoursDefaults(store);
    expect(store.data.profile).toBeUndefined();
  });

  it('a real pre-0.105.0 config file gains the leaves on disk (full conf path)', () => {
    // Read from the FILE: Ajv's `useDefaults` answers `null` from a discarded
    // copy, so a `getDot` assertion would pass with the body deleted (DOR-1496).
    const dir = path.join(os.tmpdir(), 'test-dork-working-hours-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          profile: {
            roles: ['Engineer'],
            tools: [],
            displayName: 'Dorian',
            displayNameSource: null,
            rolePromptDismissedAt: null,
            identityPromptDismissedAt: '2026-09-01T00:00:00.000Z',
          },
          __internal__: { migrations: { version: '0.103.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.105.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        profile: Record<string, unknown>;
      };
      expect(onDisk.profile).toHaveProperty('timezone', null);
      expect(onDisk.profile).toHaveProperty('workingHours', null);
      expect(onDisk.profile).toHaveProperty('away', null);
      // Everything the person had set is untouched.
      expect(onDisk.profile.displayName).toBe('Dorian');
      expect(onDisk.profile.identityPromptDismissedAt).toBe('2026-09-01T00:00:00.000Z');
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seedFirstRunOnboardingLeaves migration (DOR-2783)', () => {
  it('reserves the three first-run leaves on an `onboarding` block that predates them', () => {
    // conf's pre-migration merge is shallow, so a stored `onboarding` never gains
    // a member on its own. Drop the body and these read `undefined`.
    const store = createMockStore({
      onboarding: { completedSteps: ['meet-dorkbot'], completedAt: '2026-07-01T00:00:00.000Z' },
    });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toEqual({
      completedSteps: ['meet-dorkbot'],
      completedAt: '2026-07-01T00:00:00.000Z',
      firstRunPath: null,
      welcomeEntryId: null,
      priorRuntime: null,
    });
  });

  it('keeps a leaf already set and fills only the missing ones', () => {
    const store = createMockStore({ onboarding: { firstRunPath: 'own' } });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toEqual({
      firstRunPath: 'own',
      welcomeEntryId: null,
      priorRuntime: null,
    });
  });

  it('leaves a block that already has all three alone (idempotent, by identity)', () => {
    const onboarding = { firstRunPath: null, welcomeEntryId: null, priorRuntime: null };
    const store = createMockStore({ onboarding });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toBe(onboarding);
  });

  it('does nothing when there is no `onboarding` block to extend', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedFirstRunOnboardingLeaves(store);
    expect(store.data.onboarding).toBeUndefined();
  });

  it('a real pre-0.108.0 config file gains the leaves on disk (full conf path)', () => {
    // Read from the FILE: Ajv's `useDefaults` answers `null` from a discarded
    // copy, so a `getDot` assertion would pass with the body deleted (DOR-1496).
    const dir = path.join(os.tmpdir(), 'test-dork-first-run-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          onboarding: {
            completedSteps: [],
            skippedSteps: [],
            startedAt: null,
            dismissedAt: null,
            completedAt: '2026-09-01T00:00:00.000Z',
            runtimeDefaultSetAt: '2026-09-01T00:00:00.000Z',
          },
          __internal__: { migrations: { version: '0.107.0' } },
        }),
        'utf-8'
      );

      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.108.0',
        migrations: CONFIG_MIGRATIONS,
      });

      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        onboarding: Record<string, unknown>;
      };
      expect(onDisk.onboarding).toHaveProperty('firstRunPath', null);
      expect(onDisk.onboarding).toHaveProperty('welcomeEntryId', null);
      expect(onDisk.onboarding).toHaveProperty('priorRuntime', null);
      // Everything the install already had is untouched.
      expect(onDisk.onboarding.completedAt).toBe('2026-09-01T00:00:00.000Z');
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

describe('seedDoeDefaultModel migration (DOR-2784)', () => {
  it('reserves the leaf on a `runtimes.doe` block that predates it', () => {
    const store = createMockStore({
      'runtimes.doe': { enabled: true, inference: null, defaultTrustStop: null },
    });
    seedDoeDefaultModel(store);
    expect(store.data['runtimes.doe']).toEqual({
      enabled: true,
      inference: null,
      defaultModel: null,
      defaultTrustStop: null,
    });
  });

  it('keeps a model a person already picked, and writes nothing (idempotent)', () => {
    const store = createMockStore({ 'runtimes.doe': { enabled: true, defaultModel: 'md-a' } });
    seedDoeDefaultModel(store);
    expect(store.writes).toEqual([]);
    expect(store.data['runtimes.doe']).toEqual({ enabled: true, defaultModel: 'md-a' });
  });

  it('a real pre-0.109.0 config file gains the leaf on disk (full conf path)', () => {
    const dir = path.join(os.tmpdir(), 'test-dork-doe-default-model-mig-' + Date.now());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          runtimes: {
            ...USER_CONFIG_DEFAULTS.runtimes,
            doe: { enabled: true, inference: null, defaultTrustStop: 'act' },
          },
          __internal__: { migrations: { version: '0.108.0' } },
        }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.109.0',
        migrations: CONFIG_MIGRATIONS,
      });
      const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: { doe: Record<string, unknown> };
      };
      expect(onDisk.runtimes.doe).toHaveProperty('defaultModel', null);
      expect(onDisk.runtimes.doe.defaultTrustStop).toBe('act');
      expect(() => UserConfigSchema.parse(onDisk)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

/**
 * Join `config-manager.ts` and the files of `config-migrations/` into the one
 * source text the migration guards read.
 *
 * The table and the helpers its keys call live in `config-migrations/`, while
 * the guards parse text. Joining is exact rather than approximate: a pin sorts
 * the declarations it reaches by name, so which file a declaration sits in
 * never enters the hash, and the table slice is read whole wherever it lives.
 *
 * Refuses a name declared in two of the files. The declaration reader keeps the
 * last one it sees, so a duplicate would silently drop the other from every
 * closure that reaches it — a pin with a hole in it.
 *
 * @param files - Each file's path and source text.
 * @returns The files joined in the order given.
 */
function joinMigrationSources(files: { file: string; text: string }[]): string {
  const declaredIn = new Map<string, string>();
  for (const { file, text } of files) {
    for (const name of Object.keys(extractTopLevelDeclarations(text))) {
      const other = declaredIn.get(name);
      if (other !== undefined) {
        throw new Error(
          `${name} is declared in both ${other} and ${file}. The migration guards read these ` +
            'files as one, so one of the two would vanish from every closure. Rename one.'
        );
      }
      declaredIn.set(name, file);
    }
  }
  return files.map(({ text }) => text).join('\n');
}

/**
 * Why a folder inside `config-migrations/` is refused rather than read.
 *
 * The guards read the folder's own files only. A helper in a nested folder would
 * be reached by no closure, so every key calling it would be pinned with a hole
 * where that helper's body should be.
 *
 * @param nested - The nested folder names found.
 */
function nestedMigrationDirsMessage(nested: readonly string[]): string {
  return (
    `config-migrations/ holds a folder (${nested.join(', ')}). The migration guards read ` +
    'only the files directly in it, so a helper in a folder would escape every pin. Keep ' +
    'migration helpers flat in config-migrations/.'
  );
}

/** The working tree's `config-manager.ts` and `config-migrations/*.ts`, joined. */
function readMigrationSource(): string {
  const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(core, 'config-migrations');
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const nested = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  if (nested.length > 0) throw new Error(nestedMigrationDirsMessage(nested));
  const names = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
  return joinMigrationSources([
    {
      file: 'config-manager.ts',
      text: fs.readFileSync(path.join(core, 'config-manager.ts'), 'utf-8'),
    },
    ...names.map((name) => ({
      file: `config-migrations/${name}`,
      text: fs.readFileSync(path.join(dir, name), 'utf-8'),
    })),
  ]);
}

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
  // Three things this guard checks that the first one did not. It compares the
  // CONTENT of every shipped migration against the release, not merely whether
  // the key is present — a body appended to an already-tagged composite key ships
  // dead while the key sits there looking fine, and that is DOR-988. It covers
  // every key, not only the newest. And it follows a shipped key into the code it
  // CALLS (DOR-1135): most of this table is a composite, so comparing the table
  // slice alone froze a helper's name and left its body editable — the tamper
  // that proved it was seeded into `backfillAutonomyAcknowledgement`, which the
  // shipped '0.57.0' key calls, and this test stayed green.
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
  const MIGRATIONS_PATH = 'apps/server/src/services/core/config-migrations';

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
    const source = readMigrationSource();
    expect(Object.keys(extractMigrationBodies(source))).toEqual(Object.keys(CONFIG_MIGRATIONS));
  });

  it('every migration key is unreleased-and-newer, or matches its release in body and in what it calls', () => {
    const source = readMigrationSource();
    const tags = (git('tag -l "v*"') ?? '')
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => semver.valid(t) !== null);

    const result = checkMigrationSafety({
      workingSource: source,
      tags,
      // `refs/tags/` rather than a bare `v<version>`, so a branch that happens to
      // share a release's name cannot shadow the tag and be read as the release.
      //
      // A release cut after the table moved carries it in `config-migrations/`, so
      // that folder is read too wherever the tag has it; an older tag has no such
      // folder and reads exactly as before, `config-manager.ts` alone.
      readAtTag: (version) => {
        const ref = `refs/tags/v${version}`;
        const manager = git(`show ${ref}:${CONFIG_MANAGER_PATH}`);
        if (manager === null) return null;
        const listed = git(`ls-tree --full-tree ${ref} -- ${MIGRATIONS_PATH}/`);
        if (listed === null) return null;
        // `<mode> <type> <object>\t<path>` per line; a `tree` is a folder.
        const rows = listed
          .split('\n')
          .filter((line) => line.includes('\t'))
          .map((line) => {
            const [meta, file] = line.split('\t') as [string, string];
            return { type: meta.split(' ')[1], file };
          });
        const nested = rows.filter((row) => row.type === 'tree').map((row) => row.file);
        if (nested.length > 0) throw new Error(nestedMigrationDirsMessage(nested));
        const files = [{ file: CONFIG_MANAGER_PATH, text: manager }];
        for (const file of rows
          .filter((row) => row.type === 'blob' && row.file.endsWith('.ts'))
          .map((row) => row.file)
          .sort()) {
          const text = git(`show ${ref}:${file}`);
          if (text === null) return null;
          files.push({ file, text });
        }
        return joinMigrationSources(files);
      },
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
  const here = path.dirname(fileURLToPath(import.meta.url));
  const readSources = (): ClosureSources => ({
    configManager: readMigrationSource(),
    configSchema: fs.readFileSync(
      path.resolve(here, '../../../../../../packages/shared/src/config-schema.ts'),
      'utf-8'
    ),
  });

  it('reaches into the helper a bare table entry names, not just its name', () => {
    // Guard the guard, and the thing this rule exists to cover that the tag rule
    // does not: '0.105.0' names seedWorkingHoursDefaults directly,
    // so a pin that hashed the table slice alone would freeze a NAME while the
    // body it points at stayed editable. That is the shape of DOR-1121.
    const closure = migrationClosure('0.105.0', readSources());
    expect(closure).toContain('Object.fromEntries');
    // And it stops at what the key actually reaches: the welcome-back setting
    // is unrelated to this working-hours helper.
    expect(closure).not.toContain('offersEnabled');
  });

  it('reaches across the import boundary into config-schema.ts (DOR-1732)', () => {
    // The shared-defaults import remains pinned after retiring the account-id key.
    const sources = readSources();
    const memory = migrationClosure('0.105.0', sources);
    expect(memory).toContain('USER_CONFIG_DEFAULTS: UserConfig = UserConfigSchema.parse');
    expect(memory).not.toContain('export const UserConfigSchema');
  });

  it('every merged migration still hashes to what it was pinned at', () => {
    const result = checkAppendOnly(readSources(), MERGED_MIGRATION_HASHES);
    expect(result.ok, result.problems.join('\n\n')).toBe(true);
  });

  it('no key reaches the one helper called only from inside interpolations (DOR-1733)', () => {
    // The walk now follows a call written as `` `${describeLoadError(cause)}` ``
    // rather than blanking it away with the rest of the template. That widening
    // moved nothing here, and this is the check that keeps saying so.
    //
    // `describeLoadError` is the shape the fix was for: a top-level declaration
    // in config-manager.ts that NOTHING calls except from inside a template
    // interpolation. It sits in the error path — `adviceFor`,
    // `unreadableMessage`, `loadConfigStore` — which no migration key reaches
    // today. The day one does, its pin moves and this goes red, which is the
    // warning the guard could not give while the mask was blind.
    const sources = readSources();
    const pool = declarationPool(sources);
    expect(Object.keys(pool)).toContain('describeLoadError');

    const bodies = extractMigrationBodies(sources.configManager);
    // The subject is asserted before the verdict is. "No key reaches it" is
    // vacuously true of no keys at all, so an extractor that returned `{}` would
    // pass this having scanned nothing. The count is the knowable bound; the
    // table is append-only, so raising it is the deliberate act of adding a
    // migration, which is exactly when this check should be re-read.
    expect(Object.keys(bodies)).toHaveLength(30);

    const reaching = Object.keys(bodies).filter((key) =>
      reachedDeclarations(bodies[key]!, pool).includes('describeLoadError')
    );
    expect(reaching).toEqual([]);
  });

  it('lists its keys in ascending semver order, after the legacy sentinel', () => {
    // Neither guard sees a REORDER: hashes are per key and the tag comparison is
    // per key too, so swapping two blocks leaves every check green while
    // changing what actually happens — `conf` runs migrations in the table's
    // INSERTION order, not in version order, and several bodies here depend on
    // running after another (the reserved account-id rename after the account
    // registry migration). Ascending order is what makes insertion order and
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

  it('reads an id of the WRONG TYPE instead of condemning the file (DOR-2379)', () => {
    // The registry is shared with flow and hand-editable, and its read rules
    // skip or re-mint a bad row rather than refuse the file (contract
    // `flow-cli-core` §1.1a). A number where a slug belongs is re-minted on
    // read; resetting every setting over one account row is the worse answer.
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
    const manager = new ConfigManager(dir);
    expect(wasBackedUp(dir)).toBe(false);
    expect(
      readClaudeAccountSettings(manager.get('runtimes').claudeCode).accounts.map((a) => a.id)
    ).toEqual(['claude2']);
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
            gettingStarted: { retired: ['suggestion:groups-hint'] },
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

  it('reports the exact path each write stored, beside its section', () => {
    // The settings broadcast tells remembered Community navigation apart from
    // the rest of `ui` by this, so a dot-path write must name its whole path
    // and a whole-section write must name only the section.
    const manager = new ConfigManager(dir);
    const seen: string[][] = [];
    manager.onChange((change) => seen.push([...change.paths]));

    manager.setDot('runtimes.default', 'codex');
    manager.set('ui', { ...manager.get('ui'), theme: 'dark' });

    expect(seen).toEqual([['runtimes.default'], ['ui']]);
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

describe('seedCloudCreditsChoices migration (ADR 261001-000811)', () => {
  /**
   * Run the real upgrade to `'0.96.0'` over a file last written at `from`, and
   * return what is on disk.
   */
  function upgrade(
    cloud: Record<string, unknown>,
    from = '0.95.0'
  ): { cloud: Record<string, unknown> } {
    const dir = path.join(os.tmpdir(), 'test-dork-cloud-credits-' + Date.now() + Math.random());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, cloud, __internal__: { migrations: { version: from } } }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.96.0',
        migrations: CONFIG_MIGRATIONS,
      });
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as { cloud: Record<string, unknown> };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const link = {
    instanceToken: 'ik_live',
    instanceName: 'mac',
    linkedAccountLabel: null,
    previousLinkProof: null,
  };

  it('owes a computer that was already linked one offer, and arms no runtime', () => {
    // READ THE FILE: `cloud` is a section every linked config already has, so
    // this body is the only thing that writes the leaf (see the skill's note).
    // Suppress the body and this goes red.
    const onDisk = upgrade(link);
    // The rest of the block (`agents`, `linkedTo`) is the schema's default on read.
    expect(onDisk.cloud.credits).toEqual({ defaults: {}, offer: 'pending' });
    expect(onDisk.cloud.instanceToken).toBe('ik_live');
  });

  // A computer that skipped 0.95.x (or is on an 0.94.x build) runs every key
  // in between on the way up, and still gets the same single offer.
  it.each(['0.94.0', '0.94.3'])(
    'owes a linked computer upgrading from %s the same one offer',
    (from) => {
      const onDisk = upgrade(link, from);
      expect(onDisk.cloud.credits).toEqual({ defaults: {}, offer: 'pending' });
      expect(onDisk.cloud.instanceToken).toBe('ik_live');
    }
  );

  it('owes an unlinked computer nothing: its next link fills the gaps', () => {
    const onDisk = upgrade({ ...link, instanceToken: null });
    expect(onDisk.cloud.credits).toEqual({ defaults: {}, offer: 'none' });
  });

  it('is idempotent and never overwrites a choice already recorded', () => {
    const credits = {
      defaults: { 'claude-code': { runsOn: 'credits', chosenBy: 'user' } },
      offer: 'dismissed',
    };
    const store = createMockStore({ cloud: { ...link, credits } });
    seedCloudCreditsChoices(store);
    seedCloudCreditsChoices(store);
    expect((store.data.cloud as { credits: unknown }).credits).toEqual(credits);
  });

  it('skips a config with no cloud section', () => {
    const store = createMockStore({ server: { port: 4242 } });
    seedCloudCreditsChoices(store);
    expect(store.data.cloud).toBeUndefined();
  });
});

describe('seedCodexTransport migration (ADR 261005-113107)', () => {
  /**
   * Run the real upgrade to `'0.100.0'` over a file last written at `from`, and
   * return what is on disk.
   */
  function upgrade(
    runtimes: Record<string, unknown>,
    from = '0.99.0'
  ): { runtimes: { codex: Record<string, unknown> } } {
    const dir = path.join(os.tmpdir(), 'test-dork-codex-transport-' + Date.now() + Math.random());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, runtimes, __internal__: { migrations: { version: from } } }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.100.0',
        migrations: CONFIG_MIGRATIONS,
      });
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        runtimes: { codex: Record<string, unknown> };
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const codex = {
    enabled: true,
    binaryPath: '/opt/codex',
    credentialRef: null,
    defaultModel: null,
    defaultEffort: null,
    defaultTrustStop: null,
  };

  it('writes `auto` into a stored codex block that predates the choice', () => {
    // READ THE FILE: `runtimes.codex` is a section every stored config has, so
    // conf's shallow default merge never adds this leaf. Suppress the body and
    // this goes red.
    const onDisk = upgrade({ default: 'claude-code', codex });
    expect(onDisk.runtimes.codex.transport).toBe('auto');
    expect(onDisk.runtimes.codex.binaryPath).toBe('/opt/codex');
  });

  it('keeps a transport a person already chose', () => {
    const onDisk = upgrade({ default: 'claude-code', codex: { ...codex, transport: 'exec' } });
    expect(onDisk.runtimes.codex.transport).toBe('exec');
  });

  it('is idempotent and replaces only an unknown value', () => {
    const store = createMockStore({ runtimes: { codex: { ...codex, transport: 'app-server' } } });
    seedCodexTransport(store);
    seedCodexTransport(store);
    expect((store.data.runtimes as { codex: { transport: unknown } }).codex.transport).toBe(
      'app-server'
    );
    const stale = createMockStore({ runtimes: { codex: { ...codex, transport: 'sdk' } } });
    seedCodexTransport(stale);
    expect((stale.data.runtimes as { codex: { transport: unknown } }).codex.transport).toBe('auto');
  });

  it('skips a config with no codex block', () => {
    const store = createMockStore({ runtimes: { default: 'claude-code' } });
    seedCodexTransport(store);
    expect((store.data.runtimes as { codex?: unknown }).codex).toBeUndefined();
  });
});

describe('raiseEngagedWindowDefaults migration (DOR-2823)', () => {
  /** Run the real upgrade to `'0.103.0'` over a stored `rooms` block. */
  function upgrade(rooms: Record<string, unknown>): { rooms: Record<string, unknown> } {
    const dir = path.join(os.tmpdir(), 'test-dork-engaged-window-' + Date.now() + Math.random());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, rooms, __internal__: { migrations: { version: '0.102.0' } } }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.103.0',
        migrations: CONFIG_MIGRATIONS,
      });
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as { rooms: Record<string, unknown> };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('raises a window still at the old shipped defaults', () => {
    // READ THE FILE: `rooms` is a section a stored config already has, so the
    // shallow default merge never reaches these leaves. Suppress the body and
    // this goes red.
    const onDisk = upgrade({ engagedWindowMinutes: 10, engagedWindowPosts: 5 });
    expect(onDisk.rooms.engagedWindowMinutes).toBe(60);
    expect(onDisk.rooms.engagedWindowPosts).toBe(15);
  });

  it('keeps numbers a person chose, including turning the window off', () => {
    expect(upgrade({ engagedWindowMinutes: 60, engagedWindowPosts: 15 }).rooms).toMatchObject({
      engagedWindowMinutes: 60,
      engagedWindowPosts: 15,
    });
    expect(upgrade({ engagedWindowMinutes: 0, engagedWindowPosts: 3 }).rooms).toMatchObject({
      engagedWindowMinutes: 0,
      engagedWindowPosts: 3,
    });
  });

  it('fills a window a stored rooms block never had', () => {
    const onDisk = upgrade({ replyWaitMinutes: 10 });
    expect(onDisk.rooms.engagedWindowMinutes).toBe(60);
    expect(onDisk.rooms.engagedWindowPosts).toBe(15);
    expect(onDisk.rooms.replyWaitMinutes).toBe(10);
  });

  it('is idempotent', () => {
    // The mock store is flat, so the dotted keys the body reads are the keys.
    const store = createMockStore({
      rooms: {},
      'rooms.engagedWindowMinutes': 10,
      'rooms.engagedWindowPosts': 5,
    });
    raiseEngagedWindowDefaults(store);
    raiseEngagedWindowDefaults(store);
    expect(store.data).toMatchObject({
      'rooms.engagedWindowMinutes': 60,
      'rooms.engagedWindowPosts': 15,
    });
    expect(store.writes).toHaveLength(2);
  });
});

describe('seedCloudRemoteAccess migration (DOR-2086)', () => {
  /** A BYO setup a person made by hand, with a token that must stay where it is. */
  const BYO_TOKEN = '2abcBYOtokenNeverCopied_xyz0123456789';
  const tunnel = {
    enabled: true,
    domain: 'mine.ngrok.app',
    authtoken: BYO_TOKEN,
    auth: 'me:secret-password',
  };
  const linkedCloud = {
    instanceToken: 'dk_inst_linked',
    instanceName: 'laptop',
    linkedAccountLabel: null,
    previousLinkProof: null,
    credits: { defaults: {}, offer: 'none', agents: [], linkedTo: null },
  };

  /**
   * Run the real upgrade to `'0.106.0'` over a file last written at `from`, and
   * return the raw file text and its parse.
   */
  function upgrade(
    stored: Record<string, unknown>,
    from = '0.105.0'
  ): { raw: string; onDisk: Record<string, unknown> } {
    const dir = path.join(os.tmpdir(), 'test-dork-cloud-remote-' + Date.now() + Math.random());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ version: 1, ...stored, __internal__: { migrations: { version: from } } }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.106.0',
        migrations: CONFIG_MIGRATIONS,
      });
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      return { raw, onDisk: JSON.parse(raw) as Record<string, unknown> };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('seeds `byo` into a stored cloud block when the own tunnel is on', () => {
    // READ THE FILE: `cloud` is a section every stored config has, so conf's
    // shallow default merge never adds this leaf. Suppress the body and this
    // goes red.
    const { onDisk } = upgrade({ tunnel, cloud: linkedCloud });
    const cloud = onDisk.cloud as Record<string, unknown>;
    expect(cloud.remote).toEqual({
      mode: 'byo',
      enrolmentId: null,
      consentVersion: null,
      instanceId: null,
      credentialRef: null,
      credentialId: null,
      fingerprint: null,
      hosts: [],
      edgeProofRef: null,
      edgeProofHeader: null,
    });
    // The link survives untouched: an upgrade is never an unlink.
    expect(cloud.instanceToken).toBe('dk_inst_linked');
    expect(cloud.credits).toEqual(linkedCloud.credits);
  });

  it('seeds `off` when the tunnel is off or was never set up', () => {
    const off = upgrade({ tunnel: { ...tunnel, enabled: false }, cloud: linkedCloud });
    expect((off.onDisk.cloud as { remote: { mode: string } }).remote.mode).toBe('off');
    const none = upgrade({ cloud: linkedCloud });
    expect((none.onDisk.cloud as { remote: { mode: string } }).remote.mode).toBe('off');
  });

  it('writes the same record the schema defaults to, apart from the seeded mode', () => {
    // The body spells its literal out so it stays frozen; this pins that the
    // two agree today, so a fresh install and an upgraded one cannot differ.
    const store = createMockStore({ cloud: { instanceToken: null } });
    seedCloudRemoteAccess(store);
    expect((store.data.cloud as { remote: unknown }).remote).toEqual(defaultRemoteAccessSettings());
  });

  it('leaves `tunnel` byte-for-byte unchanged and never copies the BYO token', () => {
    const { raw, onDisk } = upgrade({ tunnel, cloud: linkedCloud });
    expect(JSON.stringify(onDisk.tunnel)).toBe(JSON.stringify(tunnel));
    // The token appears exactly once in the whole file: where the person put it.
    expect(raw.split(BYO_TOKEN).length - 1).toBe(1);
    const remote = (onDisk.cloud as { remote: Record<string, unknown> }).remote;
    expect(JSON.stringify(remote)).not.toContain(BYO_TOKEN);
    expect(remote.mode).toBe('byo');
  });

  it('keeps a managed record a newer build already wrote', () => {
    const remote = {
      mode: 'managed',
      enrolmentId: 'enr_1',
      consentVersion: '2026-10',
      instanceId: 'inst_1',
      credentialRef: 'file:remote-tunnel-cred_1',
      credentialId: 'cred_1',
      fingerprint: 'fp',
      hosts: ['a.example.com'],
      edgeProofRef: 'file:remote-edge-cred_1',
      edgeProofHeader: 'x-dorkos-edge',
    };
    const { onDisk } = upgrade({ tunnel, cloud: { ...linkedCloud, remote } });
    expect((onDisk.cloud as { remote: unknown }).remote).toEqual(remote);
  });

  it('is idempotent and skips a config with no cloud block', () => {
    const store = createMockStore({ cloud: { instanceToken: null } });
    seedCloudRemoteAccess(store);
    const first = JSON.stringify(store.data.cloud);
    seedCloudRemoteAccess(store);
    expect(JSON.stringify(store.data.cloud)).toBe(first);

    const empty = createMockStore({ tunnel });
    seedCloudRemoteAccess(empty);
    expect(empty.data.cloud).toBeUndefined();
    expect(empty.data.tunnel).toBe(tunnel);
  });
});

describe('seedSpacesOfficial migration (spec official-community-space D4)', () => {
  /** Run the real upgrade to `'0.107.0'` over a file last written at 0.106.0. */
  function upgrade(spaces: Record<string, unknown>): {
    spaces: { enabled: unknown; official?: { url: unknown } };
  } {
    const dir = path.join(os.tmpdir(), 'test-dork-spaces-official-' + Date.now() + Math.random());
    const cfgPath = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({
          version: 1,
          spaces,
          __internal__: { migrations: { version: '0.106.0' } },
        }),
        'utf-8'
      );
      new Conf({
        configName: 'config',
        cwd: dir,
        schema: CONF_JSON_SCHEMA as unknown as Schema<Record<string, unknown>>,
        defaults: USER_CONFIG_DEFAULTS,
        clearInvalidConfig: false,
        projectVersion: '0.107.0',
        migrations: CONFIG_MIGRATIONS,
      });
      return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        spaces: { enabled: unknown; official?: { url: unknown } };
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('writes an empty link into a stored spaces block that predates it', () => {
    // READ THE FILE: `spaces` is a section a stored config already has, so
    // conf's shallow default merge never adds this leaf. Suppress the body and
    // this goes red.
    const onDisk = upgrade({ enabled: true });
    expect(onDisk.spaces.official).toEqual({ url: '' });
    expect(onDisk.spaces.enabled).toBe(true);
  });

  it('keeps a link a person already set', () => {
    const onDisk = upgrade({ enabled: false, official: { url: 'https://space.example/c/x' } });
    expect(onDisk.spaces.official).toEqual({ url: 'https://space.example/c/x' });
  });

  it('is idempotent and skips a config with no spaces block', () => {
    const store = createMockStore({ spaces: { enabled: false } });
    seedSpacesOfficial(store);
    seedSpacesOfficial(store);
    expect(store.data.spaces).toEqual({ enabled: false, official: { url: '' } });
    const none = createMockStore({ server: { port: 4242 } });
    seedSpacesOfficial(none);
    expect(none.data.spaces).toBeUndefined();
  });
});
