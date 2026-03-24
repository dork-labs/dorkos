import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useRunningSubagents, AGENT_COLORS } from '../use-running-subagents';
import type { ChatMessage } from '../chat-types';
import type { SubagentPart, MessagePart } from '@dorkos/shared/types';

function makeTextPart(text: string): MessagePart {
  return { type: 'text', text };
}

function makeSubagentPart(overrides: Partial<SubagentPart> & { taskId: string }): SubagentPart {
  return {
    type: 'subagent',
    description: 'Test agent',
    status: 'running',
    ...overrides,
  };
}

function makeMessage(parts: MessagePart[], id?: string): ChatMessage {
  return {
    id: id ?? crypto.randomUUID(),
    role: 'assistant',
    content: '',
    parts,
    timestamp: new Date().toISOString(),
  };
}

describe('useRunningSubagents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns empty array when no messages have subagent parts', () => {
    const messages: ChatMessage[] = [
      makeMessage([makeTextPart('Hello'), makeTextPart('World')]),
      makeMessage([makeTextPart('Another message')]),
    ];

    const { result } = renderHook(() => useRunningSubagents(messages));

    expect(result.current).toEqual([]);
  });

  it('returns running subagents extracted from message parts', () => {
    const messages: ChatMessage[] = [
      makeMessage([
        makeSubagentPart({
          taskId: 'a',
          description: 'Test',
          status: 'running',
          toolUses: 5,
          lastToolName: 'Read',
        }),
      ]),
    ];

    const { result } = renderHook(() => useRunningSubagents(messages));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      taskId: 'a',
      description: 'Test',
      status: 'running',
      toolUses: 5,
      lastToolName: 'Read',
    });
    expect(AGENT_COLORS).toContain(result.current[0].color);
  });

  it('excludes completed subagents after celebration timeout', () => {
    const runningMessages: ChatMessage[] = [
      makeMessage([makeSubagentPart({ taskId: 'a', status: 'running' })]),
    ];

    const { result, rerender } = renderHook(({ messages }) => useRunningSubagents(messages), {
      initialProps: { messages: runningMessages },
    });

    expect(result.current).toHaveLength(1);

    // Transition to complete — the useEffect detects running→complete,
    // adds to celebratingRef, and schedules a 1500ms timer.
    const completedMessages: ChatMessage[] = [
      makeMessage([makeSubagentPart({ taskId: 'a', status: 'complete' })]),
    ];
    rerender({ messages: completedMessages });

    // Before the celebration timer fires, the agent is still in the celebrating
    // set (ref was mutated by the effect). Advance partway to trigger a re-render
    // that picks up the celebrating ref state but doesn't expire the timer.
    act(() => {
      vi.advanceTimersByTime(500);
    });

    // The timer hasn't fired yet — if the hook re-rendered at any point,
    // it would see the celebrating ref. But the only render trigger is
    // setRenderTick inside the timer callback at 1500ms. So the agent may
    // or may not be visible depending on React's internal scheduling.
    // What we can definitively test: after 1500ms the agent IS removed.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Timer has now fired (total 1500ms), clearing celebrating and triggering re-render
    expect(result.current).toHaveLength(0);
  });

  it('assigns stable colors per taskId', () => {
    const messages: ChatMessage[] = [
      makeMessage([
        makeSubagentPart({ taskId: 'x' }),
        makeSubagentPart({ taskId: 'y' }),
        makeSubagentPart({ taskId: 'z' }),
      ]),
    ];

    const { result, rerender } = renderHook(({ messages }) => useRunningSubagents(messages), {
      initialProps: { messages },
    });

    const colorX = result.current.find((a) => a.taskId === 'x')!.color;
    const colorY = result.current.find((a) => a.taskId === 'y')!.color;
    const colorZ = result.current.find((a) => a.taskId === 'z')!.color;

    // Complete the middle agent
    const updatedMessages: ChatMessage[] = [
      makeMessage([
        makeSubagentPart({ taskId: 'x', status: 'running' }),
        makeSubagentPart({ taskId: 'y', status: 'complete' }),
        makeSubagentPart({ taskId: 'z', status: 'running' }),
      ]),
    ];
    rerender({ messages: updatedMessages });

    // Advance past celebration timeout to remove y
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    // Remaining agents keep their original colors
    expect(result.current).toHaveLength(2);
    expect(result.current.find((a) => a.taskId === 'x')!.color).toBe(colorX);
    expect(result.current.find((a) => a.taskId === 'z')!.color).toBe(colorZ);

    // Verify colors were different from each other
    expect(colorX).not.toBe(colorY);
    expect(colorY).not.toBe(colorZ);
  });

  it('assigns colors round-robin from AGENT_COLORS', () => {
    const taskIds = ['t1', 't2', 't3', 't4', 't5', 't6'];
    const messages: ChatMessage[] = [
      makeMessage(taskIds.map((taskId) => makeSubagentPart({ taskId }))),
    ];

    const { result } = renderHook(() => useRunningSubagents(messages));

    expect(result.current).toHaveLength(6);

    // First 5 agents get AGENT_COLORS[0] through AGENT_COLORS[4]
    for (let i = 0; i < 5; i++) {
      expect(result.current[i].color).toBe(AGENT_COLORS[i]);
    }

    // 6th wraps around to AGENT_COLORS[0]
    expect(result.current[5].color).toBe(AGENT_COLORS[0]);
  });

  it('scans all messages, not just the latest', () => {
    const messages: ChatMessage[] = [
      makeMessage([makeSubagentPart({ taskId: 'early', description: 'First message agent' })]),
      makeMessage([makeTextPart('Some text')]),
      makeMessage([makeTextPart('Another text')]),
    ];

    const { result } = renderHook(() => useRunningSubagents(messages));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      taskId: 'early',
      description: 'First message agent',
    });
  });
});
