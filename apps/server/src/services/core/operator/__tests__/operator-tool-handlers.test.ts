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
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('config_get', () => {
  it('returns the full config snapshot', async () => {
    mocks.configStore = { version: 1, ui: { theme: 'dark' } };
    const handler = createConfigGetHandler();
    const result = await handler();
    expect(result.isError).toBeUndefined();
    const payload = parsePayload<{ version: number; ui: { theme: string } }>(result);
    expect(payload.version).toBe(1);
    expect(payload.ui.theme).toBe('dark');
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
