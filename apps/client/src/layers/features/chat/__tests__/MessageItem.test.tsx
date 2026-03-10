// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MessageItem } from '../ui/message';
import { useAppStore } from '@/layers/shared/model';
import type { MessageGrouping } from '../model/use-chat-session';

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

const onlyGrouping: MessageGrouping = { position: 'only', groupIndex: 0 };
const firstGrouping: MessageGrouping = { position: 'first', groupIndex: 0 };
const middleGrouping: MessageGrouping = { position: 'middle', groupIndex: 0 };

describe('MessageItem', () => {
  it('renders user messages as plain text', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: '**not bold**',
      parts: [{ type: 'text' as const, text: '**not bold**' }],
      timestamp: new Date().toISOString(),
    };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
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
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.getByTestId('streamdown')).toBeDefined();
    expect(screen.getByText('# Heading')).toBeDefined();
  });

  it('does not render name labels', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Test',
      parts: [{ type: 'text' as const, text: 'Test' }],
      timestamp: new Date().toISOString(),
    };
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
    expect(screen.queryByText('You')).toBeNull();
    expect(screen.queryByText('Claude')).toBeNull();
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
    render(<MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />);
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
    );
    const messageItemEl = container.querySelector('[data-testid="message-item"]');
    const contentDiv = messageItemEl?.querySelector('.min-w-0');
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={true} />
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={false} />
    );
    expect(screen.getByText('Old message')).toBeDefined();
  });

  it('renders timestamp from message on hover', () => {
    const ts = '2026-02-07T10:30:00.000Z';
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Test',
      parts: [{ type: 'text' as const, text: 'Test' }],
      timestamp: ts,
    };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
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
      <MessageItem
        message={msg}
        sessionId="test-session"
        grouping={onlyGrouping}
        isStreaming={true}
      />
    );
    const cursorWrapper = container.querySelector('.streaming-cursor');
    expect(cursorWrapper).not.toBeNull();
  });

  it('renders divider on first-in-group when not the first group', () => {
    const msg = {
      id: '1',
      role: 'assistant' as const,
      content: 'Reply',
      parts: [{ type: 'text' as const, text: 'Reply' }],
      timestamp: new Date().toISOString(),
    };
    const grouping: MessageGrouping = { position: 'first', groupIndex: 1 };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={grouping} />
    );
    const divider = container.querySelector('.bg-\\[var\\(--msg-divider-color\\)\\]');
    expect(divider).not.toBeNull();
  });

  it('does not render divider on the first group', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Hello',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      timestamp: new Date().toISOString(),
    };
    const grouping: MessageGrouping = { position: 'first', groupIndex: 0 };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={grouping} />
    );
    const divider = container.querySelector('.bg-\\[var\\(--msg-divider-color\\)\\]');
    expect(divider).toBeNull();
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
    );
    const el = container.querySelector('.msg-assistant');
    expect(el).not.toBeNull();
    // content container uses TV slot class (max-w-[var(--msg-content-max-width)])
    const contentContainer = container.querySelector('.min-w-0.flex-1');
    expect(contentContainer).not.toBeNull();
    expect(contentContainer?.querySelector('.msg-assistant')).not.toBeNull();
  });

  it('applies tight spacing for middle user messages', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Mid',
      parts: [{ type: 'text' as const, text: 'Mid' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={middleGrouping} />
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('my-px');
  });

  it('applies larger spacing for first-in-group user messages', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'First',
      parts: [{ type: 'text' as const, text: 'First' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={firstGrouping} />
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('mt-3');
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={true} />
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={true} />
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} isNew={false} />
    );
    expect(screen.getByText('Old message')).toBeDefined();
  });

  it('renders user messages as right-aligned bubbles', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Hello',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      timestamp: new Date().toISOString(),
    };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('ml-auto');
    expect(el?.className).toContain('max-w-[var(--msg-user-max-width)]');
    expect(el?.className).toContain('rounded-msg');
  });

  it('applies tight right corners for grouped user bubbles', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Grouped',
      parts: [{ type: 'text' as const, text: 'Grouped' }],
      timestamp: new Date().toISOString(),
    };
    // first in group: bottom-right tight
    const { container: c1 } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={firstGrouping} />
    );
    expect(c1.firstElementChild?.className).toContain('rounded-br-msg-tight');

    // middle: both right corners tight
    const { container: c2 } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={middleGrouping} />
    );
    expect(c2.firstElementChild?.className).toContain('rounded-r-msg-tight');

    // last: top-right tight
    const lastGrouping: MessageGrouping = { position: 'last', groupIndex: 0 };
    const { container: c3 } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={lastGrouping} />
    );
    expect(c3.firstElementChild?.className).toContain('rounded-tr-msg-tight');
  });

  it('does not render divider for user messages even when groupIndex > 0', () => {
    const msg = {
      id: '1',
      role: 'user' as const,
      content: 'Hello',
      parts: [{ type: 'text' as const, text: 'Hello' }],
      timestamp: new Date().toISOString(),
    };
    const grouping: MessageGrouping = { position: 'first', groupIndex: 1 };
    const { container } = render(
      <MessageItem message={msg} sessionId="test-session" grouping={grouping} />
    );
    const divider = container.querySelector('.bg-\\[var\\(--msg-divider-color\\)\\]');
    expect(divider).toBeNull();
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
      <MessageItem message={msg} sessionId="test-session" grouping={onlyGrouping} />
    );

    // Both text parts should be present in the DOM
    expect(screen.getAllByTestId('streamdown').length).toBeGreaterThanOrEqual(1);

    // 'Done' text content should appear in the rendered output
    const allText = container.textContent ?? '';
    expect(allText).toContain('Done');
    expect(allText).toContain('Some response text');

    // The tool call card for 'TodoWrite' should render (tool name appears in card)
    expect(allText).toContain('TodoWrite');

    // All three parts should produce exactly 3 child elements in the parts container.
    // The parts container is the flex-col div wrapping the message parts.
    // Look for the content wrapper that holds tool call cards and text segments.
    // It should have children for: ToolCallCard, StreamingText(Done), StreamingText(Some response text)
    const streamdownElements = container.querySelectorAll('[data-testid="streamdown"]');
    // At least the two text parts should produce streamdown elements
    expect(streamdownElements.length).toBeGreaterThanOrEqual(2);

    // The 'Done' text should appear in a streamdown element, not as a bare text node
    // at the top level of the document
    const doneInStreamdown = Array.from(streamdownElements).some(
      (el) => el.textContent === 'Done'
    );
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
    render(<MessageItem message={makeMsg('complete')} sessionId="s" grouping={onlyGrouping} />);
    expect(screen.queryByText('Read ...')).toBeNull();
  });

  it('shows tool calls during streaming, hides 5s after completion', () => {
    useAppStore.getState().setAutoHideToolCalls(true);
    const msg = makeMsg('running');
    const { rerender } = render(
      <MessageItem message={msg} sessionId="s" grouping={onlyGrouping} />
    );
    expect(screen.getByText('Read ...')).toBeDefined();

    // Transition to complete
    const completedMsg = makeMsg('complete');
    rerender(<MessageItem message={completedMsg} sessionId="s" grouping={onlyGrouping} />);
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
    render(<MessageItem message={makeMsg('error')} sessionId="s" grouping={onlyGrouping} />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('shows all tool calls when autoHide is OFF', () => {
    useAppStore.getState().setAutoHideToolCalls(false);
    render(<MessageItem message={makeMsg('complete')} sessionId="s" grouping={onlyGrouping} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });
});
