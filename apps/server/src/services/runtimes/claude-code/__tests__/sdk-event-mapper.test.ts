import { describe, it, expect } from 'vitest';
import { mapSdkMessage } from '../sdk-event-mapper.js';
import { sdkTaskStarted, sdkTaskProgress, sdkTaskNotification } from './sdk-scenarios.js';
import type { AgentSession, ToolState } from '../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

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
      subtype: 'status',
      session_id: 'test',
      uuid: '00000000-0000-4000-8000-000000000001',
    } as unknown as Parameters<typeof mapSdkMessage>[0];
    const events = await collectEvents(msg, session, sessionId, toolState);

    expect(events).toHaveLength(0);
  });
});
