import { describe, it, expect, afterEach } from 'vitest';
import Conf, { type Schema } from 'conf';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  initConfigManager,
  backfillAutonomyAcknowledgement,
  backfillConnectorsDefaults,
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  backfillApprovalsDefaults,
  applyTier1OptInDefaults,
  backfillRuntimeExecutionDefaults,
  backfillDefaultTrustStops,
  backfillClaudeCodePersistentSession,
} from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMockStore } from './config-manager.fixtures.js';

// A frozen merged body (0.66.0-era). The leaf it seeds is retired by the
// 0.102.0 key (`config-autonomy-ack-retired-migration.test.ts`); these pin the
// body itself, which may never change.
describe('backfillAutonomyAcknowledgement migration (spec trust-dial, decision 5)', () => {
  it('fresh install: the retired leaf is not declared any more (DOR-2739)', () => {
    expect(USER_CONFIG_DEFAULTS.ui).not.toHaveProperty('autonomyAcknowledgedAt');
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
    const store = createMockStore({ ui: { theme: 'system' } });
    backfillAutonomyAcknowledgement(store);
    expect((store.data.ui as Record<string, unknown>).autonomyAcknowledgedAt).toBeNull();
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

describe('approvals section — the shipped 0.57.0 seed, frozen history (DOR-501)', () => {
  // Standing permissions are retired (spec `agent-permissions` phase 2), and
  // `'0.83.0'` deletes the section. The shipped `'0.57.0'` body still seeds it
  // for an install upgrading from before it, and a shipped body may not change,
  // so its behaviour stays pinned here.
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
    // The schema no longer declares `approvals`, so conf's pre-migration defaults
    // merge no longer writes it: the `'0.57.0'` body is now the only writer, and
    // `projectVersion` stops before `'0.83.0'` deletes it again.
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
