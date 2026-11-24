import { describe, it, expect } from 'vitest';
import Conf, { type Schema } from 'conf';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  defaultRemoteAccessSettings,
} from '@dorkos/shared/config-schema';
import {
  CONF_JSON_SCHEMA,
  CONFIG_MIGRATIONS,
  seedFullPowerDecision,
  raiseSchedulerConcurrencyFloor,
  warmClaudeCodeSessionsByDefault,
  seedDoeDefaultModel,
  seedCloudCreditsChoices,
  seedCodexTransport,
  seedCloudRemoteAccess,
} from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createMockStore } from './config-manager.fixtures.js';

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
