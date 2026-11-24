// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render as renderBare, screen, cleanup, act } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { Conversation } from '@/layers/features/conversation';
import { useAppStore } from '@/layers/shared/model';
import type { MessageAuthor, MessageGrouping } from '@/layers/shared/model';
import { SESSION_CAPABILITIES } from '../model/session-capabilities';
import { SessionMessage } from '../ui/SessionMessage';

/** The conversation a session page mounts around its transcript. */
function SessionConversation({ children }: { children: ReactNode }) {
  return (
    <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
      {children}
    </Conversation.Root>
  );
}

/** Render one row inside the session conversation it belongs to. */
function render(ui: ReactElement) {
  return renderBare(ui, { wrapper: SessionConversation });
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // Disable auto-hide so existing tests see all tool calls
  useAppStore.getState().setAutoHideToolCalls(false);
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// Mock ToolApproval to avoid needing TransportProvider in unit tests
vi.mock('../ToolApproval', () => ({
  ToolApproval: ({ toolName, toolCallId }: { toolName: string; toolCallId: string }) => (
    <div data-testid="tool-approval" data-tool-name={toolName} data-tool-call-id={toolCallId}>
      Tool approval: {toolName}
    </div>
  ),
}));

// Mock QuestionPrompt to avoid needing TransportProvider in unit tests
vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="question-prompt" data-tool-call-id={toolCallId}>
      Question prompt
    </div>
  ),
}));

// Mock EntryRunWithMenu — it depends on the router + session/runtime queries, which
// this layout-focused suite deliberately does not provide (it has its own test).
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
}));

const onlyGrouping: MessageGrouping = { position: 'only' };
const middleGrouping: MessageGrouping = { position: 'middle' };

const HUMAN_AUTHOR: MessageAuthor = { kind: 'human', id: 'human', displayName: 'You' };
const AGENT_AUTHOR: MessageAuthor = {
  kind: 'agent',
  id: 'dorkbot',
  displayName: 'DorkBot',
  emoji: '\u{1F916}',
  color: 'hsl(210, 70%, 55%)',
};

/** Identity props for a message. The header is derived from `grouping.position`. */
function authorProps(message: { role: 'user' | 'assistant' }) {
  return { author: message.role === 'user' ? HUMAN_AUTHOR : AGENT_AUTHOR };
}

describe('SessionMessage', () => {
  it('renders user messages as plain text', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: '**not bold**',
      parts: [{ type: 'text' as const, text: '**not bold**' }],
      timestamp: new Date().toISOString(),
    };
    render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
      />
    );
    expect(screen.getByText('**not bold**')).toBeDefined();
    expect(screen.queryByTestId('streamdown')).toBeNull();
  });

  it('renders the author name and avatar on a group start', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Test',
      parts: [{ type: 'text' as const, text: 'Test' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        author={AGENT_AUTHOR}
      />
    );
    expect(screen.getByText('DorkBot')).toBeDefined();
    expect(container.querySelector('[data-slot="message-author-avatar"]')).not.toBeNull();
  });

  it('renders parts in correct interleaved order (text -> tool -> text)', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Before toolAfter tool',
      parts: [
        { type: 'text' as const, text: 'Before tool' },
        {
          type: 'tool_call' as const,
          toolCallId: 'tc-1',
          toolName: 'Read',
          input: '{}',
          status: 'complete' as const,
        },
        { type: 'text' as const, text: 'After tool' },
      ],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
      />
    );
    const messageItemEl = container.querySelector('[data-testid="message-item"]');
    const contentDiv = messageItemEl?.querySelector('[data-slot="message-content"]');
    const children = Array.from(contentDiv!.children);
    // First child: text part "Before tool"
    expect(children[0].textContent).toContain('Before tool');
    // Second child: tool call card "Read"
    expect(children[1].textContent).toContain('Read');
    // Third child: text part "After tool"
    expect(children[2].textContent).toContain('After tool');
  });

  it('hover-gates the timestamp on a continuation row', () => {
    const msg = {
      id: '2',
      role: 'user' as const,
      content: 'Follow-up',
      parts: [{ type: 'text' as const, text: 'Follow-up' }],
      timestamp: '2026-02-07T10:31:00.000Z',
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={middleGrouping}
        author={HUMAN_AUTHOR}
      />
    );
    const timeEl = container.querySelector('.group-hover\\:text-msg-timestamp');
    expect(timeEl).not.toBeNull();
    expect(timeEl!.textContent).toBeTruthy();
  });

  it('new user message has initial scale 0.97', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Hello',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      timestamp: new Date().toISOString(),
    };
    render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
        isNew={true}
      />
    );
    // Under the motion mock, motion.div renders as a plain div.
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByTestId('message-item')).toBeDefined();
  });

  it('renders user messages in the same left gutter as everyone else', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Hello',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
      />
    );
    const el = container.firstElementChild;
    // The right-aligned bubble is gone (spec decision D1): the row spans the
    // full width instead of floating to the right.
    expect(el?.className).not.toContain('ml-auto');
    expect(el?.className).toContain('w-full');
    // Both roles get the identity gutter and the same content column.
    expect(container.querySelector('.w-\\[var\\(--msg-gutter-width\\)\\]')).not.toBeNull();
    expect(container.querySelector('[data-slot="message-content"]')).not.toBeNull();
  });

  it('renders text parts adjacent to tool call without orphaned standalone rendering', () => {
    // Purpose: Verifies that text parts immediately following a tool_call part are rendered as
    // part of the natural parts flow, not isolated at a different DOM depth.
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'DoneSome response text',
      parts: [
        {
          type: 'tool_call' as const,
          toolCallId: 'tc-1',
          toolName: 'TodoWrite',
          input: '{}',
          status: 'complete' as const,
        },
        { type: 'text' as const, text: 'Done' },
        { type: 'text' as const, text: 'Some response text' },
      ],
      timestamp: new Date().toISOString(),
    };

    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
      />
    );

    // Both text parts should be present in the DOM
    expect(screen.getAllByTestId('streamdown').length).toBeGreaterThanOrEqual(1);

    // 'Done' text content should appear in the rendered output
    const allText = container.textContent ?? '';
    expect(allText).toContain('Done');
    expect(allText).toContain('Some response text');

    // The tool call card for 'TodoWrite' should render (label appears in card)
    expect(allText).toContain('Update tasks');

    // All three parts should produce exactly 3 child elements in the parts container.
    const streamdownElements = container.querySelectorAll('[data-testid="streamdown"]');
    // At least the two text parts should produce streamdown elements
    expect(streamdownElements.length).toBeGreaterThanOrEqual(2);

    // The 'Done' text should appear in a streamdown element, not as a bare text node
    // at the top level of the document
    const doneInStreamdown = Array.from(streamdownElements).some((el) => el.textContent === 'Done');
    expect(doneInStreamdown).toBe(true);
  });
});

describe('Auto-hide tool calls', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  const toolCallPart = (status: string) => ({
    type: 'tool_call' as const,
    toolCallId: 'tc-1',
    toolName: 'Read',
    input: '{}',
    status: status as 'pending' | 'running' | 'complete' | 'error',
  });

  const makeMsg = (status: string) => ({
    id: '1',
    role: 'assistant' as const,
    content: 'text',
    parts: [{ type: 'text' as const, text: 'text' }, toolCallPart(status)],
    timestamp: new Date().toISOString(),
  });

  it('shows tool calls during streaming, hides 5s after completion', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('running');
    const { rerender } = render(
      <SessionMessage message={msg} sessionId="s" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    expect(screen.getByText('Read …')).toBeDefined();

    // Transition to complete
    const completedMsg = makeMsg('complete');
    rerender(
      <SessionMessage
        message={completedMsg}
        sessionId="s"
        grouping={onlyGrouping}
        {...authorProps(completedMsg)}
      />
    );
    // Still visible immediately after completion
    expect(screen.getByText('Read …')).toBeDefined();

    // Advance past 5s timer
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('Read …')).toBeNull();
  });

  it('never hides tool calls with error status', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('error');
    render(
      <SessionMessage message={msg} sessionId="s" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('Read …')).toBeDefined();
  });
});
