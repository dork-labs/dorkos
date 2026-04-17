import { describe, it, expect, vi } from 'vitest';
import { createStreamEventHandler } from '../stream/stream-event-handler';
import type {
  MessagePart,
  MemoryRecallEvent,
  SessionStatusEvent,
  TaskUpdateEvent,
} from '@dorkos/shared/types';

function createMinimalDeps() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const assistantCreatedRef = { current: false };
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const isTextStreamingRef = { current: false };
  const thinkingStartRef = { current: null as number | null };
  const setMessages = vi.fn();
  const setError = vi.fn();
  const setStatus = vi.fn();
  const setSessionStatus = vi.fn();
  const setEstimatedTokens = vi.fn();
  const setStreamStartTime = vi.fn();
  const setIsTextStreaming = vi.fn();
  const setRateLimitRetryAfter = vi.fn();
  const setIsRateLimited = vi.fn();
  const setSystemStatus = vi.fn();
  const rateLimitClearRef = { current: null };
  const orphanHooksRef = { current: new Map() };
  const onTaskEventRef = { current: undefined as ((event: TaskUpdateEvent) => void) | undefined };
  const onSessionIdChangeRef = {
    current: undefined as ((newSessionId: string) => void) | undefined,
  };
  const onStreamingDoneRef = { current: undefined as (() => void) | undefined };

  const handler = createStreamEventHandler({
    currentPartsRef,
    orphanHooksRef,
    assistantCreatedRef,
    sessionStatusRef,
    streamStartTimeRef,
    estimatedTokensRef,
    textStreamingTimerRef,
    isTextStreamingRef,
    thinkingStartRef,
    setMessages,
    setError,
    setStatus,
    setSessionStatus,
    setEstimatedTokens,
    setStreamStartTime,
    setIsTextStreaming,
    setRateLimitRetryAfter,
    setIsRateLimited,
    setSystemStatus,
    setPromptSuggestions: vi.fn(),
    rateLimitClearRef,
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    onRemapRef: { current: undefined },
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef, setMessages };
}

describe('stream-event-handler — memory_recall', () => {
  it('creates a memory_recall part at index 0 on first event with isStreaming: true', () => {
    // Purpose: The first memory_recall event should insert a new part at
    // index 0 of the assistant bubble with isStreaming: true — mirrors the
    // thinking_delta pattern so the UI can show a live "recalling" indicator.
    const { handler, currentPartsRef } = createMinimalDeps();

    const event: MemoryRecallEvent = {
      mode: 'select',
      memories: [{ path: '/home/user/.claude/CLAUDE.md', scope: 'personal' }],
    };
    handler('memory_recall', event, 'asst-1');

    expect(currentPartsRef.current).toHaveLength(1);
    const first = currentPartsRef.current[0];
    expect(first.type).toBe('memory_recall');
    if (first.type === 'memory_recall') {
      expect(first.isStreaming).toBe(true);
      expect(first.mode).toBe('select');
      expect(first.memories).toHaveLength(1);
      expect(first.memories[0].path).toBe('/home/user/.claude/CLAUDE.md');
      expect(first.memories[0].scope).toBe('personal');
    }
  });

  it('appends new memories on subsequent events in the same turn', () => {
    // Purpose: A second memory_recall event in the same turn should merge its
    // memories into the existing part at index 0, preserving order.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '/a/CLAUDE.md', scope: 'personal' }],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );
    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '/b/TEAM.md', scope: 'team' }],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    expect(currentPartsRef.current).toHaveLength(1);
    const first = currentPartsRef.current[0];
    expect(first.type).toBe('memory_recall');
    if (first.type === 'memory_recall') {
      expect(first.memories).toHaveLength(2);
      expect(first.memories.map((m) => m.path)).toEqual(['/a/CLAUDE.md', '/b/TEAM.md']);
      expect(first.memories[1].scope).toBe('team');
    }
  });

  it('deduplicates memories by path across sequential events', () => {
    // Purpose: If the SDK surfaces the same memory file twice within a turn,
    // the second occurrence should be dropped — no duplicate entries render.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [
          { path: '/a/CLAUDE.md', scope: 'personal' },
          { path: '/b/TEAM.md', scope: 'team' },
        ],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );
    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [
          { path: '/a/CLAUDE.md', scope: 'personal' },
          { path: '/c/EXTRA.md', scope: 'personal' },
        ],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    const first = currentPartsRef.current[0];
    expect(first.type).toBe('memory_recall');
    if (first.type === 'memory_recall') {
      const paths = first.memories.map((m) => m.path);
      expect(paths).toEqual(['/a/CLAUDE.md', '/b/TEAM.md', '/c/EXTRA.md']);
    }
  });

  it('deduplicates memories by path within a single incoming event batch', () => {
    // Purpose: If the SDK ever emits a malformed event with duplicate paths
    // in one batch, the part should still render each unique path once.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [
          { path: '/a/CLAUDE.md', scope: 'personal' },
          { path: '/a/CLAUDE.md', scope: 'personal' },
          { path: '/b/TEAM.md', scope: 'team' },
        ],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    const first = currentPartsRef.current[0];
    expect(first.type).toBe('memory_recall');
    if (first.type === 'memory_recall') {
      expect(first.memories).toHaveLength(2);
      expect(first.memories.map((m) => m.path)).toEqual(['/a/CLAUDE.md', '/b/TEAM.md']);
    }
  });

  it('re-homes pre-existing parts to index ≥ 1 when memory_recall arrives after other content', () => {
    // Purpose: If a text_delta or other event created parts before the
    // memory_recall arrives, the recall part must still be pinned at index 0
    // with the pre-existing parts pushed down.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler('text_delta', { text: 'Hello ' }, 'asst-1');
    handler('text_delta', { text: 'world' }, 'asst-1');
    expect(currentPartsRef.current).toHaveLength(1);
    expect(currentPartsRef.current[0].type).toBe('text');

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '/a/CLAUDE.md', scope: 'personal' }],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    expect(currentPartsRef.current).toHaveLength(2);
    expect(currentPartsRef.current[0].type).toBe('memory_recall');
    expect(currentPartsRef.current[1].type).toBe('text');
  });

  it('preserves mode and synthesis content for synthesize-mode events', () => {
    // Purpose: In 'synthesize' mode the SDK sends a synthesis paragraph in
    // `content`; the part must carry both the mode and the content through.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'synthesize',
        memories: [
          {
            path: '<synthesis:/home/user>',
            scope: 'personal',
            content: 'User prefers TypeScript and terse commit messages.',
          },
        ],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    const first = currentPartsRef.current[0];
    expect(first.type).toBe('memory_recall');
    if (first.type === 'memory_recall') {
      expect(first.mode).toBe('synthesize');
      expect(first.memories[0].content).toBe('User prefers TypeScript and terse commit messages.');
      expect(first.memories[0].path).toBe('<synthesis:/home/user>');
    }
  });

  it('finalizes memory_recall isStreaming to false on done event', () => {
    // Purpose: The done handler must flip isStreaming to false so the
    // MemoryRecallBlock can auto-collapse — mirrors thinking finalization.
    const { handler, currentPartsRef } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '/a/CLAUDE.md', scope: 'personal' }],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );
    const beforeDone = currentPartsRef.current[0];
    expect(beforeDone.type).toBe('memory_recall');
    if (beforeDone.type === 'memory_recall') {
      expect(beforeDone.isStreaming).toBe(true);
    }

    handler('done', { sessionId: 'test-session' }, 'asst-1');

    const afterDone = currentPartsRef.current[0];
    expect(afterDone.type).toBe('memory_recall');
    if (afterDone.type === 'memory_recall') {
      expect(afterDone.isStreaming).toBe(false);
    }
  });

  it('calls setMessages to plumb the memory_recall part into React state', () => {
    // Purpose: The handler invokes updateAssistantMessage after the upsert,
    // which ensures the assistant bubble exists AND flushes the new parts to
    // React state. Verifies the plumbing fires at least once.
    const { handler, setMessages } = createMinimalDeps();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '/a/CLAUDE.md', scope: 'personal' }],
      } satisfies MemoryRecallEvent,
      'asst-1'
    );

    expect(setMessages).toHaveBeenCalled();
  });
});
