import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapMessageEvent } from '../message-event-mapper.js';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import type { StreamEvent, TaskUpdateEvent } from '@dorkos/shared/types';

/**
 * DOR-1441: `TaskCreate` never carries an id in its input — only the
 * tool_result does. These tests exercise the message-event-mapper path that
 * resolves a pending create (keyed by its tool_use id) to the SDK's real id
 * once the tool_result confirms it, or drops it on failure.
 */

async function collect(
  message: SDKMessage,
  session: AgentSession,
  toolState: ToolState
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of mapMessageEvent(message, session, toolState)) events.push(e);
  return events;
}

function makeSession(): AgentSession {
  return { sdkSessionId: null, hasStarted: false } as unknown as AgentSession;
}

function makeToolState(toolName: string): ToolState {
  return {
    toolNameById: new Map<string, string>([['toolu_1', toolName]]),
    resolvedResultIds: new Set<string>(),
    toolInputReceived: new Set<string>(),
  } as unknown as ToolState;
}

function taskCreateResult(content: string, isError = false): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content,
          ...(isError ? { is_error: true } : {}),
        },
      ],
    },
  } as unknown as SDKMessage;
}

describe('message-event-mapper — TaskCreate id resolution', () => {
  it('emits an id_assigned task_update keyed to the pending create when the SDK confirms success', async () => {
    const events = await collect(
      taskCreateResult('Task #7 created successfully: Ship it'),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect(taskEvent).toBeDefined();
    expect(taskEvent!.data as TaskUpdateEvent).toEqual({
      action: 'id_assigned',
      task: { id: '7', subject: '', status: 'pending' },
      previousId: 'pending:toolu_1',
    });
  });

  it('emits a remove task_update when the tool_result reports failure', async () => {
    const events = await collect(
      taskCreateResult('Error: permission denied', true),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect(taskEvent!.data as TaskUpdateEvent).toEqual({
      action: 'remove',
      task: { id: 'pending:toolu_1', subject: '', status: 'pending' },
    });
  });

  it('treats is_error as authoritative even if the result text happens to look like a success confirmation', async () => {
    // A pathological/adversarial case: is_error must gate the outcome, not
    // just the text shape — the call failed, so the id must never be trusted
    // regardless of what the result text says.
    const events = await collect(
      taskCreateResult('Task #5 created successfully: Ship it', true),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect((taskEvent!.data as TaskUpdateEvent).action).toBe('remove');
  });

  it('emits a remove task_update when the result text does not match the SDK confirmation format', async () => {
    const events = await collect(
      taskCreateResult('Something unexpected happened'),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect((taskEvent!.data as TaskUpdateEvent).action).toBe('remove');
  });

  it('does not emit a task_update for a non-TaskCreate tool result', async () => {
    const events = await collect(
      taskCreateResult('some other tool ran fine'),
      makeSession(),
      makeToolState('Read')
    );

    expect(events.find((e) => e.type === 'task_update')).toBeUndefined();
    // The ordinary tool_result event still goes out.
    expect(events.find((e) => e.type === 'tool_result')).toBeDefined();
  });
});
