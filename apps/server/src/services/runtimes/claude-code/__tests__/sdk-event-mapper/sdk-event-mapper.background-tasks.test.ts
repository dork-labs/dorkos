/**
 * sdk-event-mapper: background tasks. Shared setup lives in `./sdk-event-mapper.fixtures.ts`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import {
  sdkTaskStarted,
  sdkTaskProgress,
  sdkTaskNotification,
  sdkSubagentText,
} from '../sdk-scenarios.js';
import type { AgentSession } from '../../agent-types.js';
import { collectEvents, makeSession, makeToolState } from './sdk-event-mapper.fixtures.js';

describe('sdk-event-mapper background task lifecycle', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps task_started to background_task_started', async () => {
    const msg = sdkTaskStarted('task-1', 'Explore codebase');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_started');
    expect(events[0].data).toMatchObject({
      taskId: 'task-1',
      taskType: 'agent',
      subagentSessionId: 'subagent-task-1',
      toolUseId: undefined,
      description: 'Explore codebase',
    });
    expect((events[0].data as Record<string, unknown>).startedAt).toEqual(expect.any(Number));
  });

  describe('task kinds (spec warm-process-lifecycle D8)', () => {
    it.each([
      ['local_agent', 'agent'],
      ['local_bash', 'bash'],
      ['monitor_mcp', 'other'],
      ['local_workflow', 'other'],
    ] as const)('maps task_type %s to %s and keeps the runtime name', async (raw, kind) => {
      const msg = sdkTaskStarted('task-k', 'Watch the build', undefined, { task_type: raw });
      const events = await collectEvents(msg, session, sessionId, toolState);

      expect(events[0].data).toMatchObject({ taskType: kind, runtimeTaskType: raw });
    });
  });

  it('maps task_progress to background_task_progress', async () => {
    const msg = sdkTaskProgress('task-1', 3, 5000, 'Read');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_progress');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      toolUses: 3,
      lastToolName: 'Read',
      durationMs: 5000,
    });
  });

  it('maps task_notification (completed) to background_task_done', async () => {
    const msg = sdkTaskNotification('task-1', 'completed', 'Found 7 files');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('background_task_done');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      status: 'completed',
      summary: 'Found 7 files',
      toolUses: 5,
      durationMs: 3000,
    });
  });

  describe('housekeeping (ambient) tasks', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('carries ambient through task_started when the runtime marks the task', async () => {
      const msg = sdkTaskStarted('task-amb', 'Watch the docs folder', undefined, {
        ambient: true,
        is_backgrounded: true,
        spawn_depth: 1,
      });
      const events = await collectEvents(msg, session, sessionId, toolState);

      expect(events[0].type).toBe('background_task_started');
      expect(events[0].data).toMatchObject({ taskId: 'task-amb', ambient: true });
    });

    it('carries ambient through task_notification so a late joiner still hides it', async () => {
      const msg = sdkTaskNotification('task-amb', 'completed', 'Nothing changed', {
        ambient: true,
      });
      const events = await collectEvents(msg, session, sessionId, toolState);

      expect(events[0].type).toBe('background_task_done');
      expect(events[0].data).toMatchObject({ taskId: 'task-amb', ambient: true });
    });
  });

  it('yields system_status event with message text from body field', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
      body: 'Compacting context...',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect(events[0].data).toEqual({ message: 'Compacting context...' });
  });

  it('yields compact_boundary event', async () => {
    const msg = {
      type: 'system',
      subtype: 'compact_boundary',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('compact_boundary');
    expect(events[0].data).toEqual({ endedAt: expect.any(Number) });
  });

  it('yields elicitation_complete event', async () => {
    const msg = {
      type: 'system',
      subtype: 'elicitation_complete',
      mcp_server_name: 'github-oauth',
      elicitation_id: 'elicit-456',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('elicitation_complete');
    expect(events[0].data).toEqual({
      serverName: 'github-oauth',
      elicitationId: 'elicit-456',
    });
  });
});

describe('sdk-event-mapper forwarded subagent text (SDK forwardSubagentText)', () => {
  const session = makeSession();
  const sessionId = 'test-session';

  it('maps a forwarded subagent assistant text block to subagent_text_delta', async () => {
    const toolState = makeToolState();
    // The SDK forwards subagent text as a complete `assistant` message tagged
    // with parent_tool_use_id — not as stream-event deltas.
    const msg = sdkSubagentText('toolu_parent_1', 'Exploring the auth module');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_text_delta');
    expect(events[0].data).toEqual({
      parentToolUseId: 'toolu_parent_1',
      text: 'Exploring the auth module',
    });
  });

  it('does NOT leak forwarded subagent text into the main text_delta stream', async () => {
    const toolState = makeToolState();
    const msg = sdkSubagentText('toolu_parent_1', 'subagent output');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events.some((e) => e.type === 'text_delta')).toBe(false);
  });
});

// DOR-3285: a background shell outlives the CLI's interrupt, so the mapper
// records each one the turn starts for a Stop to end by its task id.
describe('sdk-event-mapper records the turn’s background shells for Stop', () => {
  const started = (taskId: string, taskType?: string) =>
    sdkTaskStarted(taskId, 'Run a command', `toolu-${taskId}`, {
      is_backgrounded: true,
      ...(taskType ? { task_type: taskType } : {}),
    } as Parameters<typeof sdkTaskStarted>[3]);

  it('records a shell, and an untyped task, but not a subagent', async () => {
    const session = { ...makeSession(), turnTaskIds: new Map<string, string>() } as AgentSession;
    for (const msg of [
      started('shell', 'local_bash'),
      started('untyped'),
      started('helper', 'local_agent'),
    ])
      await collectEvents(msg, session, 'test-session', makeToolState());
    expect([...session.turnTaskIds!.keys()]).toEqual(['shell', 'untyped']);
  });

  it('drops a task once it has settled, whatever the ending', async () => {
    const session = {
      ...makeSession(),
      turnTaskIds: new Map([
        ['done', ''],
        ['still-going', ''],
      ]),
    } as AgentSession;
    const events = await collectEvents(
      sdkTaskNotification('done', 'completed', 'ok'),
      session,
      'test-session',
      makeToolState()
    );
    expect([...session.turnTaskIds!.keys()]).toEqual(['still-going']);
    // Not one a Stop left running, so the stopped turn's line has nothing to hear.
    expect(events.map((e) => e.type)).toEqual(['background_task_done']);
  });

  it('tells the stopped turn when a command it left running ends, once', async () => {
    const session = {
      ...makeSession(),
      leftRunningTasks: new Map([
        ['stubborn', 'tail -f log'],
        ['other', 'sleep 600'],
      ]),
    } as AgentSession;
    const end = () =>
      collectEvents(
        sdkTaskNotification('stubborn', 'failed', 'exit 1'),
        session,
        'test-session',
        makeToolState()
      );

    const events = await end();
    expect(events.map((e) => e.type)).toEqual(['background_task_done', 'work_left_ended']);
    expect(events[1]!.data).toEqual({ taskId: 'stubborn', status: 'failed' });
    expect([...session.leftRunningTasks!.keys()]).toEqual(['other']);

    // A repeated notification is not a second end.
    expect((await end()).map((e) => e.type)).toEqual(['background_task_done']);
  });
});
