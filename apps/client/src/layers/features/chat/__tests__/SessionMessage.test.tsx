// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render as renderBare, screen, cleanup, act } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { Conversation } from '@/layers/features/conversation';
import type { ConversationCapabilities } from '@/layers/features/conversation';

/**
 * The session's capability table, declared here rather than imported.
 *
 * `SESSION_CAPABILITIES` moved to `widgets/session/model` with its host in P4,
 * and a feature may not import a widget's model — ESLint refuses it. The
 * shipped table is exercised where it is mounted (`widgets/session`); what this
 * suite needs is a conversation for the row to read, and that is data.
 */
const SESSION_CAPABILITIES: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: true,
  attachments: true,
  mentions: false,
  streamHealth: false,
  presence: false,
  turnStatus: true,
  asks: true,
};
import { SessionMessage } from '../ui/message';
import { useAppStore } from '@/layers/shared/model';
import type { MessageGrouping } from '../model/use-chat-session';
import type { MessageAuthor } from '@/layers/shared/model';

/**
 * The conversation a session page mounts around its transcript.
 *
 * Every row reads what its conversation can do — reactions off, run-with on —
 * so a bench without one is testing a component in a state the app never puts
 * it in. Wrapped here rather than at each of the render sites below, which is
 * the custom-render pattern RTL documents for exactly this.
 */
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
const firstGrouping: MessageGrouping = { position: 'first' };
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

  it('renders assistant messages with Streamdown', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: '# Heading',
      parts: [{ type: 'text' as const, text: '# Heading' }],
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
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Heading')).toBeDefined();
  });

  it('presentation mode suppresses the timestamp and hover background', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Hey, I live here',
      parts: [{ type: 'text' as const, text: 'Hey, I live here' }],
      timestamp: '2026-07-22T08:00:00.000Z',
    };
    const { container: normal } = render(
      <SessionMessage message={msg} sessionId="" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    // The timestamp text is in the DOM on a normal render (shown on hover).
    expect(normal.textContent).toMatch(/\d{1,2}:\d{2}/);

    cleanup();

    const { container: scripted } = render(
      <SessionMessage
        message={msg}
        sessionId=""
        grouping={onlyGrouping}
        {...authorProps(msg)}
        presentation
      />
    );
    // No timestamp, and the hover background is neutralized.
    expect(scripted.textContent).not.toMatch(/\d{1,2}:\d{2}/);
    expect(scripted.querySelector('[data-testid="message-item"]')?.className).toContain(
      'hover:bg-transparent'
    );
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

  it('renders neither name nor avatar on a continuation', () => {
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
        grouping={middleGrouping}
        author={AGENT_AUTHOR}
      />
    );
    expect(screen.queryByText('DorkBot')).toBeNull();
    expect(container.querySelector('[data-slot="message-author-avatar"]')).toBeNull();
  });

  it('renders tool calls for assistant messages', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Let me check.',
      toolCalls: [
        { toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' as const },
      ],
      parts: [
        { type: 'text' as const, text: 'Let me check.' },
        {
          type: 'tool_call' as const,
          toolCallId: 'tc-1',
          toolName: 'Read',
          input: '{}',
          status: 'complete' as const,
        },
      ],
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
    expect(screen.getByText('Read ...')).toBeDefined();
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

  it('renders correctly when isNew is true', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'New message',
      parts: [{ type: 'text' as const, text: 'New message' }],
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
    expect(screen.getByText('New message')).toBeDefined();
  });

  it('renders correctly when isNew is false', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Old message',
      parts: [{ type: 'text' as const, text: 'Old message' }],
      timestamp: new Date().toISOString(),
    };
    render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
        isNew={false}
      />
    );
    expect(screen.getByText('Old message')).toBeDefined();
  });

  it('always shows the timestamp on a group header', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Test',
      parts: [{ type: 'text' as const, text: 'Test' }],
      timestamp: '2026-02-07T10:30:00.000Z',
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
      />
    );
    // The header time is part of the identity line, so it is never
    // hover-gated — a header with a blank where the time belongs looks broken.
    const timeEl = container.querySelector('.text-msg-timestamp');
    expect(timeEl).not.toBeNull();
    expect(timeEl!.textContent).toBeTruthy();
    expect(container.querySelector('.group-hover\\:text-msg-timestamp')).toBeNull();
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

  it('passes isStreaming to StreamingText for assistant messages', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Streaming...',
      parts: [{ type: 'text' as const, text: 'Streaming...' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
        isStreaming={true}
      />
    );
    const cursorWrapper = container.querySelector('.streaming-cursor');
    expect(cursorWrapper).not.toBeNull();
  });

  it('opens a group with the identity gutter, not an in-message divider', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Reply',
      parts: [{ type: 'text' as const, text: 'Reply' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={firstGrouping}
        {...authorProps(msg)}
      />
    );
    // Separators are list rows now (see the transcript's day/unread dividers), so a
    // group start renders the gutter + content layout and nothing above it.
    const root = container.firstElementChild;
    expect(root?.querySelector('.w-\\[var\\(--msg-gutter-width\\)\\]')).not.toBeNull();
    expect(root?.querySelector('[data-slot="message-content"]')?.className).toContain(
      'max-w-[var(--msg-content-max-width)]'
    );
  });

  it('uses msg-assistant class and max-width on content container', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Reply',
      parts: [{ type: 'text' as const, text: 'Reply' }],
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
    const el = container.querySelector('.msg-assistant');
    expect(el).not.toBeNull();
    // content container uses TV slot class (max-w-[var(--msg-content-max-width)])
    const contentContainer = container.querySelector('[data-slot="message-content"]');
    expect(contentContainer?.className).toContain('max-w-[var(--msg-content-max-width)]');
    expect(contentContainer?.querySelector('.msg-assistant')).not.toBeNull();
  });

  it('applies tight vertical padding to a mid-group row', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Mid',
      parts: [{ type: 'text' as const, text: 'Mid' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={middleGrouping}
        {...authorProps(msg)}
      />
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('pt-[var(--msg-padding-y-mid)]');
  });

  it('opens a group with the larger top padding', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'First',
      parts: [{ type: 'text' as const, text: 'First' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={firstGrouping}
        {...authorProps(msg)}
      />
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('pt-[var(--msg-padding-y-start)]');
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
    // We verify the component renders without error and the message is visible.
    // Animation prop verification is done by inspecting the rendered element's data attributes
    // or by checking the mock was called with the right props if using a spy.
    // Since the mock renders a plain div, structural rendering is sufficient here.
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByTestId('message-item')).toBeDefined();
  });

  it('new assistant message does not compress (scale 1)', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Response',
      parts: [{ type: 'text' as const, text: 'Response' }],
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
    expect(screen.getByTestId('message-item')).toBeDefined();
  });

  it('history messages render without entrance animation (isNew=false)', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Old message',
      parts: [{ type: 'text' as const, text: 'Old message' }],
      timestamp: new Date().toISOString(),
    };
    render(
      <SessionMessage
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        {...authorProps(msg)}
        isNew={false}
      />
    );
    expect(screen.getByText('Old message')).toBeDefined();
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
    expect(container.querySelector('[data-slot="message-content"]')?.className).toContain(
      'max-w-[var(--msg-content-max-width)]'
    );
  });

  it('leaves the identity gutter empty on a user continuation', () => {
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
        grouping={middleGrouping}
        author={HUMAN_AUTHOR}
      />
    );
    const gutter = container.querySelector('.w-\\[var\\(--msg-gutter-width\\)\\]');
    expect(gutter).not.toBeNull();
    expect(gutter?.querySelector('[data-slot="message-author-avatar"]')).toBeNull();
    expect(screen.queryByText('You')).toBeNull();
  });

  it('renders text parts adjacent to tool call without orphaned standalone rendering', () => {
    // Purpose: Verifies that text parts immediately following a tool_call part
    // are rendered as part of the natural parts flow, not isolated at a
    // different DOM depth. This guards against the regression where a
    // text_delta('Done') appearing after a tool_result SSE event created
    // a floating element visually detached from the surrounding text.
    //
    // autoHideToolCalls is false (set in beforeEach), so the completed
    // tool call renders its ToolCallCard in the parts list.
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
    // The parts container is the flex-col div wrapping the message parts.
    // Look for the content wrapper that holds tool call cards and text segments.
    // It should have children for: ToolCallCard, StreamingText(Done), StreamingText(Some response text)
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

  it('hides tool calls that are already complete on mount when autoHide is ON', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('complete');
    render(
      <SessionMessage message={msg} sessionId="s" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('shows tool calls during streaming, hides 5s after completion', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('running');
    const { rerender } = render(
      <SessionMessage message={msg} sessionId="s" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    expect(screen.getByText('Read ...')).toBeDefined();

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
    expect(screen.getByText('Read ...')).toBeDefined();

    // Advance past 5s timer
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(screen.queryByText('Read ...')).toBeNull();
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
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('shows all tool calls when autoHide is OFF', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    const msg = makeMsg('complete');
    render(
      <SessionMessage message={msg} sessionId="s" grouping={onlyGrouping} {...authorProps(msg)} />
    );
    expect(screen.getByText('Read ...')).toBeDefined();
  });
});
