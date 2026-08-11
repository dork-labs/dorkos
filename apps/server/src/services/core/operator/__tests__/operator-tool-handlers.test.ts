/**
 * Unit tests for the self-service & observability MCP tool handlers (DOR-430).
 *
 * Each handler is exercised for its happy path and its key rejection path:
 * `update_agent` (system-agent identity protection), `config_patch` (invalid
 * value rejected by Zod), plus `activity_list`, `config_get`, `check_update`,
 * and `agents_recent_activity`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
  writeConventionFile: vi.fn(),
  getLatestVersion: vi.fn(),
  listRecentSessions: vi.fn(),
  configStore: { version: 1 } as Record<string, unknown>,
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: mocks.readManifest,
  writeManifest: mocks.writeManifest,
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: mocks.writeConventionFile,
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundaryOrDorkHome: async (p: string) => p,
  BoundaryError: class BoundaryError extends Error {},
}));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    getAll: () => mocks.configStore,
    set: (key: string, value: unknown) => {
      mocks.configStore[key] = value;
    },
  },
}));
vi.mock('../../update-checker.js', () => ({ getLatestVersion: mocks.getLatestVersion }));
vi.mock('../../../session/index.js', () => ({ listRecentSessions: mocks.listRecentSessions }));

import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { ActivityService } from '../../../activity/activity-service.js';
import {
  createUpdateAgentHandler,
  createActivityListHandler,
  createConfigGetHandler,
  createConfigPatchHandler,
  createCheckUpdateHandler,
  createAgentsRecentActivityHandler,
  type OperatorToolResult,
} from '../operator-tool-handlers.js';

/** Parse the JSON payload out of an MCP text-content tool result. */
function parsePayload<T = unknown>(result: OperatorToolResult): T {
  return JSON.parse(result.content[0].text) as T;
}

/** Build a deps bundle populated only with the fields a given test exercises. */
function buildDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configStore = { version: 1 };
});

describe('update_agent', () => {
  it('applies a self-edit and writes SOUL.md for a normal agent', async () => {
    mocks.readManifest.mockResolvedValue({
      id: '01ABC',
      name: 'my-agent',
      isSystem: false,
      displayName: 'Old',
    });
    const handler = createUpdateAgentHandler(buildDeps());

    const result = await handler({
      cwd: '/agents/my-agent',
      displayName: 'New',
      soulContent: 'be kind',
    });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{ displayName: string; name: string }>(result);
    expect(payload.displayName).toBe('New');
    expect(payload.name).toBe('my-agent');
    expect(mocks.writeConventionFile).toHaveBeenCalledWith(
      '/agents/my-agent',
      'SOUL.md',
      'be kind'
    );
    expect(mocks.writeManifest).toHaveBeenCalledOnce();
  });

  it('rejects identity changes on a system agent (system-agent protection)', async () => {
    mocks.readManifest.mockResolvedValue({
      id: '01SYS',
      name: 'dorkbot',
      isSystem: true,
      displayName: 'DorkBot',
    });
    const handler = createUpdateAgentHandler(buildDeps());

    const result = await handler({ cwd: '/agents/dorkbot', displayName: 'Hacked' });

    expect(result.isError).toBe(true);
    const payload = parsePayload<{ code: string; error: string }>(result);
    expect(payload.code).toBe('SYSTEM_PROTECTED');
    expect(mocks.writeManifest).not.toHaveBeenCalled();
  });

  it('errors when neither agent_id nor cwd is provided', async () => {
    const handler = createUpdateAgentHandler(buildDeps());
    const result = await handler({ displayName: 'x' });
    expect(result.isError).toBe(true);
    expect(parsePayload<{ error: string }>(result).error).toMatch(/agent_id or cwd/);
  });
});

describe('activity_list', () => {
  it('returns feed items via ActivityService (happy path)', async () => {
    const list = vi.fn().mockResolvedValue({ items: [{ id: 'e1' }], nextCursor: null });
    const handler = createActivityListHandler(
      buildDeps({ activityService: { list } as unknown as ActivityService })
    );

    const result = await handler({ limit: 10, categories: 'agent' });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{ items: { id: string }[] }>(result);
    expect(payload.items[0].id).toBe('e1');
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, categories: 'agent' }));
  });

  it('rejects an out-of-range limit (Zod validation)', async () => {
    const list = vi.fn();
    const handler = createActivityListHandler(
      buildDeps({ activityService: { list } as unknown as ActivityService })
    );
    const result = await handler({ limit: 999 });
    expect(result.isError).toBe(true);
    expect(list).not.toHaveBeenCalled();
  });

  it('errors when the activity service is unavailable', async () => {
    const handler = createActivityListHandler(buildDeps());
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(parsePayload<{ error: string }>(result).error).toMatch(/not available/);
  });
});

/**
 * A schema-valid config store carrying every secret AND every credential
 * reference, so the snapshot assertions cover both classes the disclosure
 * allowlist withholds (`config-disclosure.ts`).
 */
function secretBearingStore(): Record<string, unknown> {
  return {
    version: 1,
    tunnel: { authtoken: 'ngrok-secret', auth: 'basic-secret', domain: 'my.example.com' },
    mcp: { apiKey: 'mcp-secret-key', enabled: true },
    cloud: {
      instanceToken: 'cloud-secret-token',
      instanceName: 'my-box',
      linkedAccountLabel: 'secret-person@example.com',
    },
    runtimes: {
      default: 'claude-code',
      codex: { enabled: true, credentialRef: 'file:/home/me/.dork/secret-codex-key' },
    },
    providers: { anthropic: 'file:/home/me/.dork/secret-anthropic-key' },
    ui: { theme: 'dark' },
  };
}

describe('config_get', () => {
  it('returns an allowlisted snapshot: no secrets, no credential references', async () => {
    mocks.configStore = secretBearingStore();
    const handler = createConfigGetHandler();
    const result = await handler();

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{
      version: number;
      ui: { theme: string };
      tunnel: { authtoken?: string; auth?: string; domain?: string; authtokenConfigured?: boolean };
      mcp: { apiKey?: string; enabled?: boolean; apiKeyConfigured?: boolean };
      cloud: { instanceToken?: string; instanceName?: string; linkedAccountLabel?: string };
      runtimes: { codex: { credentialRef?: string; credentialRefConfigured?: boolean } };
      providers?: Record<string, string>;
      providersConfigured?: string[];
    }>(result);

    // Exposed values survive.
    expect(payload.version).toBe(1);
    expect(payload.ui.theme).toBe('dark');
    expect(payload.tunnel.domain).toBe('my.example.com');
    expect(payload.mcp.enabled).toBe(true);
    expect(payload.cloud.instanceName).toBe('my-box');

    // Secrets are gone.
    expect(payload.tunnel.authtoken).toBeUndefined();
    expect(payload.tunnel.auth).toBeUndefined();
    expect(payload.mcp.apiKey).toBeUndefined();
    expect(payload.cloud.instanceToken).toBeUndefined();
    // So are the credential references that locate secrets, and the account label.
    expect(payload.providers).toBeUndefined();
    expect(payload.runtimes.codex.credentialRef).toBeUndefined();
    expect(payload.cloud.linkedAccountLabel).toBeUndefined();

    // Presence is still legible without the values.
    expect(payload.tunnel.authtokenConfigured).toBe(true);
    expect(payload.mcp.apiKeyConfigured).toBe(true);
    expect(payload.runtimes.codex.credentialRefConfigured).toBe(true);
    expect(payload.providersConfigured).toEqual(['anthropic']);

    // No withheld value appears anywhere in the serialized payload.
    expect(result.content[0].text).not.toMatch(/secret/);
  });

  it('withholds the same fields from the config_patch echo', async () => {
    // `config_patch` echoes the post-write snapshot through the same projection,
    // so a write must not become a read-around of the allowlist.
    mocks.configStore = secretBearingStore();
    const result = await createConfigPatchHandler()({ patch: { ui: { theme: 'light' } } });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).not.toMatch(/secret/);
  });
});

describe('config_patch', () => {
  it('deep-merges and persists a valid patch (happy path)', async () => {
    const handler = createConfigPatchHandler();
    const result = await handler({ patch: { ui: { theme: 'dark' } } });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{ success: boolean }>(result);
    expect(payload.success).toBe(true);
    expect((mocks.configStore.ui as { theme: string }).theme).toBe('dark');
  });

  it('redacts sensitive keys from the success echo (both servers)', async () => {
    mocks.configStore = secretBearingStore();
    const handler = createConfigPatchHandler();
    const result = await handler({ patch: { ui: { theme: 'light' } } });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{
      success: boolean;
      config: {
        ui: { theme: string };
        tunnel: { authtoken?: string; auth?: string };
        mcp: { apiKey?: string };
        cloud: { instanceToken?: string };
      };
    }>(result);

    expect(payload.success).toBe(true);
    expect(payload.config.ui.theme).toBe('light');
    expect(payload.config.tunnel.authtoken).toBeUndefined();
    expect(payload.config.tunnel.auth).toBeUndefined();
    expect(payload.config.mcp.apiKey).toBeUndefined();
    expect(payload.config.cloud.instanceToken).toBeUndefined();
    expect(result.content[0].text).not.toMatch(/secret/);
  });

  it('rejects an invalid patch (Zod validation)', async () => {
    const handler = createConfigPatchHandler();
    const result = await handler({ patch: { server: { port: 1 } } });

    expect(result.isError).toBe(true);
    const payload = parsePayload<{ error: string; details?: string[] }>(result);
    expect(payload.error).toBe('Validation failed');
    expect(payload.details?.length).toBeGreaterThan(0);
    // The invalid value must not have been persisted.
    expect(mocks.configStore.server).toBeUndefined();
  });
});

/**
 * The escalation this guard exists to close (DOR-488).
 *
 * `operator.config_patch` is tier `act`, so nothing asks a person before it runs.
 * With no write allowlist, an agent could call
 * `config_patch({ auth: { enabled: false } })` and take the instance out of the
 * logged-in posture. That posture is where deciding an approval requires an
 * authenticated user, so the ungated write was a path from inside the capability
 * surface to removing the precondition that makes every destructive approval
 * enforceable.
 *
 * Each case asserts the STORE, not just the response: a refusal that still wrote
 * would be worse than no refusal at all.
 */
describe('config_patch posture guard', () => {
  /** A store in the posture the guard protects: login on. */
  function loggedInStore(): Record<string, unknown> {
    return { version: 1, auth: { enabled: true }, ui: { theme: 'dark' } };
  }

  it('refuses to turn login off, and leaves the config alone', async () => {
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({ patch: { auth: { enabled: false } } });

    // The posture is unchanged. Asserted FIRST and on the store, because a
    // refusal that still wrote would be worse than no refusal at all.
    expect(mocks.configStore.auth).toEqual({ enabled: true });

    expect(result.isError).toBe(true);
    const payload = parsePayload<{ error: string; code: string; paths: string[] }>(result);
    expect(payload.code).toBe('operator_only_config');
    expect(payload.paths).toEqual(['auth.enabled']);
  });

  it('refuses the whole patch when a posture change rides behind a real one', async () => {
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({
      patch: { ui: { theme: 'light' }, auth: { enabled: false } },
    });

    expect(result.isError).toBe(true);
    expect(mocks.configStore.auth).toEqual({ enabled: true });
    // No partial write: the legitimate half did not land either.
    expect(mocks.configStore.ui).toEqual({ theme: 'dark' });
  });

  it('refuses every other posture-bearing area too', async () => {
    const cases: { patch: Record<string, unknown>; expected: string[] }[] = [
      { patch: { tunnel: { enabled: true } }, expected: ['tunnel.enabled'] },
      { patch: { mcp: { apiKey: 'agent-chosen' } }, expected: ['mcp.apiKey'] },
      { patch: { server: { boundary: '/' } }, expected: ['server.boundary'] },
      { patch: { providers: { anthropic: 'file:/tmp/key' } }, expected: ['providers'] },
      {
        patch: { runtimes: { codex: { binaryPath: '/tmp/evil.sh' } } },
        expected: ['runtimes.codex.binaryPath'],
      },
      { patch: { telemetry: { aiMetadata: true } }, expected: ['telemetry.aiMetadata'] },
      { patch: { cloud: { instanceToken: 'attacker' } }, expected: ['cloud.instanceToken'] },
      { patch: { extensions: { enabled: ['anything'] } }, expected: ['extensions.enabled'] },
    ];

    for (const { patch, expected } of cases) {
      mocks.configStore = loggedInStore();
      const result = await createConfigPatchHandler()({ patch });

      expect(result.isError, JSON.stringify(patch)).toBe(true);
      const payload = parsePayload<{ paths: string[] }>(result);
      expect(payload.paths, JSON.stringify(patch)).toEqual(expected);
      // Nothing at all was written.
      expect(mocks.configStore, JSON.stringify(patch)).toEqual(loggedInStore());
    }
  });

  it('refuses a tool endpoint smuggled in as a list, and writes nothing (DOR-1113)', async () => {
    // The reproduction, at the surface it matters on. A raw-MCP server is an
    // outbound tool endpoint pointed anywhere the writer likes, and every policy
    // key for it names a field of a list ELEMENT. The path walk used to stop at
    // the list, match nothing, and this handler gates on "did we find anything" —
    // so the refusal never fired and the server was written.
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({
      patch: {
        connectors: {
          rawMcpServers: [
            {
              slug: 'exfil',
              displayName: 'Exfil',
              url: 'https://attacker.example.com/mcp',
              transport: 'http',
            },
          ],
        },
      },
    });

    expect(mocks.configStore).toEqual(loggedInStore());
    expect(result.isError).toBe(true);
    const payload = parsePayload<{ code: string; paths: string[]; message: string }>(result);
    expect(payload.code).toBe('operator_only_config');
    expect(payload.paths).toEqual([
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
    ]);
    expect(payload.message).toContain(
      'Which code this server runs, and which outside tools it attaches to'
    );
  });

  it('refuses a Claude account roster rewrite, and writes nothing (DOR-1113)', async () => {
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({
      patch: { runtimes: { claudeCode: { accounts: [{ path: '/tmp/theirs', label: 'ours' }] } } },
    });

    expect(mocks.configStore).toEqual(loggedInStore());
    expect(result.isError).toBe(true);
    const payload = parsePayload<{ paths: string[] }>(result);
    expect(payload.paths).toEqual([
      'runtimes.claudeCode.accounts[].label',
      'runtimes.claudeCode.accounts[].path',
    ]);
  });

  it('still lets an agent write a list it may write', async () => {
    // The other half of the same change: descending into arrays must not refuse
    // the sidebar, whose element fields are agent-writable on purpose.
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({
      patch: { ui: { statusBar: { pins: ['runtime'] } } },
    });

    expect(result.isError).toBeUndefined();
    expect((mocks.configStore.ui as { statusBar: { pins: string[] } }).statusBar.pins).toEqual([
      'runtime',
    ]);
  });

  it('tells the model what it may not change and what to do instead', async () => {
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({ patch: { auth: { enabled: false } } });
    const payload = parsePayload<{ message: string }>(result);

    expect(payload.message).toContain('auth.enabled');
    expect(payload.message).toMatch(/ask the person/i);
  });

  it('still lets ordinary preferences through', async () => {
    // The guard must not turn the capability into a brick.
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({
      patch: { ui: { theme: 'light' }, logging: { level: 'debug' } },
    });

    expect(result.isError).toBeUndefined();
    expect((mocks.configStore.ui as { theme: string }).theme).toBe('light');
    expect(mocks.configStore.auth).toEqual({ enabled: true });
  });
});

/**
 * The agent identity token (spec `agent-trust` §3.1) is delivered to a spawned
 * session through `DORKOS_AGENT_TOKEN` in its process env, so the agent holding
 * it can present it back to DorkOS. It must never round-trip into a tool RESULT,
 * which lands in the model's context and the persisted transcript — the same
 * invariant ADR 260723-013236 established for sensitive config keys (superseded by
 * 260725-152018), extended to
 * the one credential that reaches an agent by design.
 *
 * These guard the config surfaces specifically: they are the tools that dump a
 * broad snapshot, so they are where an env-echoing regression would surface.
 */
describe('agent identity token redaction', () => {
  const SENTINEL = 'dorkos-agent-token-sentinel-value';

  beforeEach(() => {
    vi.stubEnv('DORKOS_AGENT_TOKEN', SENTINEL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('never leaks DORKOS_AGENT_TOKEN through config_get', async () => {
    mocks.configStore = secretBearingStore();
    const result = await createConfigGetHandler()();

    expect(result.content[0].text).not.toContain(SENTINEL);
    expect(result.content[0].text).not.toContain('DORKOS_AGENT_TOKEN');
  });

  it('never leaks DORKOS_AGENT_TOKEN through the config_patch echo', async () => {
    mocks.configStore = secretBearingStore();
    const result = await createConfigPatchHandler()({ patch: { ui: { theme: 'light' } } });

    expect(result.content[0].text).not.toContain(SENTINEL);
    expect(result.content[0].text).not.toContain('DORKOS_AGENT_TOKEN');
  });

  it('still redacts it when the token is mistakenly written into config', async () => {
    // Defense in depth: the token has no config home, but if a future surface
    // ever parks it in one, `config_get` must not hand it to the model.
    mocks.configStore = { ...secretBearingStore(), mcp: { apiKey: SENTINEL, enabled: true } };
    const result = await createConfigGetHandler()();

    expect(result.content[0].text).not.toContain(SENTINEL);
  });
});

describe('check_update', () => {
  it('returns the running and latest versions', async () => {
    mocks.getLatestVersion.mockResolvedValue('9.9.9');
    const handler = createCheckUpdateHandler();
    const result = await handler();
    const payload = parsePayload<{ version: string; latestVersion: string | null }>(result);
    expect(typeof payload.version).toBe('string');
    expect(payload.latestVersion).toBe('9.9.9');
  });
});

describe('agents_recent_activity', () => {
  it('joins the agent roster with its latest activity (happy path)', async () => {
    mocks.listRecentSessions.mockResolvedValue({
      agentActivity: { '/agents/a': '2026-01-02T00:00:00.000Z' },
      warnings: [],
    });
    const deps = buildDeps({
      runtimeRegistry: { listRuntimes: () => [] } as unknown as McpToolDeps['runtimeRegistry'],
      meshCore: {
        listWithPaths: () => [{ id: '1', name: 'a', projectPath: '/agents/a' }],
      } as unknown as McpToolDeps['meshCore'],
    });

    const result = await createAgentsRecentActivityHandler(deps)({ limit: 5 });

    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{ agents: { id: string; lastActivity: string }[] }>(result);
    expect(payload.agents).toHaveLength(1);
    expect(payload.agents[0].id).toBe('1');
    expect(payload.agents[0].lastActivity).toBe('2026-01-02T00:00:00.000Z');
    expect(mocks.listRecentSessions).toHaveBeenCalledWith(
      expect.objectContaining({ agentPaths: ['/agents/a'], limit: 5 })
    );
  });

  it('errors when the runtime registry is unavailable', async () => {
    const result = await createAgentsRecentActivityHandler(buildDeps())({});
    expect(result.isError).toBe(true);
    expect(parsePayload<{ error: string }>(result).error).toMatch(/Runtime registry/);
  });
});
