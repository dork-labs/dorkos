/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { AssistantMessageContent } from '../AssistantMessageContent';
import type { ChatMessage } from '../../../model/use-chat-session';

// Mock StreamingText to simplify rendering
vi.mock('../StreamingText', () => ({
  StreamingText: ({ content }: { content: string }) => (
    <span data-testid="streaming-text">{content}</span>
  ),
}));

// Mock ToolCallCard — expose timestamps as data attrs for passthrough assertions
vi.mock('../../tools/ToolCallCard', () => ({
  ToolCallCard: ({
    toolCall,
  }: {
    toolCall: { toolName: string; startedAt?: number; completedAt?: number };
  }) => (
    <div
      data-testid="tool-call-card"
      data-started-at={toolCall.startedAt ?? ''}
      data-completed-at={toolCall.completedAt ?? ''}
    >
      {toolCall.toolName}
    </div>
  ),
}));

// Mock ToolApproval
vi.mock('../../tools/ToolApproval', () => ({
  ToolApproval: ({ toolName }: { toolName: string }) => (
    <div data-testid="tool-approval">{toolName}</div>
  ),
}));

// Mock QuestionPrompt
vi.mock('../../tools/QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt" />,
}));

// Mock MessageContext
vi.mock('../MessageContext', () => ({
  useMessageContext: () => ({
    sessionId: 'test-session',
    isStreaming: false,
    activeToolCallId: null,
    onToolRef: undefined,
    focusedOptionIndex: -1,
    onToolDecided: undefined,
  }),
}));

// Mock useAppStore
vi.mock('@/layers/shared/model', () => ({
  useAppStore: () => ({ expandToolCalls: false, autoHideToolCalls: false }),
}));

function makeMessage(parts: ChatMessage['parts']): ChatMessage {
  return {
    id: 'msg-1',
    role: 'assistant',
    content: '',
    parts: parts ?? [],
    timestamp: new Date().toISOString(),
  };
}

describe('AssistantMessageContent — multi-block part rendering', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders interleaved text and tool_call parts in order', () => {
    // Text parts key by index (`text-${i}`) — the client-only `_partId` died
    // with the legacy stream handler (spec chat-stream-reconnection, #18).
    const parts = [
      { type: 'text' as const, text: 'First block' },
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: '{}',
        status: 'complete' as const,
      },
      { type: 'text' as const, text: 'Second block' },
    ];

    render(<AssistantMessageContent message={makeMessage(parts)} />);

    expect(screen.getByText('First block')).toBeInTheDocument();
    expect(screen.getByText('Second block')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-card')).toBeInTheDocument();
  });
});

describe('AssistantMessageContent — compaction & local-command parts (DOR-118)', () => {
  afterEach(() => {
    cleanup();
  });

  it('dispatches a compact_boundary part to the compaction row', () => {
    const parts = [
      {
        type: 'compact_boundary' as const,
        trigger: 'manual' as const,
        preTokens: 52000,
        postTokens: 8000,
      },
    ];
    render(<AssistantMessageContent message={makeMessage(parts)} />);
    expect(screen.getByTestId('compact-boundary-row')).toBeInTheDocument();
    expect(screen.getByText('Compacted context — 52.0k → 8.0k tokens')).toBeInTheDocument();
  });
});

describe('AssistantMessageContent — timestamp passthrough', () => {
  afterEach(() => {
    cleanup();
  });

  it('passes startedAt and completedAt from tool_call part to ToolCallCard', () => {
    const parts = [
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-timing',
        toolName: 'Read',
        input: '{"file":"test.ts"}',
        status: 'complete' as const,
        startedAt: 1000,
        completedAt: 2234,
      },
    ];

    const { getByTestId } = render(<AssistantMessageContent message={makeMessage(parts)} />);

    const card = getByTestId('tool-call-card');
    expect(card).toHaveAttribute('data-started-at', '1000');
    expect(card).toHaveAttribute('data-completed-at', '2234');
  });

  it('passes undefined timestamps without error', () => {
    const parts = [
      {
        type: 'tool_call' as const,
        toolCallId: 'tc-no-timing',
        toolName: 'Bash',
        input: '{"cmd":"ls"}',
        status: 'running' as const,
      },
    ];

    const { getByTestId } = render(<AssistantMessageContent message={makeMessage(parts)} />);

    const card = getByTestId('tool-call-card');
    // When timestamps are undefined, data attrs render as empty string
    expect(card).toHaveAttribute('data-started-at', '');
    expect(card).toHaveAttribute('data-completed-at', '');
  });
});
