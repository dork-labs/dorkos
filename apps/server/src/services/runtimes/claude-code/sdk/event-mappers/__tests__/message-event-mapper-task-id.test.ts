import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { mapMessageEvent } from '../message-event-mapper.js';
import type { AgentSession, ToolState } from '../../../agent-types.js';
import type { StreamEvent, TaskUpdateEvent } from '@dorkos/shared/types';

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('../../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() },
}));

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

/** A tool_result whose `content` is an array of text blocks (multi-block SDK shape). */
function taskCreateResultBlocks(texts: string[]): SDKMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: texts.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  } as unknown as SDKMessage;
}

describe('message-event-mapper — TaskCreate id resolution', () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

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

  /**
   * DOR-1441 S-A: a successful create is not the same thing as a failed one,
   * even when its confirmation text doesn't parse. Deleting the task here
   * would be silent data loss for a call the SDK actually completed —
   * `is_error` (not text shape) must be what decides removal.
   */
  it('keeps the pending row and warns when a successful result does not match the SDK confirmation format', async () => {
    const events = await collect(
      taskCreateResult('Something unexpected happened'),
      makeSession(),
      makeToolState('TaskCreate')
    );

    expect(events.find((e) => e.type === 'task_update')).toBeUndefined();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0]!.join(' ')).toContain('toolu_1');
  });

  it('keeps the pending row when the confirmation text is preceded by a leading empty text block', async () => {
    // extractToolResultText joins blocks with "\n" — a leading empty block
    // shifts the confirmation text off offset 0.
    const events = await collect(
      taskCreateResultBlocks(['', 'Task #3 created successfully: Ship it']),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect(taskEvent!.data as TaskUpdateEvent).toEqual({
      action: 'id_assigned',
      task: { id: '3', subject: '', status: 'pending' },
      previousId: 'pending:toolu_1',
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('keeps the pending row when the confirmation text has incidental leading whitespace', async () => {
    const events = await collect(
      taskCreateResult(' Task #3 created successfully: Ship it'),
      makeSession(),
      makeToolState('TaskCreate')
    );

    const taskEvent = events.find((e) => e.type === 'task_update');
    expect(taskEvent!.data as TaskUpdateEvent).toEqual({
      action: 'id_assigned',
      task: { id: '3', subject: '', status: 'pending' },
      previousId: 'pending:toolu_1',
    });
    expect(mockWarn).not.toHaveBeenCalled();
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
