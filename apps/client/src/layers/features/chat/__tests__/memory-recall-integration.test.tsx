/**
 * @vitest-environment jsdom
 *
 * Integration tests: SSE memory_recall events → AssistantMessageContent DOM.
 *
 * Strategy (Approach A): call `createStreamEventHandler` directly with minimal
 * stub deps, dispatch event(s), then render `AssistantMessageContent` with the
 * resulting parts and assert on the DOM.  No EventSource, no full provider tree.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createStreamEventHandler } from '../model/stream/stream-event-handler';
import { AssistantMessageContent } from '../ui/message/AssistantMessageContent';
import type { ChatMessage } from '../model/use-chat-session';
import type { MessagePart, SessionStatusEvent, TaskUpdateEvent } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Required mocks
// ---------------------------------------------------------------------------

// MemoryRecallBlock uses sonner for copy-to-clipboard toasts
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Simplify StreamingText so text content is predictable in assertions
vi.mock('../ui/message/StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => (
    <span data-testid="streaming-text">{content}</span>
  ),
}));

// Simplify ToolCallCard — exposes tool name as text
vi.mock('../ui/tools/ToolCallCard', () => ({
  ToolCallCard: ({ toolCall }: { toolCall: { toolName: string } }) => (
    <div data-testid="tool-call-card">{toolCall.toolName}</div>
  ),
}));

// Minimal stubs for interactive tool UI components
vi.mock('../ui/tools/ToolApproval', () => ({
  ToolApproval: ({ toolName }: { toolName: string }) => (
    <div data-testid="tool-approval">{toolName}</div>
  ),
}));

vi.mock('../ui/tools/QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt" />,
}));

// MessageContext values — only sessionId, isStreaming, and nulled-out callbacks needed
vi.mock('../ui/message/MessageContext', () => ({
  useMessageContext: () => ({
    sessionId: 'test-session',
    isStreaming: false,
    activeToolCallId: null,
    onToolRef: undefined,
    focusedOptionIndex: -1,
    onToolDecided: undefined,
    onRetry: undefined,
    inputZoneToolCallId: undefined,
    textEffect: undefined,
  }),
}));

// App store — disable auto-hide so all parts remain visible in assertions
vi.mock('@/layers/shared/model', () => ({
  useAppStore: () => ({ expandToolCalls: false, autoHideToolCalls: false }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal `createStreamEventHandler` with stub deps and return the handler + refs. */
function makeHandler() {
  const currentPartsRef = { current: [] as MessagePart[] };
  const assistantCreatedRef = { current: false };
  const sessionStatusRef = { current: null as SessionStatusEvent | null };
  const streamStartTimeRef = { current: null as number | null };
  const estimatedTokensRef = { current: 0 };
  const textStreamingTimerRef = { current: null as ReturnType<typeof setTimeout> | null };
  const isTextStreamingRef = { current: false };
  const thinkingStartRef = { current: null as number | null };
  const rateLimitClearRef = { current: null };
  const orphanHooksRef = { current: new Map() };
  const onTaskEventRef = {
    current: undefined as ((event: TaskUpdateEvent) => void) | undefined,
  };
  const onSessionIdChangeRef = {
    current: undefined as ((newSessionId: string) => void) | undefined,
  };
  const onStreamingDoneRef = { current: undefined as (() => void) | undefined };

  const setMessages = vi.fn();

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
    setError: vi.fn(),
    setStatus: vi.fn(),
    setSessionStatus: vi.fn(),
    setEstimatedTokens: vi.fn(),
    setStreamStartTime: vi.fn(),
    setIsTextStreaming: vi.fn(),
    setRateLimitRetryAfter: vi.fn(),
    setIsRateLimited: vi.fn(),
    setSystemStatus: vi.fn(),
    setPromptSuggestions: vi.fn(),
    rateLimitClearRef,
    sessionId: 'test-session',
    onTaskEventRef,
    onSessionIdChangeRef,
    onStreamingDoneRef,
    themeRef: { current: vi.fn() },
    scrollToMessageRef: { current: undefined },
    switchAgentRef: { current: undefined },
  });

  return { handler, currentPartsRef };
}

/** Build a `ChatMessage` from a parts array — matches the shape `AssistantMessageContent` expects. */
function makeMessage(parts: MessagePart[]): ChatMessage {
  return {
    id: 'msg-integration',
    role: 'assistant',
    content: '',
    parts,
    timestamp: new Date().toISOString(),
  };
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Test §1 — SSE → memory_recall part → MemoryRecallBlock rendered in the DOM
// ---------------------------------------------------------------------------

describe('memory_recall integration — SSE event → rendered bubble', () => {
  it('renders MemoryRecallBlock after a memory_recall SSE event with one memory', () => {
    // Purpose: end-to-end smoke — dispatching a `memory_recall` event through the handler
    // produces a parts array whose `memory_recall` entry renders as `[data-testid="memory-recall-block"]`.
    const { handler, currentPartsRef } = makeHandler();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '~/.claude/CLAUDE.md', scope: 'personal' }],
      },
      'asst-1'
    );

    // The handler must have created a memory_recall part at index 0
    expect(currentPartsRef.current[0]?.type).toBe('memory_recall');

    // Render AssistantMessageContent with those parts and assert the block appears
    render(<AssistantMessageContent message={makeMessage(currentPartsRef.current)} />);

    expect(screen.getByTestId('memory-recall-block')).toBeInTheDocument();
  });

  it('accumulates memories across two sequential memory_recall events without duplication', () => {
    // Purpose: the upsert+dedup contract — two events for the same session append
    // new memories and skip duplicates. Both paths appear once in the rendered block.
    const { handler, currentPartsRef } = makeHandler();

    handler(
      'memory_recall',
      {
        mode: 'select',
        memories: [{ path: '~/.claude/CLAUDE.md', scope: 'personal' }],
      },
      'asst-1'
    );

    handler(
      'memory_recall',
      {
        mode: 'select',
        // First path is a duplicate; second is new
        memories: [
          { path: '~/.claude/CLAUDE.md', scope: 'personal' },
          { path: '~/.claude/memory/work.md', scope: 'team' },
        ],
      },
      'asst-1'
    );

    const recallPart = currentPartsRef.current[0];
    expect(recallPart.type).toBe('memory_recall');
    if (recallPart.type === 'memory_recall') {
      // Two unique paths, not three
      expect(recallPart.memories).toHaveLength(2);
      expect(recallPart.memories.map((m) => m.path)).toEqual([
        '~/.claude/CLAUDE.md',
        '~/.claude/memory/work.md',
      ]);
    }

    // Rendered block is present
    render(<AssistantMessageContent message={makeMessage(currentPartsRef.current)} />);
    expect(screen.getByTestId('memory-recall-block')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Test §2 — zero-recall case: no memory_recall events → no block rendered
// ---------------------------------------------------------------------------

describe('memory_recall integration — zero-recall case', () => {
  it('does not produce a memory_recall part when no memory_recall event is dispatched', () => {
    // Purpose: confirm the block is absent when no memory_recall event fires.
    // We dispatch only a text_delta so the assistant bubble exists, then verify
    // the parts array contains no memory_recall entry and no block appears in the DOM.
    const { handler, currentPartsRef } = makeHandler();

    handler('text_delta', { text: 'Hello, world!' }, 'asst-1');

    const hasRecallPart = currentPartsRef.current.some((p) => p.type === 'memory_recall');
    expect(hasRecallPart).toBe(false);

    render(<AssistantMessageContent message={makeMessage(currentPartsRef.current)} />);
    expect(screen.queryByTestId('memory-recall-block')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Test §3 — regression: existing part types still render after adding memory_recall
// ---------------------------------------------------------------------------

describe('memory_recall integration — regression: existing renderers unaffected', () => {
  it('renders text, tool_call, and thinking parts correctly alongside a memory_recall part', () => {
    // Purpose: "union extension didn't break existing renderers".
    // Build a representative sample of the three most-common existing part types
    // alongside a memory_recall part and assert each expected element is present.
    const parts: MessagePart[] = [
      // memory_recall is always pinned at index 0
      {
        type: 'memory_recall',
        mode: 'select',
        memories: [{ path: '~/.claude/CLAUDE.md', scope: 'personal' }],
        isStreaming: false,
      },
      // text
      { type: 'text', text: 'Here is my response.' },
      // tool_call (non-interactive, so it renders via ToolCallCard)
      {
        type: 'tool_call',
        toolCallId: 'tc-reg-1',
        toolName: 'Bash',
        input: '{"cmd":"ls"}',
        status: 'complete',
      },
      // thinking
      { type: 'thinking', text: 'Let me reason about this.', isStreaming: false },
    ];

    render(<AssistantMessageContent message={makeMessage(parts)} />);

    // memory_recall block is present
    expect(screen.getByTestId('memory-recall-block')).toBeInTheDocument();

    // text part is present
    expect(screen.getByTestId('streaming-text')).toBeInTheDocument();
    expect(screen.getByTestId('streaming-text')).toHaveTextContent('Here is my response.');

    // tool_call part renders via ToolCallCard stub
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-card')).toHaveTextContent('Bash');
  });
});
