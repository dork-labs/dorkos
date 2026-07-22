import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import { z } from 'zod';
import * as semver from 'semver';
import { UserConfigSchema, USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  initConfigManager,
  backfillExtensionsDisabled,
  backfillHarnessDefaults,
  backfillSidebarDefaults,
  backfillShapesDefaults,
  backfillSidebarSettingsDefaults,
  backfillSmartGroupKindDefaults,
  CONFIG_MIGRATIONS,
  backfillRuntimesDefaults,
  backfillAuthDefaults,
  backfillCloudDefaults,
  backfillWorkbenchDefaults,
  backfillWorkbenchTerminalGraceTtl,
  backfillWorkbenchAutoOpenDiff,
  dropTunnelPasscodeAndSessionSecret,
  backfillProvidersDefaults,
  generalizeTelemetryConsent,
  backfillTelemetryLastPromptedVersion,
  applyTier1OptOutDefaults,
  backfillTelemetryUsageChannel,
  backfillTelemetryLinkAnalyticsToAccount,
  backfillTelemetryAiMetadataChannel,
  scrubRetiredOnboardingSteps,
} from '../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

/**
 * Expected `runtimes` section defaults (spec: additional-agent-runtimes +
 * effortless-runtime-switching T1 credential fields).
 */
const RUNTIMES_DEFAULTS = {
  default: 'claude-code',
  opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
  codex: { enabled: true, binaryPath: null, credentialRef: null },
};

/** Minimal stand-in for the `conf` store used by migration bodies. */
function createMockStore(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial };
  return {
    data,
    get: (key: string) => data[key],
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
    const backupPath = configPath + '.bak';

    expect(fs.existsSync(backupPath)).toBe(true);
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
    expect(configManager.get('extensions')).toEqual({ enabled: [], disabled: [] });
  });

  it('exposes harness.autoSync default (true) on a fresh config', () => {
    const configManager = initConfigManager(testDir);
    expect(configManager.get('harness')).toEqual({ autoSync: true });
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

describe('CONFIG_MIGRATIONS key invariant (DOR-339 regression guard)', () => {
  // Bit once before (0.47.0 -> 0.48.0, see config-manager.ts around the
  // '0.48.0' entry) and again on this very branch (a '0.54.0' key drafted as
  // "the next unreleased version" went stale the moment v0.54.0 was actually
  // tagged while this branch was still open). conf only runs a key in
  // `(storedVersion, projectVersion]`, so a key equal to (or behind) an
  // already-tagged release is silently excluded for every upgrading user —
  // no error, no warning, the backfill just never runs.
  //
  // A local checkout's root package.json is NOT a reliable "already
  // released?" signal by itself — a feature branch can sit open past a real
  // release without ever touching its own stale copy of that file (that's
  // exactly how the 0.54.0 bug slipped through: this branch's package.json
  // still read 0.53.0 after v0.54.0 shipped on main). Git tags are shared
  // across every worktree of this checkout regardless of which commit a
  // branch is sitting on, so they're the ground truth this test checks
  // against; it degrades to a package.json-only check if tags are
  // unavailable (e.g. a shallow CI checkout with no tag history) rather than
  // failing the whole suite over an environment limitation.
  it('the newest migration key is strictly newer than every released version', () => {
    const rootPkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../package.json'
    );
    const rootVersion = (JSON.parse(fs.readFileSync(rootPkgPath, 'utf-8')) as { version: string })
      .version;

    // The most-recently-authored migration is the LAST object key, not the
    // semver-maximum one: the '1.0.0' bootstrap entry (the schema-version-1
    // seed, predating this file's app-version-keyed migrations) is
    // semver-greater than every real 0.x.x release key despite being first
    // in the file. `CONFIG_MIGRATIONS`'s own top-of-file contract is
    // append-only ("never edit a shipped migration body... append a new
    // entry instead"), so the newest entry is always the last one inserted —
    // object key order is insertion order for non-array-index string keys.
    const keys = Object.keys(CONFIG_MIGRATIONS);
    expect(keys.length).toBeGreaterThan(0);
    const newest = keys[keys.length - 1]!;

    let latestReleased = rootVersion;
    try {
      const tags = execSync('git tag -l "v*"', { encoding: 'utf-8', cwd: process.cwd() })
        .split('\n')
        .map((t) => t.trim().replace(/^v/, ''))
        .filter((t) => semver.valid(t));
      if (tags.length > 0) {
        latestReleased = tags.reduce((a, b) => (semver.gt(a, b) ? a : b));
      }
    } catch {
      // No git available (e.g. a tarball checkout) — fall back to package.json.
    }

    expect(
      semver.gt(newest, latestReleased),
      `newest migration key "${newest}" must be > the latest released version "${latestReleased}" ` +
        `(a key <= an already-released version is excluded by conf's (storedVersion, ` +
        `projectVersion] window and silently never runs for upgrading users)`
    ).toBe(true);
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

    const jsonSchema = z.toJSONSchema(UserConfigSchema, { target: 'jsonSchema2019-09' }) as {
      properties?: Record<string, unknown>;
    };
    const store = new Conf({
      configName: 'config',
      cwd: dir,
      // Structurally compatible at runtime; mirrors the cast in config-manager.ts.
      schema: (jsonSchema.properties ?? {}) as unknown as Schema<Record<string, unknown>>,
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
