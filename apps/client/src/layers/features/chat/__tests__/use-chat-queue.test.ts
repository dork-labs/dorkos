// @vitest-environment jsdom
/**
 * `useChatQueue` — the QueuePanel ↔ queue-store boundary.
 *
 * The card callbacks address a queue item by its stable id, never by position:
 * the auto-flush dequeues the head while the panel is on screen, so an index
 * captured at render time can point at the neighbouring message by the time the
 * click lands. These tests pin the id contract and the draft bookkeeping that
 * rides on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRef, useState } from 'react';
import { useChatQueue } from '../model/use-chat-queue';
import { useSessionStreamStore } from '@/layers/entities/session';
import type { ChatInputHandle } from '../ui/input/ChatInput';

const SESSION_ID = 'session-1';

/** Drives the hook with real composer state, the way ChatInputContainer does. */
function useHarness() {
  const [input, setInput] = useState('');
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const queue = useChatQueue({
    input,
    setInput,
    status: 'streaming',
    sessionBusy: false,
    sessionId: SESSION_ID,
    selectedCwd: '/dir',
    onFlush: vi.fn(),
    tryNativeCommand: () => ({ handled: false }),
    chatInputRef,
  });
  return { input, setInput, ...queue };
}

beforeEach(() => {
  useSessionStreamStore.setState({ sessions: {}, sessionAccessOrder: [] });
});

describe('useChatQueue', () => {
  it('queues the composer text and clears the composer', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('follow-up'));
    act(() => result.current.handleQueue());

    expect(result.current.queue.map((item) => item.content)).toEqual(['follow-up']);
    expect(result.current.input).toBe('');
  });

  it('editing by id loads the item and parks the draft; cancelling restores it', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    expect(result.current.input).toBe('queued text');
    expect(result.current.editingIndex).toBe(0);

    act(() => result.current.handleQueueCancelEdit());
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('saving an edit writes the item and restores the draft', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueEdit(result.current.queue[0].id));
    act(() => result.current.setInput('revised text'));

    act(() => result.current.handleQueueSaveEdit());

    expect(result.current.queue.map((item) => item.content)).toEqual(['revised text']);
    expect(result.current.input).toBe('half-written thought');
  });

  it('editing an id that is no longer queued leaves the composer untouched', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('queued text'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    // The item flushed between render and click.
    act(() => result.current.handleQueueEdit('already-flushed'));

    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('removing the item under edit restores the draft; removing another does not', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('first'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    const [first, second] = result.current.queue;
    act(() => result.current.handleQueueEdit(second.id));
    expect(result.current.input).toBe('second');

    // Removing a different card must not disturb the edit in progress.
    act(() => result.current.handleQueueRemove(first.id));
    expect(result.current.input).toBe('second');
    expect(result.current.editingIndex).toBe(0);

    // Removing the card being edited hands the draft back.
    act(() => result.current.handleQueueRemove(second.id));
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
    expect(result.current.queue).toHaveLength(0);
  });

  it('arrow navigation walks the queue by position and hands the draft back at the end', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('first'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('second'));
    act(() => result.current.handleQueue());
    act(() => result.current.setInput('half-written thought'));

    act(() => result.current.handleQueueNavigateUp());
    expect(result.current.input).toBe('second');

    act(() => result.current.handleQueueNavigateUp());
    expect(result.current.input).toBe('first');

    act(() => result.current.handleQueueNavigateDown());
    expect(result.current.input).toBe('second');

    act(() => result.current.handleQueueNavigateDown());
    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });

  it('arrow navigation on an empty queue is inert', () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.setInput('half-written thought'));
    act(() => result.current.handleQueueNavigateUp());

    expect(result.current.input).toBe('half-written thought');
    expect(result.current.editingIndex).toBeNull();
  });
});
