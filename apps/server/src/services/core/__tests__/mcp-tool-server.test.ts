import { describe, it, expect, vi } from 'vitest';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/index.js';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createGetAgentHandler,
  createDorkOsToolServer,
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
  createRelayDispatchHandler,
  createRelayUnregisterEndpointHandler,
} from '../../runtimes/claude-code/mcp-tools/index.js';

vi.mock('../../../lib/version.js', () => ({
  SERVER_VERSION: '1.0.0',
  IS_DEV_BUILD: false,
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

// Mocks required by agent-creator.ts (transitively imported via agent-tools)
vi.mock('@dorkos/shared/convention-files', () => ({
  defaultSoulTemplate: vi.fn(() => '# SOUL'),
  defaultNopeTemplate: vi.fn(() => '# NOPE'),
  buildSoulContent: vi.fn(() => '# SOUL'),
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: vi.fn(),
  readConventionFile: vi.fn(),
}));
vi.mock('@dorkos/shared/trait-renderer', () => ({
  renderTraits: vi.fn(() => ''),
  DEFAULT_TRAITS: { tone: 3, autonomy: 3, caution: 3, communication: 3, creativity: 3 },
}));
vi.mock('@dorkos/shared/dorkbot-templates', () => ({
  dorkbotClaudeMdTemplate: vi.fn(() => '# DorkBot'),
}));
vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(),
  BoundaryError: class BoundaryError extends Error {
    code = 'BOUNDARY_VIOLATION';
  },
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({ defaultDirectory: '/tmp/agents' })),
  },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: vi.fn((config: Record<string, unknown>) => config),
  tool: vi.fn(
    (
      name: string,
      desc: string,
      schema: Record<string, unknown>,
      handler: (...args: unknown[]) => unknown
    ) => ({
      name,
      description: desc,
      schema,
      handler,
    })
  ),
}));

/** Passthrough shape returned by mocked createSdkMcpServer */
interface MockServer {
  name: string;
  version: string;
  tools: { name: string; description: string }[];
}

/** Create a mock McpToolDeps with a stubbed transcript reader */
function makeMockDeps(overrides: { listSessions?: ReturnType<typeof vi.fn> } = {}): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: overrides.listSessions ?? vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/test/cwd',
  };
}

/** Create a mock PulseStore with sensible defaults */
function makeMockPulseStore(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    getSchedules: vi.fn().mockReturnValue([]),
    getSchedule: vi.fn().mockReturnValue(null),
    createSchedule: vi.fn().mockReturnValue({ id: 'new-1', name: 'Test' }),
    updateSchedule: vi.fn().mockReturnValue(null),
    deleteSchedule: vi.fn().mockReturnValue(false),
    listRuns: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as McpToolDeps['pulseStore'];
}

/** Create mock deps with Pulse enabled */
function makePulseDeps(
  storeOverrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
): McpToolDeps {
  return {
    ...makeMockDeps(),
    pulseStore: makeMockPulseStore(storeOverrides),
  };
}

describe('MCP Tool Handlers', () => {
  describe('handlePing', () => {
    it('returns pong status with timestamp', async () => {
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('pong');
      expect(parsed.server).toBe('dorkos');
      expect(parsed.timestamp).toBeDefined();
    });

    it('returns valid ISO timestamp', async () => {
      const result = await handlePing();
      const parsed = JSON.parse(result.content[0].text);
      expect(() => new Date(parsed.timestamp)).not.toThrow();
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });

    it('returns single content block with type text', async () => {
      const result = await handlePing();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
    });
  });

  describe('handleGetServerInfo', () => {
    it('returns server info without uptime by default', async () => {
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.product).toBe('DorkOS');
      expect(parsed.port).toBeDefined();
      expect(parsed.uptime_seconds).toBeUndefined();
    });

    it('includes uptime when requested', async () => {
      const result = await handleGetServerInfo({ include_uptime: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.uptime_seconds).toBeTypeOf('number');
      expect(parsed.uptime_seconds).toBeGreaterThanOrEqual(0);
    });

    it('uses DORKOS_PORT env var when set', async () => {
      vi.stubEnv('DORKOS_PORT', '9999');
      vi.resetModules();
      const { handleGetServerInfo: handler } =
        await import('../../runtimes/claude-code/mcp-tools/core-tools.js');
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.port).toBe(9999);
      vi.unstubAllEnvs();
    });

    it('uses SERVER_VERSION from version module', async () => {
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.version).toBe('1.0.0');
    });

    it('defaults port to 4242 when env var unset', async () => {
      vi.stubEnv('DORKOS_PORT', undefined as unknown as string);
      vi.resetModules();
      const { handleGetServerInfo: handler } =
        await import('../../runtimes/claude-code/mcp-tools/core-tools.js');
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.port).toBe(4242);
      vi.unstubAllEnvs();
    });

    it('includes version from SERVER_VERSION constant', async () => {
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.version).toBe('1.0.0');
    });
  });

  describe('createGetSessionCountHandler', () => {
    it('returns session count from transcript reader when cwd provided', async () => {
      const listSessions = vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler({ cwd: '/test/cwd' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(3);
      expect(parsed.cwd).toBe('/test/cwd');
      expect(listSessions).toHaveBeenCalledWith('/test/cwd');
    });

    it('returns isError when transcript reader fails', async () => {
      const listSessions = vi.fn().mockRejectedValue(new Error('ENOENT'));
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler({ cwd: '/test/cwd' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('ENOENT');
    });

    it('returns zero for empty session directory', async () => {
      const handler = createGetSessionCountHandler(makeMockDeps());
      const result = await handler({ cwd: '/test/cwd' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
    });

    it('handles non-Error exceptions gracefully', async () => {
      const listSessions = vi.fn().mockRejectedValue('string error');
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler({ cwd: '/test/cwd' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Failed to list sessions');
    });

    it('returns isError when neither agent_id nor cwd provided', async () => {
      const handler = createGetSessionCountHandler(makeMockDeps());
      const result = await handler({});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Either agent_id or cwd must be provided');
    });

    it('returns isError when both agent_id and cwd provided', async () => {
      const handler = createGetSessionCountHandler(makeMockDeps());
      const result = await handler({ agent_id: 'abc', cwd: '/test' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not both');
    });

    it('includes agent_id in response when resolved via agent_id', async () => {
      const listSessions = vi.fn().mockResolvedValue([{ id: 's1' }]);
      const meshCore = { getProjectPath: vi.fn().mockReturnValue('/resolved/path') };
      const deps = { ...makeMockDeps({ listSessions }), meshCore } as McpToolDeps;
      const handler = createGetSessionCountHandler(deps);
      const result = await handler({ agent_id: 'agent-123' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(1);
      expect(parsed.cwd).toBe('/resolved/path');
      expect(parsed.agent_id).toBe('agent-123');
    });
  });

  describe('createListSchedulesHandler', () => {
    it('returns all schedules when Pulse enabled', async () => {
      const schedules = [
        { id: 's1', name: 'Daily', enabled: true },
        { id: 's2', name: 'Weekly', enabled: false },
      ];
      const handler = createListSchedulesHandler(
        makePulseDeps({ getSchedules: vi.fn().mockReturnValue(schedules) })
      );
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedules).toEqual(schedules);
      expect(parsed.count).toBe(2);
    });

    it('filters to enabled_only when flag set', async () => {
      const schedules = [
        { id: 's1', name: 'Daily', enabled: true },
        { id: 's2', name: 'Weekly', enabled: false },
      ];
      const handler = createListSchedulesHandler(
        makePulseDeps({ getSchedules: vi.fn().mockReturnValue(schedules) })
      );
      const result = await handler({ enabled_only: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedules).toHaveLength(1);
      expect(parsed.schedules[0].id).toBe('s1');
    });

    it('returns error when pulseStore undefined', async () => {
      const handler = createListSchedulesHandler(makeMockDeps());
      const result = await handler({});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not enabled');
    });

    it('handles empty schedule list', async () => {
      const handler = createListSchedulesHandler(makePulseDeps());
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedules).toEqual([]);
      expect(parsed.count).toBe(0);
    });
  });

  describe('createCreateScheduleHandler', () => {
    it('creates schedule and sets pending_approval status', async () => {
      const created = { id: 'new-1', name: 'Nightly' };
      const updated = { ...created, status: 'pending_approval' };
      const handler = createCreateScheduleHandler(
        makePulseDeps({
          createSchedule: vi.fn().mockReturnValue(created),
          updateSchedule: vi.fn().mockReturnValue(updated),
          getSchedule: vi.fn().mockReturnValue(updated),
        })
      );
      const result = await handler({
        name: 'Nightly',
        prompt: 'Run tests',
        cron: '0 2 * * *',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedule.status).toBe('pending_approval');
      expect(parsed.note).toContain('pending_approval');
    });

    it('returns created schedule with approval note', async () => {
      const handler = createCreateScheduleHandler(
        makePulseDeps({
          createSchedule: vi.fn().mockReturnValue({ id: 'x' }),
          updateSchedule: vi.fn(),
          getSchedule: vi.fn().mockReturnValue({ id: 'x', status: 'pending_approval' }),
        })
      );
      const result = await handler({ name: 'Test', prompt: 'Do stuff', cron: '* * * * *' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.note).toContain('approve');
      expect(result.isError).toBeUndefined();
    });

    it('returns error when Pulse disabled', async () => {
      const handler = createCreateScheduleHandler(makeMockDeps());
      const result = await handler({ name: 'X', prompt: 'Y', cron: '* * * * *' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not enabled');
    });
  });

  describe('createUpdateScheduleHandler', () => {
    it('updates existing schedule', async () => {
      const updated = { id: 'u1', name: 'Updated Name' };
      const handler = createUpdateScheduleHandler(
        makePulseDeps({ updateSchedule: vi.fn().mockReturnValue(updated) })
      );
      const result = await handler({ id: 'u1', name: 'Updated Name' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedule).toEqual(updated);
      expect(result.isError).toBeUndefined();
    });

    it('returns error for non-existent ID', async () => {
      const handler = createUpdateScheduleHandler(
        makePulseDeps({ updateSchedule: vi.fn().mockReturnValue(null) })
      );
      const result = await handler({ id: 'missing' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('missing');
      expect(parsed.error).toContain('not found');
    });

    it('handles permissionMode string conversion', async () => {
      const store = makeMockPulseStore({
        updateSchedule: vi.fn().mockReturnValue({ id: 'u1', permissionMode: 'plan' }),
      });
      const deps = { ...makeMockDeps(), pulseStore: store };
      const handler = createUpdateScheduleHandler(deps);
      await handler({ id: 'u1', permissionMode: 'plan' });
      expect(store!.updateSchedule).toHaveBeenCalledWith('u1', { permissionMode: 'plan' });
    });

    it('returns error when Pulse disabled', async () => {
      const handler = createUpdateScheduleHandler(makeMockDeps());
      const result = await handler({ id: 'x' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not enabled');
    });
  });

  describe('createDeleteScheduleHandler', () => {
    it('deletes existing schedule and returns success', async () => {
      const handler = createDeleteScheduleHandler(
        makePulseDeps({ deleteSchedule: vi.fn().mockReturnValue(true) })
      );
      const result = await handler({ id: 'del-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
      expect(parsed.id).toBe('del-1');
      expect(result.isError).toBeUndefined();
    });

    it('returns error for non-existent ID', async () => {
      const handler = createDeleteScheduleHandler(
        makePulseDeps({ deleteSchedule: vi.fn().mockReturnValue(false) })
      );
      const result = await handler({ id: 'ghost' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('ghost');
      expect(parsed.error).toContain('not found');
    });

    it('returns error when Pulse disabled', async () => {
      const handler = createDeleteScheduleHandler(makeMockDeps());
      const result = await handler({ id: 'x' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not enabled');
    });
  });

  describe('createGetRunHistoryHandler', () => {
    it('returns runs with default limit', async () => {
      const runs = [{ id: 'r1' }, { id: 'r2' }];
      const listRuns = vi.fn().mockReturnValue(runs);
      const handler = createGetRunHistoryHandler(makePulseDeps({ listRuns }));
      const result = await handler({ schedule_id: 'sched-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.runs).toEqual(runs);
      expect(parsed.count).toBe(2);
      expect(listRuns).toHaveBeenCalledWith({ scheduleId: 'sched-1', limit: 20 });
    });

    it('respects custom limit parameter', async () => {
      const listRuns = vi.fn().mockReturnValue([]);
      const handler = createGetRunHistoryHandler(makePulseDeps({ listRuns }));
      await handler({ schedule_id: 'sched-1', limit: 5 });
      expect(listRuns).toHaveBeenCalledWith({ scheduleId: 'sched-1', limit: 5 });
    });

    it('returns error when Pulse disabled', async () => {
      const handler = createGetRunHistoryHandler(makeMockDeps());
      const result = await handler({ schedule_id: 'x' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('not enabled');
    });
  });

  describe('createGetAgentHandler', () => {
    it('returns null with message when no manifest exists', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      vi.mocked(readManifest).mockResolvedValue(null);
      const handler = createGetAgentHandler(makeMockDeps());
      const result = await handler({ cwd: '/test/cwd' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.agent).toBeNull();
      expect(parsed.message).toContain('No agent registered');
    });

    it('returns full manifest when agent exists', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      const mockManifest = {
        id: 'test-agent-id',
        name: 'Test Agent',
        description: 'A test agent',
        runtime: 'claude-code',
        capabilities: ['testing'],
      };
      vi.mocked(readManifest).mockResolvedValue(mockManifest as never);
      const handler = createGetAgentHandler(makeMockDeps());
      const result = await handler({ cwd: '/test/cwd' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.agent).toEqual(mockManifest);
      expect(parsed.agent.id).toBe('test-agent-id');
      expect(parsed.agent.name).toBe('Test Agent');
    });

    it('uses provided cwd as the working directory', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      vi.mocked(readManifest).mockResolvedValue(null);
      const handler = createGetAgentHandler(makeMockDeps());
      await handler({ cwd: '/test/cwd' });
      expect(readManifest).toHaveBeenCalledWith('/test/cwd');
    });

    it('resolves agent_id via meshCore.getProjectPath', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      vi.mocked(readManifest).mockResolvedValue(null);
      const meshCore = { getProjectPath: vi.fn().mockReturnValue('/resolved/agent/path') };
      const deps = { ...makeMockDeps(), meshCore } as McpToolDeps;
      const handler = createGetAgentHandler(deps);
      await handler({ agent_id: 'agent-ulid' });
      expect(readManifest).toHaveBeenCalledWith('/resolved/agent/path');
    });

    it('returns isError when readManifest throws', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      vi.mocked(readManifest).mockRejectedValue(new Error('Permission denied'));
      const handler = createGetAgentHandler(makeMockDeps());
      const result = await handler({ cwd: '/test/cwd' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Permission denied');
    });

    it('handles non-Error exceptions gracefully', async () => {
      const { readManifest } = await import('@dorkos/shared/manifest');
      vi.mocked(readManifest).mockRejectedValue('string error');
      const handler = createGetAgentHandler(makeMockDeps());
      const result = await handler({ cwd: '/test/cwd' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Failed to read agent manifest');
    });

    it('returns isError when neither agent_id nor cwd provided', async () => {
      const handler = createGetAgentHandler(makeMockDeps());
      const result = await handler({});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('Either agent_id or cwd must be provided');
    });
  });

  describe('createDorkOsToolServer', () => {
    it('creates server with name dorkos and version 1.0.0', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      expect(server).toBeDefined();
      expect(server.name).toBe('dorkos');
      expect(server.version).toBe('1.0.0');
    });

    it('registers 20 tools (4 core + 5 pulse + 8 relay + 1 agent + 2 ui)', () => {
      // Purpose: regression guard against accidental tool omissions or additions.
      // This count changes intentionally when new MCP tools are added.
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      expect(server.tools).toHaveLength(20);
    });

    it('registers tools with correct names', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      const toolNames = server.tools.map((t) => t.name);
      expect(toolNames).toContain('ping');
      expect(toolNames).toContain('get_server_info');
      expect(toolNames).toContain('get_session_count');
      expect(toolNames).toContain('get_agent');
      expect(toolNames).toContain('pulse_list_schedules');
      expect(toolNames).toContain('pulse_create_schedule');
      expect(toolNames).toContain('pulse_update_schedule');
      expect(toolNames).toContain('pulse_delete_schedule');
      expect(toolNames).toContain('pulse_get_run_history');
      expect(toolNames).toContain('relay_send');
      expect(toolNames).toContain('relay_inbox');
      expect(toolNames).toContain('relay_list_endpoints');
      expect(toolNames).toContain('relay_register_endpoint');
      expect(toolNames).toContain('relay_send_and_wait');
      expect(toolNames).toContain('relay_send_async');
      expect(toolNames).toContain('relay_unregister_endpoint');
      expect(toolNames).toContain('relay_notify_user');
      expect(toolNames).toContain('control_ui');
      expect(toolNames).toContain('get_ui_state');
    });
  });
});

/** Create a mock RelayCore with configurable return values */
function makeRelayCoreMock(
  overrides: {
    deliveredTo?: number;
    messageId?: string;
    rejected?: Array<{ subject: string; reason: string }>;
    unregisterResult?: boolean;
  } = {}
) {
  return {
    registerEndpoint: vi.fn().mockResolvedValue({ subject: 'relay.inbox.dispatch.test' }),
    unregisterEndpoint: vi.fn().mockResolvedValue(overrides.unregisterResult ?? true),
    publish: vi.fn().mockResolvedValue({
      messageId: overrides.messageId ?? 'msg-1',
      deliveredTo: overrides.deliveredTo ?? 1,
      rejected: overrides.rejected ?? [],
    }),
  };
}

describe('createRelayDispatchHandler', () => {
  it('returns error when relay disabled', async () => {
    // Purpose: verifies requireRelay guard applies to relay_send_async.
    const handler = createRelayDispatchHandler(makeMockDeps());
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('RELAY_DISABLED');
  });

  it('returns messageId and inboxSubject on success', async () => {
    // Purpose: verifies the non-blocking return contract.
    const relayCore = makeRelayCoreMock({ deliveredTo: 1, messageId: 'msg-1' });
    const handler = createRelayDispatchHandler({ ...makeMockDeps(), relayCore } as McpToolDeps);
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.inboxSubject).toMatch(/^relay\.inbox\.dispatch\./);
    expect(result.isError).toBeUndefined();
  });

  it('auto-unregisters inbox on early rejection', async () => {
    // Purpose: prevents inbox leaks when message is immediately rejected.
    const relayCore = makeRelayCoreMock({
      deliveredTo: 0,
      rejected: [{ subject: 'relay.agent.x', reason: 'rate limit' }],
    });
    const handler = createRelayDispatchHandler({ ...makeMockDeps(), relayCore } as McpToolDeps);
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    expect(result.isError).toBe(true);
    expect(relayCore.unregisterEndpoint).toHaveBeenCalledOnce();
    expect(JSON.parse(result.content[0].text).code).toBe('REJECTED');
  });
});

describe('createRelayUnregisterEndpointHandler', () => {
  it('returns success when endpoint exists', async () => {
    // Purpose: basic happy path for cleanup tool.
    const relayCore = makeRelayCoreMock({ unregisterResult: true });
    const handler = createRelayUnregisterEndpointHandler({
      ...makeMockDeps(),
      relayCore,
    } as McpToolDeps);
    const result = await handler({ subject: 'relay.inbox.dispatch.abc' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it('returns ENDPOINT_NOT_FOUND when endpoint does not exist', async () => {
    // Purpose: caller can detect cleanup of non-existent inbox (idempotent cleanup).
    const relayCore = makeRelayCoreMock({ unregisterResult: false });
    const handler = createRelayUnregisterEndpointHandler({
      ...makeMockDeps(),
      relayCore,
    } as McpToolDeps);
    const result = await handler({ subject: 'relay.inbox.dispatch.gone' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('ENDPOINT_NOT_FOUND');
  });

  it('returns error when relay disabled', async () => {
    // Purpose: verifies requireRelay guard applies to relay_unregister_endpoint.
    const handler = createRelayUnregisterEndpointHandler(makeMockDeps());
    const result = await handler({ subject: 'relay.inbox.dispatch.abc' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('RELAY_DISABLED');
  });
});
