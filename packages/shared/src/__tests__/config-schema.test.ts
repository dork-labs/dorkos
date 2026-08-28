import { describe, it, expect } from 'vitest';
import { EFFORT_LEVELS } from '../constants.js';
import { PERMISSION_STOPS } from '../permission-semantics.js';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  healClaudeAccountRename,
  settleLegacyAccountAlias,
  SENSITIVE_CONFIG_KEYS,
  LOG_LEVEL_MAP,
  ONBOARDING_STEPS,
  OnboardingStepSchema,
  SidebarGroupSchema,
  SidebarPrefsSchema,
  SIDEBAR_PREFS_DEFAULTS,
  SidebarDisplayFilterSchema,
  SmartGroupRulesSchema,
  SidebarItemRefSchema,
  sameSidebarItem,
  toSidebarItemRef,
} from '../config-schema.js';
import type { UserConfig, SidebarPrefs } from '../config-schema.js';

describe('the relay turn ceiling', () => {
  /**
   * Parse just the relay block, with the two ceiling fields under test.
   *
   * @param relay - The partial relay config to parse.
   */
  function parseRelay(relay: Record<string, unknown>) {
    return UserConfigSchema.safeParse({ version: 1, relay });
  }

  it('accepts the whole declared range, both ends', () => {
    expect(parseRelay({ maxAgentTurnsTotalPerHour: 0 }).success).toBe(true);
    expect(parseRelay({ maxAgentTurnsTotalPerHour: 100_000 }).success).toBe(true);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 0 }).success).toBe(true);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 100_000 }).success).toBe(true);
  });

  it('refuses a number outside it, so no surface can offer a ceiling the store would take', () => {
    expect(parseRelay({ maxAgentTurnsTotalPerHour: -1 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsTotalPerHour: 100_001 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 100_001 }).success).toBe(false);
    expect(parseRelay({ maxAgentTurnsPerAgentPerHour: 1.5 }).success).toBe(false);
  });

  it('keeps `null` — no limit — as a distinct state rather than a number in range', () => {
    const parsed = parseRelay({ maxAgentTurnsTotalPerHour: null });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.relay.maxAgentTurnsTotalPerHour).toBeNull();
  });
});

describe('UserConfigSchema', () => {
  it('parses minimal input with defaults filled', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result).toEqual({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null, open: true },
      tunnel: {
        enabled: false,
        domain: null,
        authtoken: null,
        auth: null,
      },
      ui: {
        theme: 'system',
        dismissedUpgradeVersions: [],
        sidebar: {
          pinned: [],
          groups: [],
          sections: {},
          muted: [],
          gettingStarted: { retired: [] },
          digest: {},
        },
        promos: { dismissedIds: [] },
        shapes: {
          active: null,
          agentDefaults: {},
          autoFollowAgent: false,
        },
        statusBar: { pins: [] },
        composer: { richText: true },
        autonomyAcknowledgedAt: null,
        fullPowerDecidedAt: null,
        fullPowerChoice: null,
      },
      // How loud DorkOS may be. The knock and the all-clear ship ON; the
      // every-turn chime ships OFF, which is the one that changed (DOR-1385).
      notifications: {
        escalation: { phoneAfterMinutes: 2 },
        sounds: { knock: true, allClear: true, turnEnd: false },
        notifyOnTurnCompleteWhileAway: true,
        browserPermissionPrimerDismissed: false,
      },
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
      relay: {
        enabled: true,
        dataDir: null,
        maxAgentTurnsPerAgentPerHour: 1000,
        maxAgentTurnsTotalPerHour: 5000,
      },
      // Ships closed: nothing outside DorkOS reaches these agents over A2A
      // until a person opens that door (DOR-1304).
      a2a: { enabled: false },
      scheduler: { enabled: true, maxConcurrentRuns: 4, retentionCount: 100 },
      mesh: { scanRoots: [] },
      rooms: {
        turnLimitsEnabled: true,
        maxAgentDepth: 30,
        maxTurnsPerAgentPerCascade: 10,
        maxAutomaticTurnsPerRoomPerHour: 1000,
        maxAutomaticTurnsTotalPerHour: 5000,
        replyWaitMinutes: 10,
        lateReplyCeilingMinutes: 60,
        engagedWindowMinutes: 10,
        engagedWindowPosts: 5,
        collectDebounceMs: 500,
        collectMaxEntries: 20,
        repo: {
          enabled: true,
          worktreeReapDays: 14,
          maxFileBytes: 5 * 1024 * 1024,
          maxRepoBytes: 500 * 1024 * 1024,
          maxRoomMdBytes: 24 * 1024,
          mergeQueueWaitMs: 30_000,
        },
      },
      welcomeBack: {
        enabled: true,
        absenceThresholdMinutes: 240,
        maxPosts: 3,
        offersEnabled: true,
      },
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
        runtimeDefaultSetAt: null,
      },
      tours: { seen: [], declined: [] },
      profile: { roles: [], tools: [], displayName: null, rolePromptDismissedAt: null },
      agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      uploads: { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] },
      agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      memory: { provider: 'builtin' },
      extensions: { enabled: [], disabled: [], approvedToRun: [] },
      mcp: {
        enabled: true,
        apiKey: null,
        rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
      },
      telemetry: {
        userHasDecided: false,
        install: false,
        heartbeat: false,
        errorReporting: false,
        lastPromptedVersion: null,
        usage: false,
        linkAnalyticsToAccount: false,
        aiMetadata: false,
      },
      workspace: {
        enabled: true,
        rootPath: null,
        portBase: 4250,
        portBlockSize: 10,
        defaultProvider: 'worktree',
        retentionCap: null,
      },
      harness: { autoSync: true, approvedHooks: [] },
      workbench: { defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: true },
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: null,
        claudeCode: {
          defaultAccount: null,
          accounts: [],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
          persistentSession: true,
        },
        opencode: {
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: null,
          baseURL: null,
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
      },
      auth: { enabled: false },
      approvals: { standingGrants: false, trustWindowMinutes: 480, standingGrantsVoidBefore: null },
      cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
      connectors: { rawMcpServers: [] },
      providers: {},
    });
  });

  it('rejects invalid port below 1024', () => {
    expect(() => UserConfigSchema.parse({ version: 1, server: { port: 80 } })).toThrow();
  });

  it('rejects invalid port above 65535', () => {
    expect(() => UserConfigSchema.parse({ version: 1, server: { port: 70000 } })).toThrow();
  });

  it('rejects non-integer port', () => {
    expect(() => UserConfigSchema.parse({ version: 1, server: { port: 4242.5 } })).toThrow();
  });

  it('rejects invalid theme value', () => {
    expect(() => UserConfigSchema.parse({ version: 1, ui: { theme: 'blue' } })).toThrow();
  });

  it('accepts null for nullable fields', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { cwd: null, boundary: null },
      tunnel: { domain: null, authtoken: null, auth: null },
    });
    expect(result.server.cwd).toBeNull();
    expect(result.server.boundary).toBeNull();
    expect(result.tunnel.domain).toBeNull();
    expect(result.tunnel.authtoken).toBeNull();
    expect(result.tunnel.auth).toBeNull();
  });

  it('server.boundary defaults to null', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.server.boundary).toBeNull();
  });

  it('server.boundary accepts a string path', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { boundary: '/home/user/projects' },
    });
    expect(result.server.boundary).toBe('/home/user/projects');
  });

  it('server.boundary accepts null explicitly', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { boundary: null },
    });
    expect(result.server.boundary).toBeNull();
  });

  it('accepts valid port values', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { port: 3000 },
    });
    expect(result.server.port).toBe(3000);
  });

  it('accepts valid theme values', () => {
    const light = UserConfigSchema.parse({ version: 1, ui: { theme: 'light' } });
    expect(light.ui.theme).toBe('light');

    const dark = UserConfigSchema.parse({ version: 1, ui: { theme: 'dark' } });
    expect(dark.ui.theme).toBe('dark');

    const system = UserConfigSchema.parse({ version: 1, ui: { theme: 'system' } });
    expect(system.ui.theme).toBe('system');
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

  it('accepts string values for nullable string fields', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { cwd: '/home/user/project' },
      tunnel: {
        domain: 'example.ngrok.app',
        authtoken: 'token123',
        auth: 'user:pass',
      },
    });
    expect(result.server.cwd).toBe('/home/user/project');
    expect(result.tunnel.domain).toBe('example.ngrok.app');
    expect(result.tunnel.authtoken).toBe('token123');
    expect(result.tunnel.auth).toBe('user:pass');
  });

  it('accepts boolean values for tunnel.enabled', () => {
    const enabled = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: true },
    });
    expect(enabled.tunnel.enabled).toBe(true);

    const disabled = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: false },
    });
    expect(disabled.tunnel.enabled).toBe(false);
  });

  it('rejects invalid version', () => {
    expect(() => UserConfigSchema.parse({ version: 2 })).toThrow();
    expect(() => UserConfigSchema.parse({ version: 0 })).toThrow();
  });

  it('requires version field', () => {
    expect(() => UserConfigSchema.parse({})).toThrow();
  });

  it('applies defaults at nested object levels', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: {},
      tunnel: {},
      ui: {},
    });
    expect(result.server.port).toBe(4242);
    expect(result.server.cwd).toBeNull();
    expect(result.tunnel.enabled).toBe(false);
    expect(result.relay.enabled).toBe(true);
    expect(result.scheduler.enabled).toBe(true);
    expect(result.mesh.scanRoots).toEqual([]);
    expect(result.ui.theme).toBe('system');
  });

  it('accepts partial server config with defaults', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      server: { port: 5000 },
    });
    expect(result.server.port).toBe(5000);
    expect(result.server.cwd).toBeNull();
  });

  it('accepts partial tunnel config with defaults', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      tunnel: { enabled: true, domain: 'test.ngrok.app' },
    });
    expect(result.tunnel.enabled).toBe(true);
    expect(result.tunnel.domain).toBe('test.ngrok.app');
    expect(result.tunnel.authtoken).toBeNull();
    expect(result.tunnel.auth).toBeNull();
  });
});

describe('SENSITIVE_CONFIG_KEYS', () => {
  it('contains expected sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.authtoken');
    expect(SENSITIVE_CONFIG_KEYS).toContain('tunnel.auth');
    expect(SENSITIVE_CONFIG_KEYS).toContain('mcp.apiKey');
    expect(SENSITIVE_CONFIG_KEYS).toContain('cloud.instanceToken');
  });

  it('has exactly 4 sensitive keys', () => {
    expect(SENSITIVE_CONFIG_KEYS).toHaveLength(4);
  });

  it('is readonly array', () => {
    expect(Object.isFrozen(SENSITIVE_CONFIG_KEYS)).toBe(false);
    // TypeScript enforces readonly at compile time
    expect(Array.isArray(SENSITIVE_CONFIG_KEYS)).toBe(true);
  });
});

describe('approvals.standingGrantsVoidBefore', () => {
  // The posture floor (DOR-520). The grant store treats a FALSY floor as "no
  // floor", so the empty string is the one value that would silently disable the
  // filter instead of tightening it. Every other malformed value already fails
  // closed — it sorts above every real timestamp, so every permission is voided —
  // which is why this asserts the direction, not just "invalid is rejected".
  /** Parse a config carrying one candidate floor value. */
  function parseFloor(value: unknown) {
    return UserConfigSchema.safeParse({
      version: 1,
      approvals: { standingGrantsVoidBefore: value },
    });
  }

  it('accepts a real timestamp and the absence of one', () => {
    expect(parseFloor('2026-07-26T10:00:00.000Z').success).toBe(true);
    expect(parseFloor(null).success).toBe(true);
  });

  it('rejects the empty string, which would disable the filter rather than tighten it', () => {
    expect(parseFloor('').success).toBe(false);
  });

  it('rejects a string that is not a timestamp at all', () => {
    expect(parseFloor('not-a-date').success).toBe(false);
  });
});

describe('USER_CONFIG_DEFAULTS', () => {
  it('matches schema defaults', () => {
    expect(USER_CONFIG_DEFAULTS).toEqual({
      version: 1,
      server: { port: 4242, cwd: null, boundary: null, open: true },
      tunnel: {
        enabled: false,
        domain: null,
        authtoken: null,
        auth: null,
      },
      ui: {
        theme: 'system',
        dismissedUpgradeVersions: [],
        sidebar: {
          pinned: [],
          groups: [],
          sections: {},
          muted: [],
          gettingStarted: { retired: [] },
          digest: {},
        },
        promos: { dismissedIds: [] },
        shapes: {
          active: null,
          agentDefaults: {},
          autoFollowAgent: false,
        },
        statusBar: { pins: [] },
        composer: { richText: true },
        autonomyAcknowledgedAt: null,
        fullPowerDecidedAt: null,
        fullPowerChoice: null,
      },
      // How loud DorkOS may be. The knock and the all-clear ship ON; the
      // every-turn chime ships OFF, which is the one that changed (DOR-1385).
      notifications: {
        escalation: { phoneAfterMinutes: 2 },
        sounds: { knock: true, allClear: true, turnEnd: false },
        notifyOnTurnCompleteWhileAway: true,
        browserPermissionPrimerDismissed: false,
      },
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
      relay: {
        enabled: true,
        dataDir: null,
        maxAgentTurnsPerAgentPerHour: 1000,
        maxAgentTurnsTotalPerHour: 5000,
      },
      // Ships closed: nothing outside DorkOS reaches these agents over A2A
      // until a person opens that door (DOR-1304).
      a2a: { enabled: false },
      scheduler: { enabled: true, maxConcurrentRuns: 4, retentionCount: 100 },
      mesh: { scanRoots: [] },
      rooms: {
        turnLimitsEnabled: true,
        maxAgentDepth: 30,
        maxTurnsPerAgentPerCascade: 10,
        maxAutomaticTurnsPerRoomPerHour: 1000,
        maxAutomaticTurnsTotalPerHour: 5000,
        replyWaitMinutes: 10,
        lateReplyCeilingMinutes: 60,
        engagedWindowMinutes: 10,
        engagedWindowPosts: 5,
        collectDebounceMs: 500,
        collectMaxEntries: 20,
        repo: {
          enabled: true,
          worktreeReapDays: 14,
          maxFileBytes: 5 * 1024 * 1024,
          maxRepoBytes: 500 * 1024 * 1024,
          maxRoomMdBytes: 24 * 1024,
          mergeQueueWaitMs: 30_000,
        },
      },
      welcomeBack: {
        enabled: true,
        absenceThresholdMinutes: 240,
        maxPosts: 3,
        offersEnabled: true,
      },
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
        runtimeDefaultSetAt: null,
      },
      tours: { seen: [], declined: [] },
      profile: { roles: [], tools: [], displayName: null, rolePromptDismissedAt: null },
      agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      uploads: { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] },
      agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
      memory: { provider: 'builtin' },
      extensions: { enabled: [], disabled: [], approvedToRun: [] },
      mcp: {
        enabled: true,
        apiKey: null,
        rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
      },
      telemetry: {
        userHasDecided: false,
        install: false,
        heartbeat: false,
        errorReporting: false,
        lastPromptedVersion: null,
        usage: false,
        linkAnalyticsToAccount: false,
        aiMetadata: false,
      },
      workspace: {
        enabled: true,
        rootPath: null,
        portBase: 4250,
        portBlockSize: 10,
        defaultProvider: 'worktree',
        retentionCap: null,
      },
      harness: { autoSync: true, approvedHooks: [] },
      workbench: { defaultViewers: {}, terminalGraceTtlMinutes: 10, autoOpenDiff: true },
      runtimes: {
        default: 'claude-code',
        defaultTrustStop: null,
        claudeCode: {
          defaultAccount: null,
          accounts: [],
          defaultModel: null,
          defaultEffort: null,
          defaultTrustStop: null,
          persistentSession: true,
        },
        opencode: {
          enabled: true,
          binaryPath: null,
          port: 0,
          provider: null,
          baseURL: null,
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
      },
      auth: { enabled: false },
      approvals: { standingGrants: false, trustWindowMinutes: 480, standingGrantsVoidBefore: null },
      cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
      connectors: { rawMcpServers: [] },
      providers: {},
    });
  });

  it('satisfies UserConfig type', () => {
    const config: UserConfig = USER_CONFIG_DEFAULTS;
    expect(config.version).toBe(1);
  });

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

  it('has correct default theme', () => {
    expect(USER_CONFIG_DEFAULTS.ui.theme).toBe('system');
  });

  it('has correct default tunnel state', () => {
    expect(USER_CONFIG_DEFAULTS.tunnel.enabled).toBe(false);
  });

  it('has correct default logging level', () => {
    expect(USER_CONFIG_DEFAULTS.logging.level).toBe('info');
  });
});

describe('UserConfigSchema logging', () => {
  it('logging.level defaults to "info" when logging section omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.logging.level).toBe('info');
  });

  it('logging section defaults to { level: "info" } when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.logging).toEqual({ level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 });
  });

  it('logging.level accepts "fatal"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'fatal' } });
    expect(result.logging.level).toBe('fatal');
  });

  it('logging.level accepts "error"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'error' } });
    expect(result.logging.level).toBe('error');
  });

  it('logging.level accepts "warn"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'warn' } });
    expect(result.logging.level).toBe('warn');
  });

  it('logging.level accepts "info"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'info' } });
    expect(result.logging.level).toBe('info');
  });

  it('logging.level accepts "debug"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'debug' } });
    expect(result.logging.level).toBe('debug');
  });

  it('logging.level accepts "trace"', () => {
    const result = UserConfigSchema.parse({ version: 1, logging: { level: 'trace' } });
    expect(result.logging.level).toBe('trace');
  });

  it('logging.level rejects invalid values', () => {
    expect(() => UserConfigSchema.parse({ version: 1, logging: { level: 'verbose' } })).toThrow();
  });

  it('logging.level rejects numeric strings', () => {
    expect(() => UserConfigSchema.parse({ version: 1, logging: { level: '3' } })).toThrow();
  });
});

describe('LOG_LEVEL_MAP', () => {
  it('maps "fatal" to 0', () => {
    expect(LOG_LEVEL_MAP['fatal']).toBe(0);
  });

  it('maps "error" to 1', () => {
    expect(LOG_LEVEL_MAP['error']).toBe(1);
  });

  it('maps "warn" to 2', () => {
    expect(LOG_LEVEL_MAP['warn']).toBe(2);
  });

  it('maps "info" to 3', () => {
    expect(LOG_LEVEL_MAP['info']).toBe(3);
  });

  it('maps "debug" to 4', () => {
    expect(LOG_LEVEL_MAP['debug']).toBe(4);
  });

  it('maps "trace" to 5', () => {
    expect(LOG_LEVEL_MAP['trace']).toBe(5);
  });

  it('contains exactly the 6 standard log levels', () => {
    expect(Object.keys(LOG_LEVEL_MAP)).toHaveLength(6);
  });

  it('all values are unique integers', () => {
    const values = Object.values(LOG_LEVEL_MAP);
    expect(new Set(values).size).toBe(values.length);
    expect(values.every(Number.isInteger)).toBe(true);
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
    runtimes: { claudeCode: {} },
  });

  it('ui.fullPowerDecidedAt is null either way', () => {
    expect(fromFactory.ui.fullPowerDecidedAt).toBeNull();
    expect(fromFields.ui.fullPowerDecidedAt).toBeNull();
  });

  it('ui.fullPowerChoice is null either way', () => {
    expect(fromFactory.ui.fullPowerChoice).toBeNull();
    expect(fromFields.ui.fullPowerChoice).toBeNull();
  });

  it('scheduler.maxConcurrentRuns is 4 either way', () => {
    expect(fromFactory.scheduler.maxConcurrentRuns).toBe(4);
    expect(fromFields.scheduler.maxConcurrentRuns).toBe(4);
  });

  it('runtimes.claudeCode.persistentSession is true either way', () => {
    expect(fromFactory.runtimes.claudeCode.persistentSession).toBe(true);
    expect(fromFields.runtimes.claudeCode.persistentSession).toBe(true);
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

  it('keeps the scheduler bounds it always had', () => {
    expect(
      UserConfigSchema.safeParse({ version: 1, scheduler: { maxConcurrentRuns: 0 } }).success
    ).toBe(false);
    expect(
      UserConfigSchema.safeParse({ version: 1, scheduler: { maxConcurrentRuns: 10 } }).success
    ).toBe(true);
    expect(
      UserConfigSchema.safeParse({ version: 1, scheduler: { maxConcurrentRuns: 11 } }).success
    ).toBe(false);
  });

  it('accepts both answers at the power door and nothing else', () => {
    expect(
      UserConfigSchema.parse({ version: 1, ui: { fullPowerChoice: 'supervised' } }).ui
        .fullPowerChoice
    ).toBe('supervised');
    expect(
      UserConfigSchema.parse({ version: 1, ui: { fullPowerChoice: 'full' } }).ui.fullPowerChoice
    ).toBe('full');
    expect(UserConfigSchema.safeParse({ version: 1, ui: { fullPowerChoice: 'yes' } }).success).toBe(
      false
    );
  });

  it('takes an ISO timestamp for the decision, and refuses a loose string', () => {
    expect(
      UserConfigSchema.parse({ version: 1, ui: { fullPowerDecidedAt: '2026-08-22T10:00:00.000Z' } })
        .ui.fullPowerDecidedAt
    ).toBe('2026-08-22T10:00:00.000Z');
    expect(
      UserConfigSchema.safeParse({ version: 1, ui: { fullPowerDecidedAt: 'yesterday' } }).success
    ).toBe(false);
  });

  it('leaves every consent-gated default exactly where it was (invariant A1)', () => {
    // The list a reviewer checks this diff against. Nothing in this program may
    // move any of them; they are written by the door's accept, with a person
    // looking at it.
    expect(fromFactory.runtimes.defaultTrustStop).toBeNull();
    expect(fromFactory.runtimes.claudeCode.defaultTrustStop).toBeNull();
    expect(fromFactory.runtimes.codex.defaultTrustStop).toBeNull();
    expect(fromFactory.runtimes.opencode.defaultTrustStop).toBeNull();
    expect(fromFactory.ui.autonomyAcknowledgedAt).toBeNull();
    expect(fromFactory.approvals.standingGrants).toBe(false);
    expect(fromFactory.mesh.scanRoots).toEqual([]);
  });
});

describe('ONBOARDING_STEPS', () => {
  it('includes meet-dorkbot', () => {
    expect(ONBOARDING_STEPS).toContain('meet-dorkbot');
  });

  it('leads with the power choice, which the flow puts before the DorkBot conversation', () => {
    expect(ONBOARDING_STEPS[0]).toBe('power');
  });

  it('contains all expected steps', () => {
    expect(ONBOARDING_STEPS).toEqual(['power', 'meet-dorkbot', 'profile', 'discovery']);
  });

  it('is a widening, so every step id an older config could have stored still parses', () => {
    // Why no scrub migration ships with `'power'`: the 0.55.0 body filters
    // persisted step arrays down to whatever this set holds, so a WIDER set only
    // ever keeps more. Narrowing is the move that needs a migration.
    for (const step of ['meet-dorkbot', 'profile', 'discovery'] as const) {
      expect(OnboardingStepSchema.safeParse(step).success).toBe(true);
    }
  });
});

describe('UserConfigSchema agents', () => {
  it('agents.defaultDirectory defaults to ~/.dork/agents', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.agents.defaultDirectory).toBe('~/.dork/agents');
  });

  it('agents.defaultAgent defaults to dorkbot', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.agents.defaultAgent).toBe('dorkbot');
  });

  it('accepts custom agents.defaultDirectory', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      agents: { defaultDirectory: '/custom/agents' },
    });
    expect(result.agents.defaultDirectory).toBe('/custom/agents');
  });

  it('accepts custom agents.defaultAgent', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      agents: { defaultAgent: 'my-agent' },
    });
    expect(result.agents.defaultAgent).toBe('my-agent');
  });

  it('agents section defaults when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.agents).toEqual({ defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' });
  });

  it('agents section defaults when empty object provided', () => {
    const result = UserConfigSchema.parse({ version: 1, agents: {} });
    expect(result.agents).toEqual({ defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' });
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

  it('telemetry section defaults when empty object provided', () => {
    const result = UserConfigSchema.parse({ version: 1, telemetry: {} });
    expect(result.telemetry).toEqual(TIER1_DEFAULTS);
  });

  it('each channel accepts an explicit value independently', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      telemetry: { install: false, heartbeat: false, errorReporting: true, userHasDecided: true },
    });
    expect(result.telemetry).toEqual({
      install: false,
      heartbeat: false,
      errorReporting: true,
      userHasDecided: true,
      lastPromptedVersion: null,
      usage: false,
      linkAnalyticsToAccount: false,
      aiMetadata: false,
    });
  });

  it('unset channels fall back to their defaults when only one is set', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      telemetry: { errorReporting: true },
    });
    // errorReporting overridden; every other channel keeps its off default.
    expect(result.telemetry).toEqual({ ...TIER1_DEFAULTS, errorReporting: true });
  });

  it('userHasDecided is independent of the channel flags', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      telemetry: { userHasDecided: true },
    });
    expect(result.telemetry.userHasDecided).toBe(true);
    // Channels keep their defaults regardless of the decision gate. A bare
    // decision flag must never imply consent to a channel.
    expect(result.telemetry.install).toBe(false);
    expect(result.telemetry.heartbeat).toBe(false);
  });

  it('rejects non-boolean channel values', () => {
    expect(() => UserConfigSchema.parse({ version: 1, telemetry: { install: 'yes' } })).toThrow();
    expect(() => UserConfigSchema.parse({ version: 1, telemetry: { heartbeat: 1 } })).toThrow();
    expect(() =>
      UserConfigSchema.parse({ version: 1, telemetry: { errorReporting: null } })
    ).toThrow();
    expect(() =>
      UserConfigSchema.parse({ version: 1, telemetry: { userHasDecided: 'yes' } })
    ).toThrow();
  });
});

describe('UserConfigSchema runtimes', () => {
  it('defaults the whole section when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.runtimes).toEqual({
      default: 'claude-code',
      defaultTrustStop: null,
      claudeCode: {
        defaultAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: true,
      },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        // OpenCode gets a model default and no effort default: its API takes none.
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
    });
  });

  it('defaults the section when an empty object is provided', () => {
    const result = UserConfigSchema.parse({ version: 1, runtimes: {} });
    expect(result.runtimes).toEqual({
      default: 'claude-code',
      defaultTrustStop: null,
      claudeCode: {
        defaultAccount: null,
        accounts: [],
        defaultModel: null,
        defaultEffort: null,
        defaultTrustStop: null,
        persistentSession: true,
      },
      opencode: {
        enabled: true,
        binaryPath: null,
        port: 0,
        provider: null,
        baseURL: null,
        // OpenCode gets a model default and no effort default: its API takes none.
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
    });
  });

  it('accepts a custom default runtime id', () => {
    const result = UserConfigSchema.parse({ version: 1, runtimes: { default: 'opencode' } });
    expect(result.runtimes.default).toBe('opencode');
    expect(result.runtimes.opencode).toEqual({
      enabled: true,
      binaryPath: null,
      port: 0,
      provider: null,
      baseURL: null,
      defaultModel: null,
      defaultTrustStop: null,
    });
  });

  it('fills opencode defaults when partially provided', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: { opencode: { enabled: false } },
    });
    expect(result.runtimes.opencode).toEqual({
      enabled: false,
      binaryPath: null,
      port: 0,
      provider: null,
      baseURL: null,
      defaultModel: null,
      defaultTrustStop: null,
    });
  });

  it('accepts a string binaryPath and a fixed port', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        opencode: { binaryPath: '/usr/local/bin/opencode', port: 5111 },
        codex: { binaryPath: '/usr/local/bin/codex' },
      },
    });
    expect(result.runtimes.opencode.binaryPath).toBe('/usr/local/bin/opencode');
    expect(result.runtimes.opencode.port).toBe(5111);
    expect(result.runtimes.codex.binaryPath).toBe('/usr/local/bin/codex');
  });

  it('rejects an out-of-range opencode.port', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { opencode: { port: 70000 } } })
    ).toThrow();
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { opencode: { port: -1 } } })
    ).toThrow();
  });

  it('rejects a non-integer opencode.port', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { opencode: { port: 42.5 } } })
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

  it('has no effort field on OpenCode at all', () => {
    // "Unsupported means said, not hidden": OpenCode's API accepts no effort, so
    // the field does not exist rather than existing and doing nothing. Zod
    // strips the unknown key, which is the assertion.
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: { opencode: { defaultEffort: 'high' } },
    });
    expect('defaultEffort' in result.runtimes.opencode).toBe(false);
  });

  it('rejects an empty model string', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, runtimes: { claudeCode: { defaultModel: '' } } })
    ).toThrow();
  });
});

describe('UserConfigSchema defaultTrustStop (spec trust-dial, decision 6)', () => {
  it('ships null everywhere, so every runtime keeps its own starting mode', () => {
    const runtimes = UserConfigSchema.parse({ version: 1 }).runtimes;
    expect(runtimes.defaultTrustStop).toBeNull();
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

describe('UserConfigSchema runtimes.claudeCode (spec claude-code-accounts)', () => {
  it('defaults to no account chosen and none registered', () => {
    // The default IS today's behavior: nothing selected, so resolution falls
    // through to the inherited environment.
    expect(UserConfigSchema.parse({ version: 1 }).runtimes.claudeCode).toEqual({
      defaultAccount: null,
      accounts: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: true,
    });
  });

  it('fills the section when a sibling runtime is the only thing provided', () => {
    // The shape that matters on upgrade: a stored `runtimes` block that predates
    // this field must read back with the section present, not undefined.
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: { opencode: { enabled: false } },
    });
    expect(result.runtimes.claudeCode).toEqual({
      defaultAccount: null,
      accounts: [],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: true,
    });
  });

  it('keeps a default account and a labelled roster verbatim', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          defaultAccount: '/Users/me/.claude2',
          accounts: [
            { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
            { id: 'claude2', path: '/Users/me/.claude2', label: null },
          ],
        },
      },
    });
    expect(result.runtimes.claudeCode).toEqual({
      defaultAccount: '/Users/me/.claude2',
      accounts: [
        { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
        { id: 'claude2', path: '/Users/me/.claude2', label: null },
      ],
      defaultModel: null,
      defaultEffort: null,
      defaultTrustStop: null,
      persistentSession: true,
    });
  });

  it('heals a registry written before ids existed, rather than refusing it', () => {
    // Every config file that has ever been written is missing `accounts[].id`
    // until the `'0.65.0'` migration runs — and a dev tree runs no migrations at
    // all. Zod parses the whole MERGED config inside `applyConfigPatch`, so a
    // refusal here is every settings write in the cockpit refused.
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/Users/me/.claude2', label: 'Acme Corp' },
            { path: '/Users/me/.claude3', label: null },
          ],
        },
      },
    });
    expect(parsed.runtimes.claudeCode.accounts).toEqual([
      { id: 'acme-corp', path: '/Users/me/.claude2', label: 'Acme Corp' },
      { id: 'claude3', path: '/Users/me/.claude3', label: null },
    ]);
  });

  it('reserves ids a LATER row already owns before minting one', () => {
    // A half-migrated registry. Seeding the taken set as it walks would let the
    // first row mint `acme-corp` and collide with the row that already holds it.
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { id: 'acme-corp', path: '/b/.claude', label: 'Acme Corp' },
          ],
        },
      },
    });
    expect(parsed.runtimes.claudeCode.accounts.map((a) => a.id)).toEqual([
      'acme-corp-2',
      'acme-corp',
    ]);
  });

  it('never invents the same id twice while healing', () => {
    const parsed = UserConfigSchema.parse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { path: '/a/.claude', label: 'Acme Corp' },
            { path: '/b/.claude', label: 'ACME corp' },
            { path: '/c/.claude', label: null },
          ],
        },
      },
    });
    const ids = parsed.runtimes.claudeCode.accounts.map((a) => a.id);
    expect(ids).toEqual(['acme-corp', 'acme-corp-2', 'claude']);
    expect(new Set(ids).size).toBe(3);
  });

  it('reads a pre-rename default, and answers in ONE spelling', () => {
    // Two claims, and the second is a contract rather than an observable end to
    // end: a parse would strip the retired key anyway. Stating it here keeps the
    // function honest for any caller that does not go through the object schema.
    const healed = healClaudeAccountRename({
      activeAccount: '/Users/me/.claude2',
      accounts: [],
    }) as Record<string, unknown>;

    expect(healed.defaultAccount).toBe('/Users/me/.claude2');
    expect(healed).not.toHaveProperty('activeAccount');
  });

  it('lets a real value under the new name outrank the retired one', () => {
    const healed = healClaudeAccountRename({
      activeAccount: '/Users/me/.claude2',
      defaultAccount: '/Users/me/.claude3',
    }) as Record<string, unknown>;

    expect(healed.defaultAccount).toBe('/Users/me/.claude3');
    expect(healed).not.toHaveProperty('activeAccount');
  });

  it('leaves a block with no retired key completely alone', () => {
    const block = { defaultAccount: null, accounts: [] };
    expect(healClaudeAccountRename(block)).toBe(block);
  });

  it('settles the retired key only when the patch NAMES the new one', () => {
    // `null` is both "never set" and "go back to inheriting". Only the patch
    // knows which, so this is where a deliberate clear is protected from the
    // heal that would otherwise resurrect the old account.
    const merged = { runtimes: { claudeCode: { activeAccount: '/a', defaultAccount: null } } };
    settleLegacyAccountAlias(merged, { runtimes: { claudeCode: { defaultAccount: null } } });
    expect(merged.runtimes.claudeCode).not.toHaveProperty('activeAccount');

    const untouched = { runtimes: { claudeCode: { activeAccount: '/a', defaultAccount: null } } };
    settleLegacyAccountAlias(untouched, { ui: { theme: 'light' } });
    expect(untouched.runtimes.claudeCode).toHaveProperty('activeAccount');
  });

  it('refuses two accounts sharing an id', () => {
    // An id is a REFERENCE: an agent manifest and a launch hint name an account
    // by it and the resolver takes the first match, so a duplicate makes one
    // account unreachable and silently bills every agent naming it to the other
    // one's subscription. Healing can never produce this; a hand edit can.
    const result = UserConfigSchema.safeParse({
      version: 1,
      runtimes: {
        claudeCode: {
          accounts: [
            { id: 'acme-corp', path: '/a/.claude', label: 'Acme Corp' },
            { id: 'acme-corp', path: '/b/.claude', label: 'Other' },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate Claude account id');
    // Named at the row that collides, so an editor can point at it.
    expect(result.error?.issues[0]?.path).toEqual(['runtimes', 'claudeCode', 'accounts', 1, 'id']);
  });

  it('rejects an account with an empty path', () => {
    // The path is the identity — an empty one names no directory at all.
    expect(() =>
      UserConfigSchema.parse({
        version: 1,
        runtimes: { claudeCode: { accounts: [{ path: '', label: null }] } },
      })
    ).toThrow();
  });

  it('rejects an account entry missing its label', () => {
    // Every field of an entry is stated, matching `connectors.rawMcpServers`:
    // an omitted label is a caller bug, not an implied null.
    expect(() =>
      UserConfigSchema.parse({
        version: 1,
        runtimes: { claudeCode: { accounts: [{ path: '/Users/me/.claude2' }] } },
      })
    ).toThrow();
  });
});

describe('SidebarItemRefSchema + sameSidebarItem (sidebar-groups, DOR-579)', () => {
  it('parses both branches of the union', () => {
    expect(SidebarItemRefSchema.parse({ kind: 'agent', path: '/projects/api' })).toEqual({
      kind: 'agent',
      path: '/projects/api',
    });
    expect(SidebarItemRefSchema.parse({ kind: 'room', roomId: '01JXYZ' })).toEqual({
      kind: 'room',
      roomId: '01JXYZ',
    });
  });

  it('keeps an agent path containing a colon intact', () => {
    // The reason this is a union and not an "agent:<path>" string: a colon is
    // legal in a POSIX path, so a prefixed string would need a
    // parse-on-first-colon rule that breaks on exactly this input.
    const ref = SidebarItemRefSchema.parse({ kind: 'agent', path: '/projects/a:b' });
    expect(ref).toEqual({ kind: 'agent', path: '/projects/a:b' });
  });

  it('rejects a missing discriminator, an unknown kind, and a mismatched payload', () => {
    expect(() => SidebarItemRefSchema.parse({ path: '/a' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'session', id: 's1' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'agent', roomId: '01JXYZ' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'room', path: '/a' })).toThrow();
  });

  it('rejects an empty path and an empty roomId', () => {
    expect(() => SidebarItemRefSchema.parse({ kind: 'agent', path: '' })).toThrow();
    expect(() => SidebarItemRefSchema.parse({ kind: 'room', roomId: '' })).toThrow();
  });

  it('sameSidebarItem is true for equal refs built as separate objects', () => {
    expect(sameSidebarItem({ kind: 'agent', path: '/a' }, { kind: 'agent', path: '/a' })).toBe(
      true
    );
    expect(sameSidebarItem({ kind: 'room', roomId: 'r1' }, { kind: 'room', roomId: 'r1' })).toBe(
      true
    );
  });

  it('sameSidebarItem is false across kinds and across payloads', () => {
    expect(sameSidebarItem({ kind: 'agent', path: '/a' }, { kind: 'agent', path: '/b' })).toBe(
      false
    );
    expect(sameSidebarItem({ kind: 'room', roomId: 'r1' }, { kind: 'room', roomId: 'r2' })).toBe(
      false
    );
    expect(sameSidebarItem({ kind: 'agent', path: 'r1' }, { kind: 'room', roomId: 'r1' })).toBe(
      false
    );
  });
});

describe('toSidebarItemRef — what a stored membership string means', () => {
  const agent = (path: string) => ({ kind: 'agent' as const, path });

  it('wraps a legacy path and passes a reference through', () => {
    // The migration is the only caller left: the read-time conversion beside it
    // was removed a release on (DOR-588). What this still pins is the mapping —
    // every pre-DOR-579 string IS an agent path, and a reference is untouched.
    expect(toSidebarItemRef('/projects/alpha')).toEqual(agent('/projects/alpha'));
    const ref = agent('/projects/alpha');
    expect(toSidebarItemRef(ref)).toBe(ref);
    const room = { kind: 'room' as const, roomId: '01JROOM' };
    expect(toSidebarItemRef(room)).toBe(room);
  });
});

describe('UserConfigSchema ui.sidebar (DOR-329)', () => {
  const SIDEBAR_DEFAULTS = {
    pinned: [],
    groups: [],
    sections: {},
    muted: [],
    gettingStarted: { retired: [] },
    digest: {},
  };

  it('parsing an empty config yields ui.sidebar with all documented defaults', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.ui.sidebar).toEqual(SIDEBAR_DEFAULTS);
  });

  it('SIDEBAR_PREFS_DEFAULTS matches the documented defaults', () => {
    expect(SIDEBAR_PREFS_DEFAULTS).toEqual(SIDEBAR_DEFAULTS);
  });

  it('SidebarPrefsSchema fills defaults from an empty object', () => {
    expect(SidebarPrefsSchema.parse({})).toEqual(SIDEBAR_DEFAULTS);
  });

  it('a group parses with its own defaults', () => {
    const group = SidebarGroupSchema.parse({ id: 'g1', name: 'Clients' });
    expect(group).toEqual({
      id: 'g1',
      name: 'Clients',
      items: [],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
      kind: 'manual',
    });
  });

  it('rejects a group name longer than 40 chars', () => {
    expect(() => SidebarGroupSchema.parse({ id: 'g1', name: 'x'.repeat(41) })).toThrow();
  });

  it('rejects an empty group name', () => {
    expect(() => SidebarGroupSchema.parse({ id: 'g1', name: '' })).toThrow();
    expect(() => SidebarGroupSchema.parse({ id: 'g1', name: '   ' })).toThrow();
  });

  it('round-trips a fully-populated sidebar', () => {
    const sidebar = {
      pinned: [
        { kind: 'agent', path: '/a' },
        { kind: 'room', roomId: 'room-1' },
      ],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [
            { kind: 'agent', path: '/a' },
            { kind: 'room', roomId: 'room-2' },
          ],
          sortMode: 'recent',
          collapsed: true,
          displayFilter: 'attention',
          muted: true,
          kind: 'manual',
        },
      ],
      sections: {
        agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' },
        channels: { collapsed: true },
        dms: { collapsed: false },
      },
      muted: [{ kind: 'agent', path: '/b' }],
      gettingStarted: { retired: ['suggestion:groups-hint', 'suggestion:ask-dorkbot'] },
      digest: { lastShownDate: '2026-08-09' },
    };
    const result = UserConfigSchema.parse({ version: 1, ui: { sidebar } });
    expect(result.ui.sidebar).toEqual(sidebar);
  });

  it('drops the eight fields the sidebar redesign retired', () => {
    // Zod strips unknown keys, so a stored config carrying the pre-redesign
    // shape parses — and comes back WITHOUT it. The conf migration is the only
    // thing that carries the values across; nothing here reads them.
    const parsed = SidebarPrefsSchema.parse({
      ungroupedSortMode: 'recent',
      ungroupedCollapsed: true,
      recentsCollapsed: true,
      channelsCollapsed: true,
      dmsCollapsed: true,
      threadsCollapsed: true,
      groupsHintDismissed: true,
      ungroupedDisplayFilter: 'active',
    }) as Record<string, unknown>;
    for (const retired of [
      'ungroupedSortMode',
      'ungroupedCollapsed',
      'recentsCollapsed',
      'channelsCollapsed',
      'dmsCollapsed',
      'threadsCollapsed',
      'groupsHintDismissed',
      'ungroupedDisplayFilter',
    ]) {
      expect(retired in parsed).toBe(false);
    }
  });

  it('sections is a PARTIAL record — one section alone is valid', () => {
    // The whole point of the record: a section id that gains state later must
    // not invalidate a config written before it existed.
    const prefs = SidebarPrefsSchema.parse({ sections: { channels: { collapsed: true } } });
    expect(prefs.sections).toEqual({ channels: { collapsed: true } });
    expect(prefs.sections.agents).toBeUndefined();
  });

  it('a section fills collapsed but leaves the two optional choices absent', () => {
    // Absent `sortMode` means "this section offers no sort", which is a
    // different statement from "sorted by its default".
    const prefs = SidebarPrefsSchema.parse({ sections: { pins: {} } });
    expect(prefs.sections.pins).toEqual({ collapsed: false });
  });

  it('DROPS a section id it has never heard of, rather than refusing the config', () => {
    // The whole forward-compatibility story. An unknown key must not be an
    // error, because `applyConfigPatch` re-validates the WHOLE config on every
    // write: refusing here would make a config that merely LOADS unwritable
    // forever. This is what lets P2 retire `threads`/`recents` from the enum
    // with no second migration and no user-visible failure.
    const prefs = SidebarPrefsSchema.parse({
      sections: { channels: { collapsed: true }, nowhere: { collapsed: true } },
    });
    expect(prefs.sections).toEqual({ channels: { collapsed: true } });
  });

  it('remembers a fold for all three computed zones', () => {
    // Every header in the sidebar folds now (`specs/sidebar-simplification` D1),
    // so the three zones that could not before need somewhere to store it. Red
    // if the enum narrows back: `useSectionChrome.toggleCollapsed` returns early
    // when the id has no persisted home, so the chevron would silently do
    // nothing rather than fail loudly.
    const prefs = SidebarPrefsSchema.parse({
      sections: {
        now: { collapsed: true },
        today: { collapsed: false },
        'getting-started': { collapsed: true },
      },
    });
    expect(prefs.sections.now).toEqual({ collapsed: true });
    expect(prefs.sections.today).toEqual({ collapsed: false });
    expect(prefs.sections['getting-started']).toEqual({ collapsed: true });
  });

  it('needs no migration to accept them, in either direction', () => {
    // **Why this widening ships without a conf migration.** Nothing on disk
    // changes shape: a config written before D1 simply has no key for these
    // three, and an absent section is already "not folded". Forward, the record
    // now accepts them; backward, `dropUnknownSectionIds` strips a key an older
    // build has never heard of, so a downgrade loses a fold flag rather than
    // producing a config that loads and then refuses every subsequent write.
    //
    // Both halves asserted, because it is the PAIR that makes a migration
    // unnecessary — one alone would leave the other direction to chance.
    const untouched = SidebarPrefsSchema.parse({ sections: { channels: { collapsed: true } } });
    expect(untouched.sections.channels).toEqual({ collapsed: true });
    expect(untouched.sections.now).toBeUndefined();

    const fromNewerBuild = SidebarPrefsSchema.parse({
      sections: { 'getting-started': { collapsed: true }, aZoneFromTheFuture: { collapsed: true } },
    });
    expect(fromNewerBuild.sections).toEqual({ 'getting-started': { collapsed: true } });
  });

  it('keeps what it was given when there is nothing to drop', () => {
    const stored = { channels: { collapsed: true } };
    expect(SidebarPrefsSchema.parse({ sections: stored }).sections).toEqual(stored);
  });

  it('still refuses a `sections` that is not an object at all', () => {
    // The filter passes a non-object straight through, so the record schema
    // reports the real type error instead of the filter swallowing it.
    expect(() => SidebarPrefsSchema.parse({ sections: [] })).toThrow();
    expect(() => SidebarPrefsSchema.parse({ sections: 'nope' })).toThrow();
  });

  it('rejects a sort mode a section cannot offer', () => {
    expect(() =>
      SidebarPrefsSchema.parse({ sections: { agents: { sortMode: 'sideways' } } })
    ).toThrow();
  });

  it('defaults gettingStarted.retired to an empty list and digest to no date', () => {
    const prefs = SidebarPrefsSchema.parse({});
    expect(prefs.gettingStarted).toEqual({ retired: [] });
    expect(prefs.digest).toEqual({});
    expect(prefs.digest.lastShownDate).toBeUndefined();
  });

  it('keeps a retired suggestion id that no longer names a live suggestion', () => {
    // `suggestion:groups-hint` is the card the groups hint became. The list is
    // a history, so a narrowed suggestion set must never invalidate it.
    const prefs = SidebarPrefsSchema.parse({
      gettingStarted: { retired: ['suggestion:groups-hint'] },
    });
    expect(prefs.gettingStarted.retired).toEqual(['suggestion:groups-hint']);
  });
});

describe('SidebarDisplayFilterSchema + display filter / mute fields (DOR-339)', () => {
  it('accepts all three filter values', () => {
    expect(SidebarDisplayFilterSchema.parse('all')).toBe('all');
    expect(SidebarDisplayFilterSchema.parse('active')).toBe('active');
    expect(SidebarDisplayFilterSchema.parse('attention')).toBe('attention');
  });

  it('rejects an unrecognized filter value', () => {
    expect(() => SidebarDisplayFilterSchema.parse('needs-attention')).toThrow();
    expect(() => SidebarDisplayFilterSchema.parse('')).toThrow();
  });

  it('a group defaults displayFilter to "all" and muted to false', () => {
    const group = SidebarGroupSchema.parse({ id: 'g1', name: 'Clients' });
    expect(group.displayFilter).toBe('all');
    expect(group.muted).toBe(false);
  });

  it('a group accepts an explicit displayFilter and muted', () => {
    const group = SidebarGroupSchema.parse({
      id: 'g1',
      name: 'Clients',
      displayFilter: 'active',
      muted: true,
    });
    expect(group.displayFilter).toBe('active');
    expect(group.muted).toBe(true);
  });

  it('SidebarPrefsSchema defaults muted to [] and the Agents section to no filter', () => {
    const prefs = SidebarPrefsSchema.parse({});
    expect(prefs.muted).toEqual([]);
    expect(prefs.sections.agents).toBeUndefined();
  });

  it('an existing (pre-DOR-339) legacy sidebar object still parses, picking up the new defaults', () => {
    const legacy = {
      pinned: [{ kind: 'agent', path: '/a' }],
      groups: [
        {
          id: 'g1',
          name: 'Clients',
          items: [{ kind: 'agent', path: '/a' }],
          sortMode: 'manual',
        },
      ],
    };
    const result = UserConfigSchema.parse({ version: 1, ui: { sidebar: legacy } });
    expect(result.ui.sidebar.muted).toEqual([]);
    expect(result.ui.sidebar.sections).toEqual({});
    expect(result.ui.sidebar.groups[0]).toEqual({
      id: 'g1',
      name: 'Clients',
      items: [{ kind: 'agent', path: '/a' }],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
      kind: 'manual',
    });
  });
});

describe('SmartGroupRulesSchema + SidebarGroupSchema kind/rules (smart-agent-groups, DOR-338)', () => {
  it('a group defaults kind to "manual" and omits rules', () => {
    const group = SidebarGroupSchema.parse({ id: 'g1', name: 'Clients' });
    expect(group.kind).toBe('manual');
    expect(group.rules).toBeUndefined();
  });

  it('a manual group ignores an empty/absent rules object', () => {
    expect(() =>
      SidebarGroupSchema.parse({ id: 'g1', name: 'Clients', kind: 'manual' })
    ).not.toThrow();
  });

  it('parses a valid smart group with one rule constraint and a non-manual sort', () => {
    const group = SidebarGroupSchema.parse({
      id: 'g1',
      name: 'Active now',
      kind: 'smart',
      sortMode: 'recent',
      rules: { statuses: ['needs-attention', 'active'] },
    });
    expect(group.kind).toBe('smart');
    expect(group.rules).toEqual({ statuses: ['needs-attention', 'active'] });
    expect(group.sortMode).toBe('recent');
  });

  it('accepts every documented rule field', () => {
    const rules = {
      runtimes: ['codex', 'opencode'],
      namespaces: ['default'],
      statuses: ['needs-attention', 'active', 'idle', 'inactive'] as const,
      lastActiveWithinMs: 3_600_000,
      pathPrefix: '/Users/dorian/work',
    };
    expect(SmartGroupRulesSchema.parse(rules)).toEqual(rules);
  });

  it('rejects a smart group with no rules field at all', () => {
    expect(() =>
      SidebarGroupSchema.parse({ id: 'g1', name: 'Empty', kind: 'smart', sortMode: 'recent' })
    ).toThrow(/at least one rule constraint/);
  });

  it('rejects a smart group with an empty rules object', () => {
    expect(() =>
      SidebarGroupSchema.parse({
        id: 'g1',
        name: 'Empty',
        kind: 'smart',
        sortMode: 'recent',
        rules: {},
      })
    ).toThrow(/at least one rule constraint/);
  });

  it('rejects a smart group whose sortMode defaults to "manual"', () => {
    expect(() =>
      SidebarGroupSchema.parse({
        id: 'g1',
        name: 'Active now',
        kind: 'smart',
        rules: { statuses: ['active'] },
      })
    ).toThrow(/can't use 'manual' sort/);
  });

  it('rejects a smart group with an explicit sortMode of "manual"', () => {
    expect(() =>
      SidebarGroupSchema.parse({
        id: 'g1',
        name: 'Active now',
        kind: 'smart',
        sortMode: 'manual',
        rules: { statuses: ['active'] },
      })
    ).toThrow(/can't use 'manual' sort/);
  });

  it('rejects an unrecognized attention status in rules.statuses', () => {
    expect(() => SmartGroupRulesSchema.parse({ statuses: ['bogus'] })).toThrow();
  });

  it('rejects a non-positive lastActiveWithinMs', () => {
    expect(() => SmartGroupRulesSchema.parse({ lastActiveWithinMs: 0 })).toThrow();
    expect(() => SmartGroupRulesSchema.parse({ lastActiveWithinMs: -1 })).toThrow();
  });

  it('rejects an empty pathPrefix', () => {
    expect(() => SmartGroupRulesSchema.parse({ pathPrefix: '' })).toThrow();
  });

  it('a legacy (pre-DOR-338) stored group without kind/rules still parses, defaulting to manual', () => {
    const legacy = {
      id: 'g1',
      name: 'Clients',
      items: [{ kind: 'agent', path: '/a' }],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
    };
    const result = UserConfigSchema.parse({
      version: 1,
      ui: { sidebar: { groups: [legacy] } },
    });
    expect(result.ui.sidebar.groups[0]?.kind).toBe('manual');
  });
});

describe('UserConfigSchema extensions (deviation lists)', () => {
  it('defaults to empty enabled and disabled when omitted', () => {
    const result = UserConfigSchema.parse({ version: 1 });
    expect(result.extensions).toEqual({ enabled: [], disabled: [], approvedToRun: [] });
  });

  it('defaults disabled to [] when only enabled is provided', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { enabled: ['linear-issues'] },
    });
    expect(result.extensions).toEqual({
      enabled: ['linear-issues'],
      disabled: [],
      approvedToRun: [],
    });
  });

  it('defaults enabled to [] when only disabled is provided', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { disabled: ['marketplace'] },
    });
    expect(result.extensions).toEqual({
      enabled: [],
      disabled: ['marketplace'],
      approvedToRun: [],
    });
  });

  it('round-trips both lists when populated', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { enabled: ['hello-world'], disabled: ['marketplace'] },
    });
    expect(result.extensions).toEqual({
      enabled: ['hello-world'],
      disabled: ['marketplace'],
      approvedToRun: [],
    });
  });

  it('rejects a non-array disabled', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, extensions: { disabled: 'marketplace' } })
    ).toThrow();
  });

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

  it('round-trips approvedToRun independently of the two deviation lists', () => {
    const result = UserConfigSchema.parse({
      version: 1,
      extensions: { enabled: [], disabled: [], approvedToRun: ['my-ext'] },
    });
    // Approved but turned OFF is a legitimate, reachable state: the person allowed
    // the code and then disabled the extension.
    expect(result.extensions).toEqual({
      enabled: [],
      disabled: [],
      approvedToRun: ['my-ext'],
    });
  });

  it('rejects a non-array approvedToRun', () => {
    expect(() =>
      UserConfigSchema.parse({ version: 1, extensions: { approvedToRun: 'my-ext' } })
    ).toThrow();
  });
});
