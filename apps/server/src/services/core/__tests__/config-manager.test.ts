import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  initConfigManager,
  backfillExtensionsDisabled,
  backfillHarnessDefaults,
  backfillSidebarDefaults,
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
} from '../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

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
