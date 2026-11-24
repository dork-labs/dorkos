import { describe, it, expect } from 'vitest';
import { EFFORT_LEVELS } from '../../constants.js';
import { PERMISSION_STOPS } from '../../permission-semantics.js';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  configuredRuntimes,
  SENSITIVE_CONFIG_KEYS,
  OnboardingStepSchema,
} from '../../config-schema.js';
import type {} from '../../config-schema.js';

describe('the relay turn ceiling', () => {
  /**
   * Parse just the relay block, with the two ceiling fields under test.
   *
   * @param relay - The partial relay config to parse.
   */
  function parseRelay(relay: Record<string, unknown>) {
    return UserConfigSchema.safeParse({ version: 1, relay });
  }

  it('refuses a number outside it, so no surface can offer a ceiling the store would take', () => {
    expect(parseRelay({ maxAgentTurnsTotalPerHour: -1 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsTotalPerHour: 100_001 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 100_001 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 1.5 }).success).toBe(false);
  });
});

describe('UserConfigSchema', () => {
  it('rejects invalid port below 1024', () => {
    expect(() => UserConfigSchema.parse({ version: 1, server: { port: 80 } })).toThrow();
  });

  it('fills ui.shapes defaults and round-trips an explicit shapes block (DOR-355)', () => {
    const empty = UserConfigSchema.parse({ version: 1 });
    expect(empty.ui.shapes).toEqual({ active: null, agentDefaults: {}, autoFollowAgent: false });

    const explicit = UserConfigSchema.parse({
      version: 1,
      ui: {
        shapes: {
          active: 'linear-ops',
          agentDefaults: { '/projects/api': 'linear-ops' },
          autoFollowAgent: true,
        },
      },
    });
    expect(explicit.ui.shapes).toEqual({
      active: 'linear-ops',
      agentDefaults: { '/projects/api': 'linear-ops' },
      autoFollowAgent: true,
    });
  });

  it('rejects invalid version', () => {
    expect(() => UserConfigSchema.parse({ version: 2 })).toThrow();
    expect(() => UserConfigSchema.parse({ version: 0 })).toThrow();
  });
});

describe('SENSITIVE_CONFIG_KEYS', () => {
  it('contains expected sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.authtoken');
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.auth');
    expect(SENSITIVE_CONFIG_KEYS).toContain('mcp.apiKey');
    expect(SENSITIVE_CONFIG_KEYS).toContain('cloud.instanceToken');
    // The relink proof continues a link with the account's approval (DOR-2521).
    expect(SENSITIVE_CONFIG_KEYS).toContain('cloud.previousLinkProof');
  });
});

describe('USER_CONFIG_DEFAULTS', () => {
  it('is valid according to schema', () => {
    expect(() => UserConfigSchema.parse(USER_CONFIG_DEFAULTS)).not.toThrow();
  });

  it('keeps the default port at 4242, which another package reads as "no opinion"', () => {
    // Not merely "there is a default": the *value* is load-bearing outside this
    // package. `conf` writes defaults to disk, so every config.json carries this
    // number whether or not anyone chose it, and the desktop shell tells a
    // pinned port from an unchosen one by comparing against it. A comment on
    // that side cannot fire when someone edits this side, so the assertion
    // lives here, where the value that must not move actually is.
    expect(
      USER_CONFIG_DEFAULTS.server.port,
      'PREFERRED_SERVER_PORT in apps/desktop/src/main/server-port.ts must equal this default. ' +
        'It compares server.port against 4242 to tell a port someone pinned from the one `conf` ' +
        "writes into every config.json. Change this without changing that and every install's " +
        'written-out default reads as a deliberate pin, so the desktop app refuses to start ' +
        'instead of stepping past a busy port (DOR-539). Update both, or neither.'
    ).toBe(4242);
  });
});

describe('UserConfigSchema logging', () => {
  it('logging.level rejects invalid values', () => {
    expect(() => UserConfigSchema.parse({ version: 1, logging: { level: 'verbose' } })).toThrow();
  });
});

/**
 * The two-declaration rule (spec `full-power-defaults`, D1).
 *
 * Every leaf's default is written twice — once per-field on the Zod object, once
 * inside its section's `.default(() => ({ … }))` factory — and `conf` reaches a
 * different one depending on how much of the section is already on disk. A
 * FRESH install has no section, so the factory answers; an UPGRADE whose stored
 * section predates the leaf has the section but not the key, so the per-field
 * default answers. Declaring only one of the two is a silent disagreement
 * between those two populations, and nothing else in the suite would see it,
 * because every other fixture parses `{ version: 1 }` and only ever exercises
 * the factory.
 *
 * Pinned for the leaves this program adds or moves. It is deliberately not a
 * whole-schema sweep: a generic walker would need to know which sections are
 * `z.preprocess`-wrapped and which carry `z.record`s, and a guard nobody can
 * read is a guard nobody maintains.
 */
describe('per-field and section-literal defaults agree', () => {
  /**
   * The top-level section factory's answer: nothing of the section is on disk.
   * For `runtimes` that is the literal which inlines a whole `claudeCode` block,
   * NOT `claudeCode`'s own factory — see the third case below for that one.
   */
  const fromFactory = UserConfigSchema.parse({ version: 1 });
  /** The per-field answer: the section is on disk, but empty of these leaves. */
  const fromFields = UserConfigSchema.parse({
    version: 1,
    ui: {},
    scheduler: {},
    keepAwake: {},
    heartbeats: {},
    activity: {},
    network: {},
    runtimes: { claudeCode: {} },
  });

  it('ui.dmView is on and ui.showSessions off either way (DOR-3074)', () => {
    for (const config of [fromFactory, fromFields]) {
      expect(config.ui.dmView).toBe(true);
      expect(config.ui.showSessions).toBe(false);
    }
  });

  it('runtimes.defaultTrustStop is Full autonomy either way (ADR 261006-225605)', () => {
    const fromEmpty = UserConfigSchema.parse({ version: 1, runtimes: {} });
    expect(fromFactory.runtimes.defaultTrustStop).toBe('autonomy');
    expect(fromEmpty.runtimes.defaultTrustStop).toBe('autonomy');
  });

  it('heartbeats are on, and nobody has chosen credits for checks, either way', () => {
    expect(fromFactory.heartbeats).toEqual({
      enabled: true,
      triageOnCredits: null,
      idleAlertRoomId: null,
    });
    expect(fromFields.heartbeats).toEqual({
      enabled: true,
      triageOnCredits: null,
      idleAlertRoomId: null,
    });
  });

  it('network trusts no company certificates either way (DOR-3361)', () => {
    expect(fromFactory.network).toEqual({ extraCaCertsPath: null });
    expect(fromFields.network).toEqual({ extraCaCertsPath: null });
  });

  it('remoteAccess is on either way, so an upgrade closes nothing (DOR-3650)', () => {
    expect(fromFactory.remoteAccess).toEqual({ enabled: true });
    expect(fromFields.remoteAccess).toEqual({ enabled: true });
  });

  it('the claudeCode section literal agrees with the other two declarations', () => {
    // Three declarations carry `persistentSession`, not two, and the three shapes
    // that reach them are worth naming because it is easy to get backwards:
    //
    // - `{ version: 1 }` — no `runtimes` at all, so the RUNTIMES factory runs and
    //   answers from the whole `claudeCode` block it inlines. That is
    //   `fromFactory` above.
    // - `{ runtimes: { claudeCode: {} } }` — the section is there and the leaf is
    //   not, so the PER-FIELD default answers. That is `fromFields` above.
    // - `{ runtimes: {} }` — `runtimes` is there and `claudeCode` is not, so
    //   `claudeCode`'s OWN factory answers. That is this case, the third one, and
    //   nothing else in the suite reaches it.
    expect(
      UserConfigSchema.parse({ version: 1, runtimes: {} }).runtimes.claudeCode.persistentSession
    ).toBe(true);
  });

  it('drops the retired power-door answer, and takes an ISO timestamp for the notice', () => {
    const ui = UserConfigSchema.parse({
      version: 1,
      ui: { fullPowerDecidedAt: '2026-08-22T10:00:00.000Z', fullPowerChoice: 'full' },
    }).ui;
    expect(ui).not.toHaveProperty('fullPowerDecidedAt');
    expect(ui).not.toHaveProperty('fullPowerChoice');
    expect(
      UserConfigSchema.parse({ version: 1, ui: { trustNoticeSeenAt: '2026-10-07T10:00:00.000Z' } })
        .ui.trustNoticeSeenAt
    ).toBe('2026-10-07T10:00:00.000Z');
    expect(
      UserConfigSchema.safeParse({ version: 1, ui: { trustNoticeSeenAt: 'yesterday' } }).success
    ).toBe(false);
  });
});

describe('ONBOARDING_STEPS', () => {
  it('is a widening, so every step id an older config could have stored still parses', () => {
    // Why no scrub migration ships with `'power'`: the 0.55.0 body filters
    // persisted step arrays down to whatever this set holds, so a WIDER set only
    // ever keeps more. Narrowing is the move that needs a migration.
    for (const step of ['meet-dorkbot', 'profile', 'discovery'] as const) {
      expect(OnboardingStepSchema.safeParse(step).success).toBe(true);
    }
  });
});

describe('UserConfigSchema telemetry', () => {
  // Every channel defaults OFF (ADR 260727-181825, superseding 260713-143958's
  // Tier 1 opt-out posture). Anonymity is a property of the payload, not a
  // substitute for an answer; the notice-before-send gate still applies on top.
  const TIER1_DEFAULTS = {
    userHasDecided: false,
    install: false,
    heartbeat: false,
    errorReporting: false,
    lastPromptedVersion: null,
    usage: false,
    linkAnalyticsToAccount: false,
    aiMetadata: false,
  };

  it('telemetry defaults every channel off when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.telemetry).toEqual(TIER1_DEFAULTS);
  });
});

describe('UserConfigSchema runtimes', () => {
  it('rejects an out-of-range opencode.port', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { opencode: { port: 70000 } } })
    ).toThrow();
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { opencode: { port: -1 } } })
    ).toThrow();
  });
});

describe('UserConfigSchema runtimes.*.defaultModel / defaultEffort (spec execution-defaults)', () => {
  it('ships null everywhere, so an upgrade starts nobody somewhere new', () => {
    const runtimes = UserConfigSchema.parse({ version: 1 }).runtimes;
    expect(runtimes.claudeCode.defaultModel).toBeNull();
    expect(runtimes.claudeCode.defaultEffort).toBeNull();
    expect(runtimes.codex.defaultModel).toBeNull();
    expect(runtimes.codex.defaultEffort).toBeNull();
    expect(runtimes.opencode.defaultModel).toBeNull();
  });

  it('takes the effort ladder and nothing else', () => {
    // The value space is the shared EFFORT_LEVELS ladder, never a per-runtime
    // fork: an id outside it is a typo, not a new rung.
    for (const level of EFFORT_LEVELS) {
      expect(
        UserConfigSchema.parse({ version: 1, runtimes: { codex: { defaultEffort: level } } })
          .runtimes.codex.defaultEffort
      ).toBe(level);
    }
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { codex: { defaultEffort: 'ludicrous' } } })
    ).toThrow();
  });

  it('keeps a model and an effort a person chose', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: { defaultModel: 'opus', defaultEffort: 'max' },
        opencode: { defaultModel: 'openrouter/anthropic/claude-opus-4.6' },
      },
    });
    expect(result.runtimes.claudeCode.defaultModel).toBe('opus');
    expect(result.runtimes.claudeCode.defaultEffort).toBe('max');
    expect(result.runtimes.opencode.defaultModel).toBe('openrouter/anthropic/claude-opus-4.6');
  });
});

describe('UserConfigSchema defaultTrustStop (spec trust-dial, decision 6)', () => {
  it('ships Full autonomy globally and null per runtime, so every runtime follows it', () => {
    // ADR 261006-225605: our own agents work without asking by default.
    const runtimes = UserConfigSchema.parse({ version: 1 }).runtimes;
    expect(runtimes.defaultTrustStop).toBe('autonomy');
    expect(runtimes.claudeCode.defaultTrustStop).toBeNull();
    expect(runtimes.codex.defaultTrustStop).toBeNull();
    expect(runtimes.opencode.defaultTrustStop).toBeNull();
  });

  it('takes exactly the three dial positions, globally and per runtime', () => {
    // The vocabulary's home is `PermissionStop` in `agent-runtime.ts`; this is
    // the stored half of it, and a fourth word here would be a stop no runtime
    // declares. `PERMISSION_STOPS` is the list both sides read.
    for (const stop of PERMISSION_STOPS) {
      const parsed = UserConfigSchema.parse({
        version: 1,
        runtimes: { defaultTrustStop: stop, codex: { defaultTrustStop: stop } },
      }).runtimes;
      expect(parsed.defaultTrustStop).toBe(stop);
      expect(parsed.codex.defaultTrustStop).toBe(stop);
    }
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { defaultTrustStop: 'yolo' } })
    ).toThrow();
    // Never a mode id: config stores the stop, and `bypassPermissions` is one
    // runtime's word for one of them.
    expect(() =>
      UserConfigSchema.parse({
        version: 1,
        runtimes: { claudeCode: { defaultTrustStop: 'bypassPermissions' } },
      })
    ).toThrow();
  });

  it('keeps a global stop and a per-runtime override side by side', () => {
    const runtimes = UserConfigSchema.parse({
      version: 1,
      runtimes: { defaultTrustStop: 'autonomy', codex: { defaultTrustStop: 'ask' } },
    }).runtimes;
    expect(runtimes.defaultTrustStop).toBe('autonomy');
    expect(runtimes.codex.defaultTrustStop).toBe('ask');
    expect(runtimes.claudeCode.defaultTrustStop).toBeNull();
  });
});

describe('UserConfigSchema extensions (deviation lists)', () => {
  it('defaults approvedToRun to [] — nothing is approved unless a person said so', () => {
    // A stored config written before DOR-516 has no `approvedToRun` key at all, and
    // it must read as "nothing approved", never as "everything already enabled is
    // fine to run". The migration writes the key through; this default is what
    // covers the read that happens first.
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { enabled: ['hello-world'], disabled: [] },
    });
    expect(result.extensions.approvedToRun).toEqual([]);
  });

  it('round-trips the copy an approval was given to (DOR-2383)', () => {
    const approvedSources = {
      flow: { path: '/h/.dork/plugins/flow/.dork/extensions/flow', plugin: 'flow' },
      'my-ext': { path: '/h/.dork/extensions/my-ext' },
    };
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { approvedToRun: ['flow', 'my-ext'], approvedSources },
    });
    expect(result.extensions.approvedSources).toEqual(approvedSources);
  });

  it('round-trips the copies a person said "Not now" to (DOR-2517)', () => {
    const dismissedApprovals = {
      flow: {
        path: '/h/.dork/plugins/flow/.dork/extensions/flow',
        plugin: 'flow',
        version: '1.2.0',
        dismissedAt: '2026-09-28T12:00:00.000Z',
      },
    };
    const result = UserConfigSchema.parse({ version: 1, extensions: { dismissedApprovals } });
    expect(result.extensions.dismissedApprovals).toEqual(dismissedApprovals);
  });

  it('refuses a "Not now" that does not say which version it was for', () => {
    expect(() =>
      UserConfigSchema.parse({
        version: 1,
        extensions: { dismissedApprovals: { flow: { path: '/p', dismissedAt: 'x' } } },
      })
    ).toThrow();
  });
});

describe('permissions section (spec agent-permissions D4)', () => {
  // Declared twice on purpose (per field AND in the object-literal default): one
  // feeds fresh installs, the other feeds a stored `permissions: {}` on upgrade.
  // They must agree, and this pins both.
  const EXPECTED = {
    preset: 'trusted',
    defaults: { areas: {}, actions: {} },
    upgradeSweptVersion: null,
    trustedStoresAppliedAt: null,
    sharedAppsAppliedAt: null,
    sharedAtUpgrade: [],
    approvedFolderAllows: [],
    refusedFolderAllows: [],
    approvedFolderAllowRules: {},
  };

  it('defaults every field from its own declaration', () => {
    expect(UserConfigSchema.parse({ version: 1, permissions: {} }).permissions).toEqual(EXPECTED);
    expect(
      UserConfigSchema.parse({ version: 1, permissions: { defaults: {} } }).permissions
    ).toEqual(EXPECTED);
  });

  it('refuses a state that is not one of the three', () => {
    expect(() =>
      UserConfigSchema.parse({
        version: 1,
        permissions: { defaults: { areas: { rooms: 'yes' } } },
      })
    ).toThrow();
  });

  it('keeps an area key a newer build knows', () => {
    const parsed = UserConfigSchema.parse({
      version: 1,
      permissions: { defaults: { areas: { future: 'ask' } } },
    });
    expect(parsed.permissions.defaults.areas).toEqual({ future: 'ask' });
  });
});

describe('configuredRuntimes', () => {
  /** A dotted-path reader over a flat map, standing in for a config store. */
  const reader =
    (values: Record<string, unknown>) =>
    (key: string): unknown =>
      values[key];

  it('drops only a runtime that is explicitly off, keeping claude-code first', () => {
    expect(configuredRuntimes(reader({ 'runtimes.codex.enabled': false }))).toEqual([
      'claude-code',
      'opencode',
      'doe',
    ]);
    expect(
      configuredRuntimes(
        reader({
          'runtimes.codex.enabled': false,
          'runtimes.opencode.enabled': false,
          'runtimes.doe.enabled': false,
        })
      )
    ).toEqual(['claude-code']);
  });

  it('treats an unreadable value as the default rather than as off', () => {
    expect(configuredRuntimes(reader({ 'runtimes.opencode.enabled': 'no' }))).toEqual([
      'claude-code',
      'codex',
      'opencode',
      'doe',
    ]);
  });
});
