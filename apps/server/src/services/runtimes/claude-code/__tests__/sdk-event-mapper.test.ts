import { describe, it, expect } from 'vitest';
import { mapSdkMessage } from '../sdk-event-mapper.js';
import { sdkTaskStarted, sdkTaskProgress, sdkTaskNotification } from './sdk-scenarios.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type { StreamEvent, ErrorEvent } from '@dorkos/shared/types';

/** Collect all events yielded by the mapper for a single message. */
async function collectEvents(
  ...args: Parameters<typeof mapSdkMessage>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of mapSdkMessage(...args)) {
    events.push(event);
  }
  return events;
}

function makeSession(): AgentSession {
  return {
    sdkSessionId: null,
    hasStarted: false,
  } as AgentSession;
}

function makeToolState(): ToolState {
  return {
    inTool: false,
    currentToolName: '',
    currentToolId: '',
    taskToolInput: '',
    setToolState(inTool: boolean, name: string, id: string) {
      this.inTool = inTool;
      this.currentToolName = name;
      this.currentToolId = id;
    },
    resetTaskInput() {
      this.taskToolInput = '';
    },
    appendTaskInput(chunk: string) {
      this.taskToolInput += chunk;
    },
  } as ToolState;
}

describe('sdk-event-mapper subagent lifecycle', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  it('maps task_started to subagent_started', async () => {
    const msg = sdkTaskStarted('task-1', 'Explore codebase');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_started');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      subagentSessionId: 'subagent-task-1',
      toolUseId: undefined,
      description: 'Explore codebase',
    });
  });

  it('maps task_progress to subagent_progress', async () => {
    const msg = sdkTaskProgress('task-1', 3, 5000, 'Read');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_progress');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      toolUses: 3,
      lastToolName: 'Read',
      durationMs: 5000,
    });
  });

  it('maps task_progress without lastToolName', async () => {
    const msg = sdkTaskProgress('task-1', 1, 1000);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      toolUses: 1,
      lastToolName: undefined,
      durationMs: 1000,
    });
  });

  it('maps task_notification (completed) to subagent_done', async () => {
    const msg = sdkTaskNotification('task-1', 'completed', 'Found 7 files');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_done');
    expect(events[0].data).toEqual({
      taskId: 'task-1',
      status: 'completed',
      summary: 'Found 7 files',
      toolUses: 5,
      durationMs: 3000,
    });
  });

  it('maps task_notification (failed) to subagent_done', async () => {
    const msg = sdkTaskNotification('task-1', 'failed', 'Error occurred');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('subagent_done');
    expect(events[0].data).toMatchObject({
      taskId: 'task-1',
      status: 'failed',
      summary: 'Error occurred',
    });
  });

  it('yields nothing for unknown system subtypes', async () => {
    const msg = {
      type: 'system',
      subtype: 'unknown_future_subtype',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
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

  it('yields system_status event with message text from message field', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
      message: 'Permission mode changed',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('system_status');
    expect(events[0].data).toEqual({ message: 'Permission mode changed' });
  });

  it('yields nothing for status messages with no text', async () => {
    const msg = {
      type: 'system',
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
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
    expect(events[0].data).toEqual({});
  });
});

describe('sdk-event-mapper result messages', () => {
  const session = makeSession();
  const sessionId = 'test-session';
  const toolState = makeToolState();

  function makeResultMessage(
    subtype: string,
    errors?: string[]
  ): Parameters<typeof mapSdkMessage>[0] {
    return {
      type: 'result',
      subtype,
      model: 'claude-sonnet-4-20250514',
      total_cost_usd: 0.05,
      usage: { input_tokens: 1000, output_tokens: 500 },
      modelUsage: { 'claude-sonnet-4-20250514': { contextWindow: 200000 } },
      ...(errors ? { errors } : {}),
    } as unknown as Parameters<typeof mapSdkMessage>[0];
  }

  it('success result yields session_status + done (2 events)', async () => {
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('done');
    expect(events[1].data).toEqual({ sessionId: 'test-session' });
  });

  it('success result carries cost and token data in session_status', async () => {
    const msg = makeResultMessage('success');
    const events = await collectEvents(msg, session, sessionId, toolState);

    const status = events[0].data as Record<string, unknown>;
    expect(status.costUsd).toBe(0.05);
    expect(status.contextTokens).toBe(1000);
    expect(status.model).toBe('claude-sonnet-4-20250514');
  });

  it('error_max_turns yields session_status + error + done (3 events)', async () => {
    const msg = makeResultMessage('error_max_turns', ['Reached 10 turn limit']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(3);
    expect(events[0].type).toBe('session_status');
    expect(events[1].type).toBe('error');
    expect(events[2].type).toBe('done');

    const err = events[1].data as ErrorEvent;
    expect(err.category).toBe('max_turns');
    expect(err.message).toBe('Reached 10 turn limit');
    expect(err.code).toBe('error_max_turns');
  });

  it('error_during_execution maps to execution_error category', async () => {
    const msg = makeResultMessage('error_during_execution', ['API rate limit exceeded']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.category).toBe('execution_error');
    expect(err.message).toBe('API rate limit exceeded');
    expect(err.details).toBe('API rate limit exceeded');
  });

  it('error_max_budget_usd maps to budget_exceeded category', async () => {
    const msg = makeResultMessage('error_max_budget_usd', ['Budget of $1.00 exceeded']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.category).toBe('budget_exceeded');
    expect(err.code).toBe('error_max_budget_usd');
  });

  it('error_max_structured_output_retries maps to output_format_error', async () => {
    const msg = makeResultMessage('error_max_structured_output_retries', ['Failed to produce valid JSON']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.category).toBe('output_format_error');
  });

  it('error with multiple errors joins them in details', async () => {
    const msg = makeResultMessage('error_during_execution', ['Error 1', 'Error 2']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.message).toBe('Error 1');
    expect(err.details).toBe('Error 1\nError 2');
  });

  it('error with no errors array uses fallback message', async () => {
    const msg = makeResultMessage('error_during_execution');
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.message).toBe('An unexpected error occurred.');
  });

  it('unknown error subtype defaults to execution_error', async () => {
    const msg = makeResultMessage('error_unknown_future_type', ['Something new']);
    const events = await collectEvents(msg, session, sessionId, toolState);

    const err = events[1].data as ErrorEvent;
    expect(err.category).toBe('execution_error');
  });
});
