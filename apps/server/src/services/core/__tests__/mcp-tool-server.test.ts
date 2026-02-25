import { describe, it, expect, vi } from 'vitest';
import type { McpToolDeps } from '../mcp-tool-server.js';
import {
  handlePing,
  handleGetServerInfo,
  createGetSessionCountHandler,
  createDorkOsToolServer,
  createListSchedulesHandler,
  createCreateScheduleHandler,
  createUpdateScheduleHandler,
  createDeleteScheduleHandler,
  createGetRunHistoryHandler,
} from '../mcp-tool-server.js';

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
function makeMockDeps(
  overrides: { listSessions?: ReturnType<typeof vi.fn> } = {}
): McpToolDeps {
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
      const original = process.env.DORKOS_PORT;
      process.env.DORKOS_PORT = '9999';
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.port).toBe('9999');
      } finally {
        if (original !== undefined) process.env.DORKOS_PORT = original;
        else delete process.env.DORKOS_PORT;
      }
    });

    it('uses DORKOS_VERSION env var when set', async () => {
      const original = process.env.DORKOS_VERSION;
      process.env.DORKOS_VERSION = '2.0.0';
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.version).toBe('2.0.0');
      } finally {
        if (original !== undefined) process.env.DORKOS_VERSION = original;
        else delete process.env.DORKOS_VERSION;
      }
    });

    it('defaults port to 4242 when env var unset', async () => {
      const original = process.env.DORKOS_PORT;
      delete process.env.DORKOS_PORT;
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.port).toBe('4242');
      } finally {
        if (original !== undefined) process.env.DORKOS_PORT = original;
      }
    });

    it('defaults version to development when env var unset', async () => {
      const original = process.env.DORKOS_VERSION;
      delete process.env.DORKOS_VERSION;
      try {
        const result = await handleGetServerInfo({});
        const parsed = JSON.parse(result.content[0].text);
        expect(parsed.version).toBe('development');
      } finally {
        if (original !== undefined) process.env.DORKOS_VERSION = original;
      }
    });
  });

  describe('createGetSessionCountHandler', () => {
    it('returns session count from transcript reader', async () => {
      const listSessions = vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }, { id: 's3' }]);
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(3);
      expect(parsed.cwd).toBe('/test/cwd');
      expect(listSessions).toHaveBeenCalledWith('/test/cwd');
    });

    it('returns isError when transcript reader fails', async () => {
      const listSessions = vi.fn().mockRejectedValue(new Error('ENOENT'));
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler();
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('ENOENT');
    });

    it('returns zero for empty session directory', async () => {
      const handler = createGetSessionCountHandler(makeMockDeps());
      const result = await handler();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.count).toBe(0);
    });

    it('handles non-Error exceptions gracefully', async () => {
      const listSessions = vi.fn().mockRejectedValue('string error');
      const handler = createGetSessionCountHandler(makeMockDeps({ listSessions }));
      const result = await handler();
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe('Failed to list sessions');
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

  describe('createDorkOsToolServer', () => {
    it('creates server with name dorkos and version 1.0.0', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      expect(server).toBeDefined();
      expect(server.name).toBe('dorkos');
      expect(server.version).toBe('1.0.0');
    });

    it('registers 12 tools (3 core + 5 pulse + 4 relay)', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      expect(server.tools).toHaveLength(12);
    });

    it('registers tools with correct names', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      const toolNames = server.tools.map((t) => t.name);
      expect(toolNames).toContain('ping');
      expect(toolNames).toContain('get_server_info');
      expect(toolNames).toContain('get_session_count');
      expect(toolNames).toContain('list_schedules');
      expect(toolNames).toContain('create_schedule');
      expect(toolNames).toContain('update_schedule');
      expect(toolNames).toContain('delete_schedule');
      expect(toolNames).toContain('get_run_history');
      expect(toolNames).toContain('relay_send');
      expect(toolNames).toContain('relay_inbox');
      expect(toolNames).toContain('relay_list_endpoints');
      expect(toolNames).toContain('relay_register_endpoint');
    });
  });
});
