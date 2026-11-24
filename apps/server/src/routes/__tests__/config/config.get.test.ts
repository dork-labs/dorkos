/**
 * `GET /api/config`: the curated snapshot the app reads its settings from.
 * Each block is a client contract; the cases pin what a screen states out loud.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT,
  ROOM_TURN_LIMIT_DEFAULTS,
} from '@dorkos/shared/config-schema';
import {
  FRESH_GRAPH_TIMEOUT_MS,
  bootConfigApp,
  caller,
  server,
  store,
  useFreshConfigApp,
} from './config.fixtures.js';

/** GET the snapshot and hand back its body. */
async function getConfig() {
  return (await request(server).get('/api/config').expect(200)).body;
}

/** PATCH `body` as the person at the desk, expecting it to land. */
async function patch(body: object): Promise<void> {
  await request(server).patch('/api/config').send(body).expect(200);
}

describe('GET /api/config', () => {
  const tmp = useFreshConfigApp({ withRuntimes: true });

  it.each([
    ['the desk', undefined, false, false],
    ['the own tunnel', 'own-tunnel', true, false],
    ['managed access', 'managed', true, false],
    ['Wi-Fi', 'wifi', true, true],
  ] as const)(
    'describes approval confirmation from %s with server-owned facts',
    async (_name, via, needsStepUp, onWifi) => {
      caller.arrivedVia = via;
      expect((await getConfig()).approvalAnswerContext).toEqual({
        answerNeedsStepUp: needsStepUp,
        onWifi,
      });
    }
  );

  it('shows an unanswered file’s "on" channels as off, and an answered one as stored (DOR-4400)', async () => {
    const configManager = await store();
    configManager.set('telemetry', {
      ...configManager.get('telemetry'),
      install: true,
      heartbeat: true,
      usage: true,
      userHasDecided: false,
    });
    expect((await getConfig()).telemetry).toMatchObject({
      install: false,
      heartbeat: false,
      usage: false,
      userHasDecided: false,
    });

    configManager.set('telemetry', { ...configManager.get('telemetry'), userHasDecided: true });
    expect((await getConfig()).telemetry).toMatchObject({
      install: true,
      heartbeat: true,
      usage: true,
      userHasDecided: true,
    });
  });

  it('a Privacy toggle on an unanswered all-on file switches nothing else on (DOR-4400 M1)', async () => {
    const configManager = await store();
    const { resolveTier1ChannelConsent } = await import('@dorkos/shared/telemetry-consent');
    configManager.set('telemetry', {
      ...configManager.get('telemetry'),
      install: true,
      heartbeat: true,
      usage: true,
      userHasDecided: false,
    });
    // What PrivacyTab sends for one switch: that channel plus `userHasDecided`.
    await patch({ telemetry: { errorReporting: true, userHasDecided: true } });
    const stored = configManager.get('telemetry');
    expect(stored).toMatchObject({
      errorReporting: true,
      install: false,
      heartbeat: false,
      usage: false,
      userHasDecided: true,
    });
    for (const channel of ['install', 'heartbeat', 'usage'] as const) {
      expect(resolveTier1ChannelConsent(stored, channel, {})).toBe(false);
    }
  });

  it('reads company certificates back, with nothing loaded outside the desktop app (DOR-3361)', async () => {
    expect((await getConfig()).network).toEqual({
      extraCaCertsPath: null,
      companyCertificates: null,
    });

    (await store()).setDot('network.extraCaCertsPath', '/Users/someone/company-ca.pem');
    expect((await getConfig()).network).toEqual({
      extraCaCertsPath: '/Users/someone/company-ca.pem',
      companyCertificates: null,
    });
  });

  it('reports the server role, the boundary, its own origins and the resolved working directory', async () => {
    // The packaged Mac app is launched from Finder, where `process.cwd()` is `/`,
    // outside the boundary; `DEFAULT_CWD` is the resolved, clamped default.
    // Which origins count as this server's own is `trusted-origins.test.ts`.
    const { DEFAULT_CWD } = await import('../../../lib/resolve-root.js');
    const body = await getConfig();
    expect(body.serverRole).toBe('computer');
    expect(body.boundary).toBe(tmp.dir);
    expect(body.ownOrigins).toEqual([]);
    expect(body.workingDirectory).toBe(DEFAULT_CWD);
  });

  // The Defaults card reads this and nothing else; it is derived from each
  // registered runtime's own declaration, not a list the server keeps.
  it('reports executionDefaults per declaring runtime, in the shape the Defaults card reads', async () => {
    const { executionDefaults } = await getConfig();

    // Trusted by default (ADR 261006-225605): a fresh install starts at Full autonomy.
    expect(executionDefaults.trustStop).toBe('autonomy');
    expect(typeof executionDefaults.runtime).toBe('string');
    // `test-mode` is registered and declares no config section, so it is absent.
    expect(executionDefaults.perRuntime).toEqual([
      { runtime: 'claude-code', supportsEffort: true, model: null, effort: null, trustStop: null },
      { runtime: 'codex', supportsEffort: true, model: null, effort: null, trustStop: null },
      { runtime: 'opencode', supportsEffort: false, model: null, effort: null, trustStop: null },
    ]);
  });

  // First-run setup asks whether the default runtime was already decided; an
  // absent answer would read as "no" and rewrite a long-settled setting.
  describe('onboarding.runtimeDefaultSetAt, the once-only marker', () => {
    it('reports null on a fresh install, and the stamp once first-run setup decided', async () => {
      expect((await getConfig()).onboarding).toHaveProperty('runtimeDefaultSetAt', null);

      const configManager = await store();
      configManager.set('onboarding', {
        ...configManager.get('onboarding'),
        runtimeDefaultSetAt: '2026-07-31T09:00:00.000Z',
      });
      expect((await getConfig()).onboarding.runtimeDefaultSetAt).toBe('2026-07-31T09:00:00.000Z');
    });

    // Written to disk rather than through `configManager.set`, which would fill
    // the field itself and make the assertion true whatever the loader does.
    it('reports null for an install whose config file predates the field', async () => {
      const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-legacy-'));
      fs.writeFileSync(
        path.join(legacyDir, 'config.json'),
        JSON.stringify({
          version: 1,
          onboarding: {
            completedSteps: ['meet-dorkbot'],
            skippedSteps: [],
            startedAt: '2026-07-01T00:00:00.000Z',
            dismissedAt: null,
            completedAt: '2026-07-01T00:05:00.000Z',
          },
          __internal__: { migrations: { version: '0.55.0' } },
        })
      );
      try {
        vi.resetModules();
        await bootConfigApp(legacyDir);
        const { onboarding } = await getConfig();
        expect(onboarding).toHaveProperty('runtimeDefaultSetAt', null);
        expect(onboarding.completedAt).toBe('2026-07-01T00:05:00.000Z');
        expect(onboarding.completedSteps).toEqual(['meet-dorkbot']);
      } finally {
        fs.rmSync(legacyDir, { recursive: true, force: true });
      }
    });
  });

  // The app prints these numbers inside sentences ("keeps answering for 10
  // more minutes"), which are only true if it reads the values in force.
  describe('rooms, the numbers the app says out loud', () => {
    it('reports the shipped numbers, and only the rooms fields the wire carries', async () => {
      // `toEqual`, so a widened block (reply waits, collect timings) goes red too.
      // The engaged window ships at an hour and 15 messages (DOR-2823).
      expect((await getConfig()).rooms).toEqual({
        engagedWindowMinutes: 60,
        engagedWindowPosts: 15,
        ...ROOM_TURN_LIMIT_DEFAULTS,
        maxConcurrentTurnsPerAgent: MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT,
      });
    });

    it('reports what an operator actually set, not what ships', async () => {
      const configManager = await store();
      configManager.set('rooms', {
        ...configManager.get('rooms')!,
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
        maxAgentDepth: 4,
        turnLimitsEnabled: false,
      });
      expect((await getConfig()).rooms).toMatchObject({
        engagedWindowMinutes: 3,
        engagedWindowPosts: 2,
        maxAgentDepth: 4,
        turnLimitsEnabled: false,
      });
    });
  });

  // The Tools switches are only honest if they tell "what is running" from
  // "what the setting says"; the two part ways once someone flips one.
  describe('tasks/relay, what is running versus what the setting says', () => {
    it('reports each subsystem off until its startup path succeeds', async () => {
      const before = await getConfig();
      for (const block of [before.tasks, before.relay]) {
        expect(block).toMatchObject({ enabled: false, enabledInConfig: true, lockedByEnv: false });
      }

      const [{ setTasksEnabled }, { setRelayEnabled }] = await Promise.all([
        import('../../../services/tasks/task-state.js'),
        import('../../../services/relay/relay-state.js'),
      ]);
      setTasksEnabled(true);
      setRelayEnabled(true);
      try {
        const after = await getConfig();
        expect(after.tasks.enabled).toBe(true);
        expect(after.relay.enabled).toBe(true);
      } finally {
        setTasksEnabled(false);
        setRelayEnabled(false);
      }
    });

    it('round-trips a PATCH, so the switch can persist what it shows', async () => {
      // Seeded off the default, so a patch that replaced the whole block with
      // defaults would go red.
      const configManager = await store();
      configManager.set('scheduler', { ...configManager.get('scheduler')!, maxConcurrentRuns: 5 });

      await patch({ scheduler: { enabled: false }, relay: { enabled: false } });

      const body = await getConfig();
      expect(body.tasks.enabledInConfig).toBe(false);
      expect(body.relay.enabledInConfig).toBe(false);
      expect(body.scheduler.maxConcurrentRuns).toBe(5);
    });
  });

  // The environment beats the setting, so the tab must stop offering the switch.
  // Read at module load, hence the fresh import with the variables set.
  describe('tasks/relay, lockedByEnv', () => {
    afterEach(() => {
      delete process.env.DORKOS_TASKS_ENABLED;
      delete process.env.DORKOS_RELAY_ENABLED;
    });

    it.each([
      // `false` on purpose: presence is the question, because `index.ts` branches on it.
      ['both, whatever the value', 'false', 'true', true, true],
      ['only the one whose variable is set', undefined, 'true', false, true],
    ])(
      'flags %s',
      async (_label, tasksVar, relayVar, tasksLocked, relayLocked) => {
        if (tasksVar !== undefined) process.env.DORKOS_TASKS_ENABLED = tasksVar;
        process.env.DORKOS_RELAY_ENABLED = relayVar;
        vi.resetModules();
        await bootConfigApp(tmp.dir, true);

        const body = await getConfig();
        expect(body.tasks).toMatchObject({
          enabled: false,
          enabledInConfig: true,
          lockedByEnv: tasksLocked,
        });
        expect(body.relay).toMatchObject({
          enabled: false,
          enabledInConfig: true,
          lockedByEnv: relayLocked,
        });
      },
      FRESH_GRAPH_TIMEOUT_MS
    );
  });

  it(
    'reports to-dos on by default, and off when DORKOS_TODOS_ENABLED=false is set at boot (DOR-3088, DOR-5071)',
    async () => {
      expect((await getConfig()).todos).toEqual({ enabled: true });
      process.env.DORKOS_TODOS_ENABLED = 'false';
      try {
        vi.resetModules();
        await bootConfigApp(tmp.dir);
        expect((await getConfig()).todos).toEqual({ enabled: false });
      } finally {
        delete process.env.DORKOS_TODOS_ENABLED;
      }
    },
    FRESH_GRAPH_TIMEOUT_MS
  );

  // Settings states the threshold in force next to the greeting switch
  // (DOR-1046, spec team-room-home D5.2).
  describe('welcomeBack, what agents may say when you come back', () => {
    it('reports the shipped values, and only the four fields', async () => {
      expect((await getConfig()).welcomeBack).toEqual({
        enabled: true,
        absenceThresholdMinutes: 240,
        maxPosts: 3,
        offersEnabled: true,
      });
    });

    it('round-trips each switch through PATCH, leaving the numbers and the other switch alone', async () => {
      const configManager = await store();
      configManager.set('welcomeBack', { ...configManager.get('welcomeBack')!, maxPosts: 1 });

      await patch({ welcomeBack: { enabled: false } });
      expect((await getConfig()).welcomeBack).toMatchObject({ enabled: false, maxPosts: 1 });

      // Offers ship on, so the write worth proving is turning them off (DOR-1121).
      await patch({ welcomeBack: { enabled: true } });
      await patch({ welcomeBack: { offersEnabled: false } });
      expect((await getConfig()).welcomeBack).toMatchObject({
        enabled: true,
        offersEnabled: false,
      });
    });
  });

  // Spec `official-community-space` D4: offered only when a usable link is configured.
  it('carries the official space only when its link is usable', async () => {
    const configManager = await store();
    for (const url of ['', 'http://plain.example']) {
      configManager.set('spaces', { enabled: false, official: { url } });
      expect((await getConfig()).officialSpace).toBeNull();
    }
    const url = 'https://space.example/c/11111111-1111-4111-8111-111111111111';
    configManager.set('spaces', { enabled: false, official: { url } });
    expect((await getConfig()).officialSpace).toEqual({ url });
  });

  // A flag shipped OFF and absent from this DTO is one nobody can reach without
  // hand-editing the config file (DOR-1304).
  describe('experiments', () => {
    afterEach(() => {
      delete process.env.DORKOS_A2A_ENABLED;
    });

    it('lists every registered experiment, resolved, in registry order, off on a fresh install', async () => {
      const { EXPERIMENTS } = await import('../../../services/core/config/experiments-registry.js');
      const { experiments } = await getConfig();

      // Against the registry, not a literal list: the registry shrinks as flags graduate.
      expect(experiments.map((e: { key: string }) => e.key)).toEqual(
        EXPERIMENTS.map((e) => e.path)
      );
      for (const entry of experiments) {
        expect(entry.title).toBeTruthy();
        expect(entry.description).toBeTruthy();
        expect(typeof entry.enabled).toBe('boolean');
      }
      const a2a = experiments.find((e: { key: string }) => e.key === 'a2a.enabled');
      expect(a2a).toMatchObject({ enabled: false, lockedByEnv: false });
    });

    it('reports the setting a person turned on', async () => {
      (await store()).set('a2a', { enabled: true });
      const { experiments } = await getConfig();
      expect(experiments.find((e: { key: string }) => e.key === 'a2a.enabled')).toMatchObject({
        enabled: true,
        lockedByEnv: false,
      });
    });

    it.each([
      // `false` while the setting says on: the switch shows what really happens here.
      ['false', true, false],
      ['true', false, true],
    ])(
      'locks the A2A entry when DORKOS_A2A_ENABLED=%s, and names the variable',
      async (value, setting, enabled) => {
        (await store()).set('a2a', { enabled: setting });
        process.env.DORKOS_A2A_ENABLED = value;

        const { experiments } = await getConfig();
        expect(experiments.find((e: { key: string }) => e.key === 'a2a.enabled')).toMatchObject({
          enabled,
          lockedByEnv: true,
          envOverride: 'DORKOS_A2A_ENABLED',
        });
        // An entry with no variable of its own gets no invented one.
        for (const other of experiments.filter((e: { key: string }) => e.key !== 'a2a.enabled')) {
          expect(other.lockedByEnv).toBe(false);
          expect(other).not.toHaveProperty('envOverride');
        }
      }
    );
  });

  it('carries the ui prefs blocks the sidebar, Shapes and status bar read (DOR-329, DOR-355, DOR-431)', async () => {
    const { ui } = await getConfig();
    expect(ui.sidebar).toMatchObject({ sections: {}, gettingStarted: { retired: [] } });
    expect(Array.isArray(ui.sidebar.pinned)).toBe(true);
    expect(Array.isArray(ui.sidebar.groups)).toBe(true);
    expect(ui.shapes).toMatchObject({ active: null, agentDefaults: {}, autoFollowAgent: false });
    expect(ui.statusBar).toEqual({ pins: [] });
  });

  it('reports the trust notice unseen and a Trusted preset, with no Full-autonomy acknowledgement (DOR-2739)', async () => {
    const body = await getConfig();
    expect(body.ui.trustNoticeSeenAt).toBeNull();
    for (const retired of ['autonomyAcknowledgedAt', 'fullPowerDecidedAt', 'fullPowerChoice']) {
      expect(body.ui).not.toHaveProperty(retired);
    }
    expect(body.permissions).toEqual({ preset: 'trusted', sharedAtUpgrade: [] });

    // The notice writes the stamp, and every later launch reads it back here.
    const seenAt = '2026-10-07T11:15:00.000Z';
    await patch({ ui: { trustNoticeSeenAt: seenAt } });
    expect((await getConfig()).ui.trustNoticeSeenAt).toBe(seenAt);
  });

  it('reports the DM view on and Show sessions off, and reads both back once set (DOR-3074)', async () => {
    const before = await getConfig();
    expect(before.ui).toMatchObject({ showSessions: false, dmView: true });
    expect(before.experiments.map((entry: { key: string }) => entry.key)).not.toContain(
      'ui.dmView'
    );

    await patch({ ui: { showSessions: true, dmView: false } });
    expect((await getConfig()).ui).toMatchObject({ showSessions: true, dmView: false });
  });

  // Full autonomy is a default like any other (ADR 261006-225605, DOR-2739).
  it.each([
    [
      { defaultTrustStop: 'autonomy', codex: { defaultTrustStop: 'autonomy' } },
      'autonomy',
      'codex',
      'autonomy',
    ],
    [
      { defaultTrustStop: 'act', claudeCode: { defaultTrustStop: 'ask' } },
      'act',
      'claude-code',
      'ask',
    ],
  ])(
    'takes a default stop with nothing to acknowledge first (%#)',
    async (runtimes, all, runtime, one) => {
      await patch({ runtimes });
      const { executionDefaults } = await getConfig();
      expect(executionDefaults.trustStop).toBe(all);
      expect(
        executionDefaults.perRuntime.find((e: { runtime: string }) => e.runtime === runtime)
          .trustStop
      ).toBe(one);
    }
  );
});
