/**
 * The self-service & observability MCP tool handlers (DOR-430): the happy paths
 * and the refusals an agent must not get past.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
  writeConventionFile: vi.fn(),
  writeConventionFileIfAbsent: vi.fn(async () => true),
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
    // Read by the display-name provenance stamp, which asks for the ONE section
    // it is about rather than the whole config (DOR-1022).
    get: (key: string) => mocks.configStore[key],
    set: (key: string, value: unknown) => {
      mocks.configStore[key] = value;
    },
  },
}));
vi.mock('../../update-checker.js', () => ({ getLatestVersion: mocks.getLatestVersion }));
vi.mock('../../../session/index.js', () => ({ listRecentSessions: mocks.listRecentSessions }));

import type { AgentToolDeps } from '../../agent-tool-kit/agent-tool-kit.js';
import {
  createUpdateAgentHandler,
  createConfigGetHandler,
  createConfigPatchHandler,
  createAgentsRecentActivityHandler,
  type OperatorToolResult,
} from '../operator-tool-handlers.js';
import { operatorDomain } from '../operator-capabilities.js';
import { logger } from '../../../../lib/logger.js';

/** Parse the JSON payload out of an MCP text-content tool result. */
function parsePayload<T = unknown>(result: OperatorToolResult): T {
  return JSON.parse(result.content[0].text) as T;
}

/** Build a deps bundle populated only with the fields a given test exercises. */
function buildDeps(overrides: Partial<AgentToolDeps> = {}): AgentToolDeps {
  return {
    transcriptReader: {} as AgentToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
    dorkHome: '/tmp/dorkos-test-home',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configStore = { version: 1 };
});

describe('update_agent', () => {
  // An agent rewriting its persona sends prose and no markers, so the file has
  // to be composed around the personality block or its trait dials stop working.
  it('applies a self-edit and writes SOUL.md with its trait markers intact', async () => {
    mocks.readManifest.mockResolvedValue({ id: '01ABC', name: 'my-agent', isSystem: false });
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
    const [, file, written] = mocks.writeConventionFile.mock.calls[0] as [string, string, string];
    expect(file).toBe('SOUL.md');
    expect(written).toContain('<!-- TRAITS:START -->');
    expect(written).toContain('<!-- TRAITS:END -->');
    expect(written.endsWith('be kind')).toBe(true);
  });

  it('rejects identity changes on a system agent (system-agent protection)', async () => {
    mocks.readManifest.mockResolvedValue({ id: '01SYS', name: 'dorkbot', isSystem: true });
    const handler = createUpdateAgentHandler(buildDeps());

    const result = await handler({ cwd: '/agents/dorkbot', displayName: 'Hacked' });

    expect(result.isError).toBe(true);
    const payload = parsePayload<{ code: string; error: string }>(result);
    expect(payload.code).toBe('SYSTEM_PROTECTED');
    expect(mocks.writeManifest).not.toHaveBeenCalled();
  });

  it("refuses to repoint an agent's billing (spec billing-account-ladder invariant 4)", async () => {
    // An agent that could set `account` could move its work onto a different
    // paying client's subscription.
    mocks.readManifest.mockResolvedValue({ id: '01ABC', name: 'my-agent', isSystem: false });
    const handler = createUpdateAgentHandler(buildDeps());

    const result = await handler({
      cwd: '/agents/my-agent',
      account: 'acme-corp',
    } as Parameters<typeof handler>[0] & { account: string });

    expect(result.isError).toBe(true);
    expect(parsePayload<{ code: string }>(result).code).toBe('OPERATOR_ONLY');
    expect(mocks.writeManifest).not.toHaveBeenCalled();
  });
});

/** A schema-valid config store carrying every secret AND credential reference. */
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
  // `config_patch` echoes through the same projection (pinned below).
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
});

describe('raw MCP URL disclosure through operator tools', () => {
  it.each([
    'https://private-user:private-password@mcp.example.com/endpoint',
    'https://mcp.example.com/endpoint?access_token=private-query-token',
  ])('withholds %s from config_get and the unrelated config_patch echo', async (url) => {
    const server = { slug: 'notes', displayName: 'Notes', url, transport: 'http' };
    mocks.configStore = { version: 1, connectors: { rawMcpServers: [server] } };
    const read = await createConfigGetHandler()();
    const write = await createConfigPatchHandler()({ patch: { ui: { theme: 'light' } } });
    expect(read.isError).toBeUndefined();
    expect(write.isError).toBeUndefined();
    const expected = {
      rawMcpServers: [{ slug: 'notes', displayName: 'Notes', transport: 'http' }],
    };
    expect(parsePayload<{ connectors: unknown }>(read).connectors).toEqual(expected);
    expect(parsePayload<{ config: { connectors: unknown } }>(write).config.connectors).toEqual(
      expected
    );
    for (const result of [read, write]) {
      expect(result.content[0].text).not.toContain(url);
      expect(result.content[0].text).not.toContain('private-');
      expect(result.content[0].text).not.toContain('mcp.example.com');
    }
    // An unrelated write must preserve the original endpoint on disk, not sanitize it in place.
    expect(mocks.configStore.connectors).toEqual({ rawMcpServers: [server] });
    expect(mocks.configStore.ui).toMatchObject({ theme: 'light' });
  });
});

describe('config_patch', () => {
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

  it('stamps the display name with the calling agent, through the capability (DOR-1022)', async () => {
    // Drives the capability's own `invoke`, the seam that forwards
    // `context.identity`. A real `ConfigManager.get` always has a `profile`.
    mocks.configStore.profile = {
      roles: [],
      tools: [],
      displayName: null,
      displayNameSource: null,
      rolePromptDismissedAt: null,
    };
    const capability = operatorDomain.capabilities.find((c) => c.id === 'operator.config_patch');
    if (!capability) throw new Error('operator.config_patch is not registered');

    await capability.invoke(
      { logger, operatorDeps: buildDeps() },
      { patch: { profile: { displayName: 'Dorian' } } },
      {
        identity: {
          agentPath: '/Users/dorian/.dork/agents/dorkbot',
          displayName: 'DorkBot',
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      }
    );

    expect((mocks.configStore.profile as Record<string, unknown>).displayNameSource).toEqual({
      kind: 'agent',
      agentName: 'DorkBot',
    });
  });
});

/**
 * The escalation this guard closes (DOR-488): `config_patch` is tier `act`, so
 * an agent could turn login off and remove the precondition that makes every
 * destructive approval enforceable. Each case asserts the STORE.
 */
describe('config_patch posture guard', () => {
  /** A store in the posture the guard protects: login on. */
  function loggedInStore(): Record<string, unknown> {
    return { version: 1, auth: { enabled: true }, ui: { theme: 'dark' } };
  }

  it('refuses to turn login off, and leaves the config alone', async () => {
    mocks.configStore = loggedInStore();
    const result = await createConfigPatchHandler()({ patch: { auth: { enabled: false } } });

    expect(mocks.configStore.auth).toEqual({ enabled: true });
    expect(result.isError).toBe(true);
    const payload = parsePayload<{ code: string; paths: string[]; message: string }>(result);
    expect(payload.code).toBe('operator_only_config');
    expect(payload.paths).toEqual(['auth.enabled']);
    // It tells the model what to do instead.
    expect(payload.message).toMatch(/ask the person/i);
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

  // Each operator-only path is pinned in `config-write-policy.test.ts`.
  it('refuses a tool endpoint smuggled in as a list, and writes nothing (DOR-1113)', async () => {
    // Every policy key for a raw-MCP server names a field of a list ELEMENT; the
    // path walk used to stop at the list, so the refusal never fired.
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
 * The agent identity token (spec `agent-trust` §3.1) reaches a session through
 * `DORKOS_AGENT_TOKEN` and must never round-trip into a tool RESULT, which lands
 * in the model's context and the transcript.
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
});

describe('agents_recent_activity', () => {
  it('joins the agent roster with its latest activity (happy path)', async () => {
    mocks.listRecentSessions.mockResolvedValue({
      agentActivity: { '/agents/a': '2026-01-02T00:00:00.000Z' },
      warnings: [],
    });
    const deps = buildDeps({
      runtimeRegistry: { listRuntimes: () => [] } as unknown as AgentToolDeps['runtimeRegistry'],
      meshCore: {
        listWithPaths: () => [{ id: '1', name: 'a', projectPath: '/agents/a' }],
      } as unknown as AgentToolDeps['meshCore'],
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
});
