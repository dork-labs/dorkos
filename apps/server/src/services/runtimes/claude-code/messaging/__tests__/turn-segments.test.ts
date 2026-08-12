/**
 * Segment tracking for multi-segment turns (DOR-1149).
 *
 * The tracker decides whether a `result` ends the turn or only a segment of
 * it. Getting that wrong in one direction kills phantom steering; in the other
 * it stalls the turn, which is why the deferral is bounded twice.
 */
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnSegments, MAX_DEFERRED_SEGMENT_CLOSES } from '../turn-segments.js';

/** The SDK lifecycle message saying a background task has settled. */
function taskSettled(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped' = 'completed'
): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status,
    session_id: `subagent-${taskId}`,
  } as unknown as SDKMessage;
}

/** The queued notification arriving as a user message — the delivery segment. */
function taskDelivered(taskIds: string | string[], asBlocks = false): SDKMessage {
  const ids = Array.isArray(taskIds) ? taskIds : [taskIds];
  const text = ids
    .map(
      (id) =>
        `<task-notification><task-id>${id}</task-id><status>completed</status></task-notification>`
    )
    .join('\n');
  return {
    type: 'user',
    session_id: 'sdk-1',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: asBlocks ? [{ type: 'text', text }] : text,
    },
  } as unknown as SDKMessage;
}

describe('createTurnSegments', () => {
  it('does not hold the stream open when nothing is owed', () => {
    const segments = createTurnSegments();
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  // The case the first attempt at this fix got wrong: a task SETTLES before the
  // `result` that ends the segment, so keying on "tasks still running" left a
  // single-task turn with nothing outstanding at the moment it mattered.
  it('holds the stream open after a task settles but before its delivery', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    expect(segments.owedCount()).toBe(1);
    expect(segments.holdOpenAtResult()).toBe(true);
  });

  it('releases the stream once the notification has been delivered', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    segments.observe(taskDelivered('t1'));
    expect(segments.owedCount()).toBe(0);
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('reads the delivery out of text blocks as well as plain text', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    segments.observe(taskDelivered('t1', true));
    expect(segments.owedCount()).toBe(0);
  });

  it('matches deliveries to their own task — one arrival does not clear the rest', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    segments.observe(taskSettled('t2'));
    segments.observe(taskDelivered('t1'));
    expect(segments.owedCount()).toBe(1);
    expect(segments.holdOpenAtResult()).toBe(true);
  });

  it('clears several deliveries folded into one message', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    segments.observe(taskSettled('t2'));
    segments.observe(taskDelivered(['t1', 't2']));
    expect(segments.owedCount()).toBe(0);
  });

  it.each(['failed', 'stopped'] as const)('owes a delivery for a %s task too', (status) => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1', status));
    expect(segments.holdOpenAtResult()).toBe(true);
  });

  it('a task that never settles owes nothing and never defers', () => {
    // The old keying pinned the stream open here; a killed or detached helper
    // is routine, so this must cost nothing.
    const segments = createTurnSegments();
    segments.observe({
      type: 'system',
      subtype: 'task_started',
      task_id: 'never-settles',
    } as unknown as SDKMessage);
    expect(segments.owedCount()).toBe(0);
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('treats an unparseable delivery as proof the queue drained', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('t1'));
    segments.observe({
      type: 'user',
      message: {
        role: 'user',
        content: '<task-notification>reworded upstream</task-notification>',
      },
    } as unknown as SDKMessage);
    expect(segments.owedCount()).toBe(0);
  });

  it('caps the deferrals so an undelivered notification cannot defer for ever', () => {
    const segments = createTurnSegments();
    segments.observe(taskSettled('never-delivered'));
    for (let i = 0; i < MAX_DEFERRED_SEGMENT_CLOSES; i++) {
      expect(segments.holdOpenAtResult()).toBe(true);
    }
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('ignores a settle with no task id rather than owing an unmatchable delivery', () => {
    const segments = createTurnSegments();
    segments.observe({ type: 'system', subtype: 'task_notification' } as unknown as SDKMessage);
    expect(segments.owedCount()).toBe(0);
  });

  it('ignores unrelated messages', () => {
    const segments = createTurnSegments();
    segments.observe({ type: 'assistant', uuid: 'a1' } as unknown as SDKMessage);
    segments.observe({ type: 'system', subtype: 'init' } as unknown as SDKMessage);
    segments.observe({ type: 'result', subtype: 'success' } as unknown as SDKMessage);
    expect(segments.owedCount()).toBe(0);
  });
});
