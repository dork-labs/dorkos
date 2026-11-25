import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { ConfigManager, initConfigManager } from '../../config-manager.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { wasBackedUp } from './config-manager.fixtures.js';

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

  // A whole new TOP-LEVEL section has no CONFIG_MIGRATIONS entry at all: conf
  // merges `defaults` under the stored file and writes the result before any
  // migration key runs. Pinned against the real store, so the "no migration
  // needed" decision breaks loudly if conf ever stops doing it. On-disk is the
  // claim that matters: the desktop app reads `network` straight off disk.
  it.each([
    // Spec `keep-awake`.
    ['keepAwake', '0.97.0', { whileAgentsWork: true, wakeForScheduledTasks: false }],
    // DOR-3361.
    ['network', '0.125.0', { extraCaCertsPath: null }],
  ] as const)(
    'lands %s on disk for a config stamped %s, written before it existed, with no migration',
    (section, stamped, expected) => {
      fs.mkdirSync(testDir, { recursive: true });
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          version: 1,
          ui: { theme: 'dark' },
          __internal__: { migrations: { version: stamped } },
        })
      );

      const configManager = initConfigManager(testDir);

      const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown> & {
        ui?: { theme?: string };
      };
      expect(onDisk[section]).toEqual(expected);
      expect(onDisk.ui?.theme).toBe('dark');
      expect(configManager.get(section)).toEqual(USER_CONFIG_DEFAULTS[section]);
    }
  );

  it('lands remoteAccess on disk, on, for a config written before it existed, with no migration', () => {
    // DOR-3650: a whole new TOP-LEVEL section like `keepAwake` above, so conf
    // writes it before any key runs. On, so an upgrade closes no door.
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        server: { port: 4242, cwd: null, boundary: null, open: true, lanAccess: true },
        __internal__: { migrations: { version: '0.135.0' } },
      })
    );

    const configManager = initConfigManager(testDir);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      remoteAccess?: unknown;
      server?: { lanAccess?: boolean };
    };
    expect(onDisk.remoteAccess).toEqual({ enabled: true });
    expect(onDisk.server?.lanAccess).toBe(true);
    expect(configManager.get('remoteAccess')).toEqual(USER_CONFIG_DEFAULTS.remoteAccess);
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

  it('sets top-level config section', () => {
    const configManager = initConfigManager(testDir);
    configManager.set('server', { ...configManager.get('server'), port: 5000, cwd: '/test' });

    expect(configManager.get('server').port).toBe(5000);
    expect(configManager.get('server').cwd).toBe('/test');
  });

  it('sets nested value via dot-path', () => {
    const configManager = initConfigManager(testDir);
    configManager.setDot('server.port', 5000);

    expect(configManager.getDot('server.port')).toBe(5000);
  });

  it.each(['tunnel.authtoken', 'cloud.instanceToken'])(
    'warns when setting the sensitive key %s',
    (key) => {
      const configManager = initConfigManager(testDir);
      const result = configManager.setDot(key, 'secret-value');

      expect(result.warning).toBeDefined();
      expect(result.warning).toContain('sensitive data');
    }
  );

  it('does not warn for non-sensitive keys', () => {
    const configManager = initConfigManager(testDir);
    const result = configManager.setDot('server.port', 5000);

    expect(result.warning).toBeUndefined();
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
