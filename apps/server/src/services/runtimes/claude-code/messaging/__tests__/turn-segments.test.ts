/**
 * Segment tracking for multi-segment turns (DOR-1149).
 *
 * The tracker decides whether a `result` ends the turn or only a segment of
 * it. Getting that wrong in one direction kills phantom steering; in the other
 * it deadlocks the turn, which is why the deferral is capped.
 */
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTurnSegments, MAX_DEFERRED_SEGMENT_CLOSES } from '../turn-segments.js';

function taskStarted(taskId: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'task_started',
    task_id: taskId,
    session_id: `subagent-${taskId}`,
  } as unknown as SDKMessage;
}

function taskNotification(
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

describe('createTurnSegments', () => {
  it('does not hold the stream open when no background task ever started', () => {
    const segments = createTurnSegments();
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('holds the stream open while a started task has not reported', () => {
    const segments = createTurnSegments();
    segments.observe(taskStarted('t1'));
    expect(segments.holdOpenAtResult()).toBe(true);
  });

  it('releases the stream once every task has reported', () => {
    const segments = createTurnSegments();
    segments.observe(taskStarted('t1'));
    segments.observe(taskNotification('t1'));
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('counts tasks independently — one report does not clear the rest', () => {
    const segments = createTurnSegments();
    segments.observe(taskStarted('t1'));
    segments.observe(taskStarted('t2'));
    segments.observe(taskNotification('t1'));
    expect(segments.outstandingCount()).toBe(1);
    expect(segments.holdOpenAtResult()).toBe(true);
  });

  it.each(['failed', 'stopped'] as const)('treats a %s task as reported', (status) => {
    const segments = createTurnSegments();
    segments.observe(taskStarted('t1'));
    segments.observe(taskNotification('t1', status));
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('caps the deferrals so a task that never reports cannot deadlock the turn', () => {
    const segments = createTurnSegments();
    segments.observe(taskStarted('never-reports'));
    for (let i = 0; i < MAX_DEFERRED_SEGMENT_CLOSES; i++) {
      expect(segments.holdOpenAtResult()).toBe(true);
    }
    expect(segments.holdOpenAtResult()).toBe(false);
  });

  it('ignores lifecycle messages with no task id rather than counting them', () => {
    const segments = createTurnSegments();
    segments.observe({ type: 'system', subtype: 'task_started' } as unknown as SDKMessage);
    expect(segments.outstandingCount()).toBe(0);
  });

  it('ignores unrelated messages', () => {
    const segments = createTurnSegments();
    segments.observe({ type: 'assistant', uuid: 'a1' } as unknown as SDKMessage);
    segments.observe({ type: 'system', subtype: 'init' } as unknown as SDKMessage);
    segments.observe({ type: 'result', subtype: 'success' } as unknown as SDKMessage);
    expect(segments.outstandingCount()).toBe(0);
  });
});
