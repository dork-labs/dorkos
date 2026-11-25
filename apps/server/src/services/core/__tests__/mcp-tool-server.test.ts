import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
} from '../../runtimes/claude-code/mcp-tools/index.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

vi.mock('../../../lib/version.js', () => ({
  SERVER_VERSION: '1.0.0',
  IS_DEV_BUILD: false,
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn(),
}));

// Mocks required by agent-creator.ts (transitively imported via agent-tools)
// Spread over the original, the way the `trait-renderer` mock below does: the
// module also carries the character budgets `UpdateAgentConventionsSchema` is
// built from, and a mock that drops them leaves the schema with no maximum.
vi.mock('@dorkos/shared/convention-files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/convention-files')>()),
  defaultSoulTemplate: vi.fn(() => '# SOUL'),
  defaultNopeTemplate: vi.fn(() => '# NOPE'),
  buildSoulContent: vi.fn(() => '# SOUL'),
}));
vi.mock('@dorkos/shared/convention-files-io', () => ({
  writeConventionFile: vi.fn(),
  writeConventionFileIfAbsent: vi.fn(async () => true),
  readConventionFile: vi.fn(),
}));
vi.mock('@dorkos/shared/trait-renderer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dorkos/shared/trait-renderer')>()),
  renderTraits: vi.fn(() => ''),
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

vi.mock('@anthropic-ai/claude-agent-sdk', async () => {
  const { sdkMcpFactoryMock } =
    await import('../../runtimes/claude-code/mcp-tools/__tests__/sdk-mcp-factory-mock.js');
  return sdkMcpFactoryMock();
});

/** Recorded tool surface returned by the adapter-owned SDK factory fixture. */
interface MockServer {
  name: string;
  version: string;
  tools: { name: string; description: string }[];
}

/** A real, empty data directory: the task handlers write SKILL.md files under it. */
const TASKS_HOME = mkdtempSync(path.join(os.tmpdir(), 'dorkos-mcp-tool-server-'));

/** Create a mock McpToolDeps with a stubbed transcript reader */
function makeMockDeps(overrides: { listSessions?: ReturnType<typeof vi.fn> } = {}): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: overrides.listSessions ?? vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/test/cwd',
    dorkHome: TASKS_HOME,
  };
}

/** Create a mock TasksStore with sensible defaults */
function makeMockTasksStore(overrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}) {
  return {
    getTasks: vi.fn().mockReturnValue([]),
    // A plausible EXISTING task: update and delete read the row before they write.
    getTask: vi.fn().mockReturnValue({
      id: 'existing',
      name: 'existing-task',
      prompt: 'the approved prompt',
      cron: '0 2 * * *',
      permissionMode: 'acceptEdits',
      status: 'active',
    }),
    updateTask: vi.fn().mockReturnValue(null),
    // A row-only update (no file written) is settled against the approval
    // (DOR-2302); these cases never change a package's timing, so nothing moves.
    approvals: {
      settleApprovedWorkChange: vi.fn().mockReturnValue('unchanged'),
      // Who last changed a schedule (DOR-3703): recorded on every agent edit.
      recordAgentEdit: vi.fn(),
      agentEditsOf: vi.fn().mockReturnValue(null),
    },
    deleteTask: vi.fn().mockReturnValue(false),
    listRuns: vi.fn().mockReturnValue([]),
    // tasks_list reads each task's last run (DOR-3641): none has run.
    runHistory: vi.fn().mockReturnValue(() => ({ lastRunAt: null })),
    ...overrides,
  } as unknown as McpToolDeps['taskStore'];
}

/** Create mock deps with Tasks enabled */
function makeTasksDeps(
  storeOverrides: Partial<Record<string, ReturnType<typeof vi.fn>>> = {}
): McpToolDeps {
  return {
    ...makeMockDeps(),
    taskStore: makeMockTasksStore(storeOverrides),
  };
}

describe('MCP Tool Handlers', () => {
  describe('handlePing', () => {
    it('returns one text block: pong, the server name and an ISO timestamp', async () => {
      const result = await handlePing();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.status).toBe('pong');
      expect(parsed.server).toBe('dorkos');
      expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
    });
  });

  describe('handleGetServerInfo', () => {
    it('says which kind of DorkOS this is, with its version and architecture', async () => {
      const result = await handleGetServerInfo({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.product).toBe('DorkOS');
      expect(parsed.uptime_seconds).toBeUndefined();
      // Tests run from source, so this server is a checkout.
      expect(parsed.distribution).toEqual({
        kind: 'dev',
        version: '1.0.0',
        arch: process.arch,
        label: `DorkOS dev checkout 1.0.0 (${process.arch})`,
      });
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
      // Nothing is running in the background here, and the read says so (DOR-2065).
      expect(parsed.backgroundWork).toBe(0);
      expect(listSessions).toHaveBeenCalledWith('/test/cwd');
    });

    // DOR-2065: a chat in this folder whose shell is still running counts.
    it('counts this folder’s chats with background work still running', async () => {
      const { getOrCreateProjector, disposeProjector } =
        await import('../../session/session-state-projector.js');
      const projector = getOrCreateProjector('bg-count-chat', '/test/bg-folder');
      projector.ingest({
        type: 'subagent_update',
        taskId: 'sh-1',
        status: 'running',
        taskType: 'bash',
      } as never);
      try {
        const handler = createGetSessionCountHandler(
          makeMockDeps({ listSessions: vi.fn().mockResolvedValue([{ id: 'bg-count-chat' }]) })
        );
        const parsed = JSON.parse((await handler({ cwd: '/test/bg-folder' })).content[0].text);
        expect(parsed).toMatchObject({ count: 1, backgroundWork: 1 });
      } finally {
        disposeProjector('bg-count-chat');
      }
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
    it('returns all schedules when Tasks enabled', async () => {
      const schedules = [
        { id: 's1', name: 'Daily', enabled: true },
        { id: 's2', name: 'Weekly', enabled: false },
      ];
      const handler = createListSchedulesHandler(
        makeTasksDeps({ getTasks: vi.fn().mockReturnValue(schedules) })
      );
      const result = await handler({});
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedules).toEqual(
        schedules.map((schedule) => ({ ...schedule, lastRunAt: null }))
      );
      expect(parsed.count).toBe(2);
    });

    it('filters to enabled_only when flag set', async () => {
      const schedules = [
        { id: 's1', name: 'Daily', enabled: true },
        { id: 's2', name: 'Weekly', enabled: false },
      ];
      const handler = createListSchedulesHandler(
        makeTasksDeps({ getTasks: vi.fn().mockReturnValue(schedules) })
      );
      const result = await handler({ enabled_only: true });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.schedules).toHaveLength(1);
      expect(parsed.schedules[0].id).toBe('s1');
    });

    it('fills nextRun from the scheduler, not the stored row`s null (DOR-3125)', async () => {
      const schedules = [
        { id: 's1', name: 'Daily', enabled: true, nextRun: null },
        { id: 's2', name: 'Paused', enabled: false, nextRun: null },
      ];
      const next = new Date('2026-01-16T09:00:00.000Z');
      const handler = createListSchedulesHandler({
        ...makeTasksDeps({ getTasks: vi.fn().mockReturnValue(schedules) }),
        nextRunOf: (id: string) => (id === 's1' ? next : null),
      });
      const parsed = JSON.parse((await handler({})).content[0].text);
      expect(parsed.schedules[0].nextRun).toBe('2026-01-16T09:00:00.000Z');
      expect(parsed.schedules[1].nextRun).toBeNull();
    });

    it.each([
      ['list_schedules', () => createListSchedulesHandler(makeMockDeps())({})],
      [
        'create_schedule',
        () =>
          createCreateScheduleHandler(makeMockDeps())({
            name: 'X',
            prompt: 'Y',
            cron: '* * * * *',
            target: 'global',
          }),
      ],
      ['update_schedule', () => createUpdateScheduleHandler(makeMockDeps())({ id: 'x' })],
      ['delete_schedule', () => createDeleteScheduleHandler(makeMockDeps())({ id: 'x' })],
      ['get_run_history', () => createGetRunHistoryHandler(makeMockDeps())({ schedule_id: 'x' })],
    ] as const)('%s refuses while Tasks is turned off', async (_tool, call) => {
      const result = await call();
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('turned off');
    });
  });

  describe('createUpdateScheduleHandler', () => {
    it('returns error for non-existent ID', async () => {
      const handler = createUpdateScheduleHandler(
        makeTasksDeps({ updateTask: vi.fn().mockReturnValue(null) })
      );
      const result = await handler({ id: 'missing' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('missing');
      expect(parsed.error).toContain('not found');
    });

    // FB-26: a package schedule is switched on the row alone and `enabled` is
    // agent-writable, so an agent switching one back on must leave a trace the
    // person can see, naming the agent.
    describe('switching a schedule back on', () => {
      const switchedOff = {
        id: 'u1',
        name: 'nightly-sweep',
        prompt: 'the approved prompt',
        cron: '0 2 * * *',
        permissionMode: 'acceptEdits',
        status: 'active',
        enabled: false,
      };

      function depsWithActivity(existing: Record<string, unknown>, enabledAfter: boolean) {
        const emit = vi.fn();
        const deps = {
          ...makeTasksDeps({
            getTask: vi.fn().mockReturnValue(existing),
            updateTask: vi.fn().mockReturnValue({ ...existing, enabled: enabledAfter }),
          }),
          activityService: { emit },
        } as unknown as McpToolDeps;
        return { deps, emit };
      }

      it('records it in the Activity feed as the agent that did it', async () => {
        const { deps, emit } = depsWithActivity(switchedOff, true);
        const handler = createUpdateScheduleHandler(deps, () => ({
          agentPath: '/Users/dev/agents/researcher',
        }));

        const result = await handler({ id: 'u1', enabled: true });

        expect(result.isError).toBeUndefined();
        expect(emit).toHaveBeenCalledTimes(1);
        expect(emit).toHaveBeenCalledWith(
          expect.objectContaining({
            actorType: 'agent',
            actorId: '/Users/dev/agents/researcher',
            eventType: 'tasks.task_resumed',
            resourceId: 'u1',
          })
        );
      });
    });
  });

  describe('createDeleteScheduleHandler', () => {
    it('returns error for non-existent ID', async () => {
      const handler = createDeleteScheduleHandler(
        makeTasksDeps({ deleteTask: vi.fn().mockReturnValue(false) })
      );
      const result = await handler({ id: 'ghost' });
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toContain('ghost');
      expect(parsed.error).toContain('not found');
    });
  });

  describe('createGetRunHistoryHandler', () => {
    it('returns runs with default limit', async () => {
      const runs = [{ id: 'r1' }, { id: 'r2' }];
      const listRuns = vi.fn().mockReturnValue(runs);
      const handler = createGetRunHistoryHandler(makeTasksDeps({ listRuns }));
      const result = await handler({ schedule_id: 'sched-1' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.runs).toEqual(runs);
      expect(parsed.count).toBe(2);
      expect(listRuns).toHaveBeenCalledWith({ taskId: 'sched-1', limit: 20 });
    });
  });

  describe('createGetAgentHandler', () => {
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
  });

  describe('createDorkOsToolServer', () => {
    it('registers 56 tools including the five document-channel verbs', () => {
      // Regression guard against accidental tool omissions or additions. The
      // count changes on purpose when a tool is added or retired; the history
      // of each step is in this file's git log.
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      expect(server.tools).toHaveLength(56);
      for (const name of [
        'configure_doc_channel',
        'approve_doc_route',
        'revoke_doc_route',
        'canvas_send',
        'canvas_patch_state',
      ]) {
        expect(server.tools.map((tool) => tool.name)).toContain(name);
      }
    });

    it('registers tools with correct names', () => {
      const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
      const toolNames = server.tools.map((t) => t.name);
      expect(toolNames).toEqual(
        expect.arrayContaining([
          'ping',
          'get_session_count',
          'get_agent',
          'tasks_list',
          'tasks_create',
          'relay_notify_user',
          'control_ui',
          'browser_screenshot',
        ])
      );
      // Retired for the chat tools (spec `spin-off-chats` §7).
      for (const retired of [
        'relay_send',
        'relay_inbox',
        'relay_register_endpoint',
        'relay_send_and_wait',
        'relay_send_async',
        'relay_unregister_endpoint',
      ]) {
        expect(toolNames).not.toContain(retired);
      }
    });
  });
});
