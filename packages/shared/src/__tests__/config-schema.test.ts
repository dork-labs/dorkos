import { describe, it, expect } from 'vitest';
import {
  UserConfigSchema,
  USER_CONFIG_DEFAULTS,
  SENSITIVE_CONFIG_KEYS,
  LOG_LEVEL_MAP,
  ONBOARDING_STEPS,
  SidebarGroupSchema,
  SidebarPrefsSchema,
  SIDEBAR_PREFS_DEFAULTS,
  SidebarDisplayFilterSchema,
  SmartGroupRulesSchema,
  SidebarItemRefSchema,
  sameSidebarItem,
  toSidebarItemRef,
  normalizeSidebarPrefs,
} from '../config-schema.js';
import type { UserConfig, SidebarPrefs } from '../config-schema.js';

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
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          channelsCollapsed: false,
          dmsCollapsed: false,
          groupsHintDismissed: false,
          muted: [],
          ungroupedDisplayFilter: 'all',
        },
        shapes: {
          active: null,
          agentDefaults: {},
          autoFollowAgent: false,
        },
        statusBar: { pins: [] },
      },
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
      relay: { enabled: true, dataDir: null },
      scheduler: { enabled: true, maxConcurrentRuns: 1, timezone: null, retentionCount: 100 },
      mesh: { scanRoots: [] },
      rooms: {
        maxAgentDepth: 3,
        maxAutomaticTurnsPerRoomPerHour: 60,
        maxAutomaticTurnsTotalPerHour: 240,
      },
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
      },
      tours: { seen: [], declined: [] },
      agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      uploads: { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] },
      agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
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
        opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
        codex: { enabled: true, binaryPath: null, credentialRef: null },
      },
      auth: { enabled: false },
      approvals: { standingGrants: false, trustWindowMinutes: 480, standingGrantsVoidBefore: null },
      cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
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
          ungroupedSortMode: 'name',
          ungroupedCollapsed: false,
          recentsCollapsed: false,
          channelsCollapsed: false,
          dmsCollapsed: false,
          groupsHintDismissed: false,
          muted: [],
          ungroupedDisplayFilter: 'all',
        },
        shapes: {
          active: null,
          agentDefaults: {},
          autoFollowAgent: false,
        },
        statusBar: { pins: [] },
      },
      logging: { level: 'info', maxLogSizeKb: 500, maxLogFiles: 14 },
      relay: { enabled: true, dataDir: null },
      scheduler: { enabled: true, maxConcurrentRuns: 1, timezone: null, retentionCount: 100 },
      mesh: { scanRoots: [] },
      rooms: {
        maxAgentDepth: 3,
        maxAutomaticTurnsPerRoomPerHour: 60,
        maxAutomaticTurnsTotalPerHour: 240,
      },
      onboarding: {
        completedSteps: [],
        skippedSteps: [],
        startedAt: null,
        dismissedAt: null,
        completedAt: null,
      },
      tours: { seen: [], declined: [] },
      agentContext: { relayTools: true, meshTools: true, adapterTools: true, tasksTools: true },
      uploads: { maxFileSize: 10 * 1024 * 1024, maxFiles: 10, allowedTypes: ['*/*'] },
      agents: { defaultDirectory: '~/.dork/agents', defaultAgent: 'dorkbot' },
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
        opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
        codex: { enabled: true, binaryPath: null, credentialRef: null },
      },
      auth: { enabled: false },
      approvals: { standingGrants: false, trustWindowMinutes: 480, standingGrantsVoidBefore: null },
      cloud: { instanceToken: null, instanceName: null, linkedAccountLabel: null },
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

describe('ONBOARDING_STEPS', () => {
  it('includes meet-dorkbot', () => {
    expect(ONBOARDING_STEPS).toContain('meet-dorkbot');
  });

  it('has meet-dorkbot as the first step', () => {
    expect(ONBOARDING_STEPS[0]).toBe('meet-dorkbot');
  });

  it('contains all expected steps', () => {
    expect(ONBOARDING_STEPS).toEqual(['meet-dorkbot', 'discovery']);
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
      opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: null },
    });
  });

  it('defaults the section when an empty object is provided', () => {
    const result = UserConfigSchema.parse({ version: 1, runtimes: {} });
    expect(result.runtimes).toEqual({
      default: 'claude-code',
      opencode: { enabled: true, binaryPath: null, port: 0, provider: null, baseURL: null },
      codex: { enabled: true, binaryPath: null, credentialRef: null },
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

describe('normalizeSidebarPrefs — reading a config the migration has not touched', () => {
  const agent = (path: string) => ({ kind: 'agent' as const, path });

  /** A `ui.sidebar` in the pre-DOR-579 encoding, as it sits on disk. */
  function priorShape(): SidebarPrefs {
    return {
      ...SidebarPrefsSchema.parse({}),
      pinned: ['/projects/alpha'],
      muted: ['/projects/beta'],
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
      // The declared type says refs and `items`; a file written by an earlier
      // release says otherwise, which is the whole reason this function exists.
    } as unknown as SidebarPrefs;
  }

  it('toSidebarItemRef wraps a legacy path and passes a reference through', () => {
    expect(toSidebarItemRef('/projects/alpha')).toEqual(agent('/projects/alpha'));
    const ref = agent('/projects/alpha');
    expect(toSidebarItemRef(ref)).toBe(ref);
    const room = { kind: 'room' as const, roomId: '01JROOM' };
    expect(toSidebarItemRef(room)).toBe(room);
  });

  it('converts all three lists and renames agentPaths to items', () => {
    const prefs = normalizeSidebarPrefs(priorShape());
    expect(prefs.pinned).toEqual([agent('/projects/alpha')]);
    expect(prefs.muted).toEqual([agent('/projects/beta')]);
    expect(prefs.groups[0]!.items).toEqual([agent('/projects/alpha'), agent('/projects/gamma')]);
  });

  it('drops the retired agentPaths key rather than carrying it alongside items', () => {
    const prefs = normalizeSidebarPrefs(priorShape());
    expect('agentPaths' in prefs.groups[0]!).toBe(false);
  });

  it('keeps every other group field exactly as stored', () => {
    const prefs = normalizeSidebarPrefs(priorShape());
    expect(prefs.groups[0]).toEqual({
      id: 'g1',
      name: 'Clients',
      items: [agent('/projects/alpha'), agent('/projects/gamma')],
      sortMode: 'manual',
      collapsed: false,
      displayFilter: 'all',
      muted: false,
      kind: 'manual',
    });
  });

  it('returns the SAME object when the prefs are already canonical', () => {
    // Referential equality is load-bearing: the client selector memoizes on it,
    // and every consumer memoizes on `pinned` / `groups` identity.
    const canonical = {
      ...SidebarPrefsSchema.parse({}),
      pinned: [agent('/projects/alpha')],
      groups: [SidebarGroupSchema.parse({ id: 'g1', name: 'Clients' })],
    };
    expect(normalizeSidebarPrefs(canonical)).toBe(canonical);
  });

  it('leaves an already-canonical list untouched by reference', () => {
    const pinned = [agent('/projects/alpha')];
    const stored = {
      ...SidebarPrefsSchema.parse({}),
      pinned,
      muted: ['/projects/beta'],
    } as unknown as SidebarPrefs;
    const prefs = normalizeSidebarPrefs(stored);
    expect(prefs.pinned).toBe(pinned); // untouched
    expect(prefs.muted).toEqual([agent('/projects/beta')]); // converted
  });

  it('prefers an existing items list over a leftover agentPaths', () => {
    const stored = {
      ...SidebarPrefsSchema.parse({}),
      groups: [
        {
          ...SidebarGroupSchema.parse({ id: 'g1', name: 'Clients' }),
          items: [{ kind: 'room', roomId: '01JROOM' }],
          agentPaths: ['/projects/stale'],
        },
      ],
    } as unknown as SidebarPrefs;
    const prefs = normalizeSidebarPrefs(stored);
    expect(prefs.groups[0]!.items).toEqual([{ kind: 'room', roomId: '01JROOM' }]);
    expect('agentPaths' in prefs.groups[0]!).toBe(false);
  });

  it('gives a group with neither key an empty items list', () => {
    const stored = {
      ...SidebarPrefsSchema.parse({}),
      groups: [{ id: 'g1', name: 'Clients', sortMode: 'manual', kind: 'manual' }],
    } as unknown as SidebarPrefs;
    expect(normalizeSidebarPrefs(stored).groups[0]!.items).toEqual([]);
  });

  it('is idempotent — normalizing twice changes nothing further', () => {
    const once = normalizeSidebarPrefs(priorShape());
    expect(normalizeSidebarPrefs(once)).toBe(once);
  });
});

describe('UserConfigSchema ui.sidebar (DOR-329)', () => {
  const SIDEBAR_DEFAULTS = {
    pinned: [],
    groups: [],
    ungroupedSortMode: 'name',
    ungroupedCollapsed: false,
    recentsCollapsed: false,
    channelsCollapsed: false,
    dmsCollapsed: false,
    groupsHintDismissed: false,
    muted: [],
    ungroupedDisplayFilter: 'all',
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
      ungroupedSortMode: 'recent',
      ungroupedCollapsed: true,
      recentsCollapsed: true,
      channelsCollapsed: true,
      dmsCollapsed: true,
      groupsHintDismissed: true,
      muted: [{ kind: 'agent', path: '/b' }],
      ungroupedDisplayFilter: 'active',
    };
    const result = UserConfigSchema.parse({ version: 1, ui: { sidebar } });
    expect(result.ui.sidebar).toEqual(sidebar);
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

  it('SidebarPrefsSchema defaults muted to [] and ungroupedDisplayFilter to "all"', () => {
    const prefs = SidebarPrefsSchema.parse({});
    expect(prefs.muted).toEqual([]);
    expect(prefs.ungroupedDisplayFilter).toBe('all');
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
      ungroupedSortMode: 'name',
      ungroupedCollapsed: false,
      recentsCollapsed: false,
      groupsHintDismissed: false,
    };
    const result = UserConfigSchema.parse({ version: 1, ui: { sidebar: legacy } });
    expect(result.ui.sidebar.muted).toEqual([]);
    expect(result.ui.sidebar.ungroupedDisplayFilter).toBe('all');
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
