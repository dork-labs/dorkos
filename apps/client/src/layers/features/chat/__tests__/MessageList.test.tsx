// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList, computeGrouping, type MessageListHandle } from '../ui/MessageList';
import type { ChatMessage } from '../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';

// jsdom does not implement IntersectionObserver
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// jsdom does not implement ResizeObserver
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

afterEach(() => {
  cleanup();
  // Reset store to defaults between tests
  useAppStore.getState().resetPreferences();
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// Mock ToolApproval to avoid needing TransportProvider in unit tests
vi.mock('../ToolApproval', () => ({
  ToolApproval: ({ toolName }: { toolName: string }) => (
    <div data-testid="tool-approval">{toolName}</div>
  ),
}));

// Mock QuestionPrompt to avoid needing TransportProvider in unit tests
vi.mock('../QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt">Question prompt</div>,
}));

// Mock ScrollThumb to avoid scroll measurement in unit tests
vi.mock('../ui/ScrollThumb', () => ({
  ScrollThumb: () => null,
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        key: `virt-${i}`,
        index: i,
        start: i * 80,
        size: 80,
      })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

describe('computeGrouping', () => {
  it('returns empty array for empty messages', () => {
    expect(computeGrouping([])).toEqual([]);
  });

  it('marks a single message as "only"', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello', parts: [], timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([{ position: 'only', groupIndex: 0 }]);
  });

  it('marks alternating messages as "only" with incrementing groupIndex', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hi', parts: [], timestamp: '' },
      { id: '2', role: 'assistant', content: 'Hello', parts: [], timestamp: '' },
      { id: '3', role: 'user', content: 'Bye', parts: [], timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'only', groupIndex: 0 },
      { position: 'only', groupIndex: 1 },
      { position: 'only', groupIndex: 2 },
    ]);
  });

  it('marks consecutive same-role messages with first/middle/last', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', parts: [], timestamp: '' },
      { id: '2', role: 'user', content: 'B', parts: [], timestamp: '' },
      { id: '3', role: 'user', content: 'C', parts: [], timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'middle', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
    ]);
  });

  it('handles two consecutive messages as first/last', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'assistant', content: 'A', parts: [], timestamp: '' },
      { id: '2', role: 'assistant', content: 'B', parts: [], timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
    ]);
  });

  it('handles mixed groups correctly', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', parts: [], timestamp: '' },
      { id: '2', role: 'user', content: 'B', parts: [], timestamp: '' },
      { id: '3', role: 'assistant', content: 'C', parts: [], timestamp: '' },
      { id: '4', role: 'user', content: 'D', parts: [], timestamp: '' },
    ];
    const result = computeGrouping(messages);
    expect(result).toEqual([
      { position: 'first', groupIndex: 0 },
      { position: 'last', groupIndex: 0 },
      { position: 'only', groupIndex: 1 },
      { position: 'only', groupIndex: 2 },
    ]);
  });
});

describe('MessageList', () => {
  it('renders empty list without error', () => {
    const { container } = render(<MessageList sessionId="test-session" messages={[]} />);
    expect(container).toBeDefined();
  });

  it('renders user message content', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Hello world',
        parts: [{ type: 'text', text: 'Hello world' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hello world')).toBeDefined();
  });

  it('renders assistant message content', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Hi there, how can I help?',
        parts: [{ type: 'text', text: 'Hi there, how can I help?' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hi there, how can I help?')).toBeDefined();
  });

  it('renders multiple messages', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Hello',
        parts: [{ type: 'text', text: 'Hello' }],
        timestamp: new Date().toISOString(),
      },
      {
        id: '2',
        role: 'assistant',
        content: 'Hi there',
        parts: [{ type: 'text', text: 'Hi there' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hello')).toBeDefined();
    expect(screen.getByText('Hi there')).toBeDefined();
  });

  it('renders tool calls within messages', () => {
    // Disable auto-hide so completed tool calls remain visible
    useAppStore.setState({ autoHideToolCalls: false });
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'assistant',
        content: 'Let me read that file.',
        toolCalls: [{ toolCallId: 'tc-1', toolName: 'Read', input: '{}', status: 'complete' }],
        parts: [
          { type: 'text', text: 'Let me read that file.' },
          {
            type: 'tool_call',
            toolCallId: 'tc-1',
            toolName: 'Read',
            input: '{}',
            status: 'complete',
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Read ...')).toBeDefined();
  });

  it('has scroll container with overflow', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(<MessageList sessionId="test-session" messages={messages} />);
    const scrollContainer = container.querySelector('.overflow-y-auto');
    expect(scrollContainer).not.toBeNull();
  });

  it('scroll container does not have flex-1 class', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    const scrollContainer = screen.getByTestId('message-list');
    expect(scrollContainer.classList.contains('flex-1')).toBe(false);
  });

  it('does not render scroll-to-bottom button', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(<MessageList sessionId="test-session" messages={messages} />);
    const button = container.querySelector('button[aria-label="Scroll to bottom"]');
    expect(button).toBeNull();
  });

  it('accepts onScrollStateChange callback prop', () => {
    const handleScrollState = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(
      <MessageList
        sessionId="test-session"
        messages={messages}
        onScrollStateChange={handleScrollState}
      />
    );
    expect(container).toBeDefined();
  });

  it('attaches ResizeObserver to content container', () => {
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(globalThis.ResizeObserver).toHaveBeenCalled();
  });

  it('scroll container uses native scrollTop for scrollToBottom', () => {
    const ref = React.createRef<MessageListHandle>();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(<MessageList ref={ref} sessionId="test-session" messages={messages} />);
    expect(() => ref.current?.scrollToBottom()).not.toThrow();
  });

  it('does not disengage auto-scroll when scroll fires without wheel/touch', () => {
    const onScrollStateChange = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user' as const,
        content: 'Hi',
        parts: [{ type: 'text' as const, text: 'Hi' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(
      <MessageList
        sessionId="test"
        messages={messages}
        onScrollStateChange={onScrollStateChange}
      />
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLElement;

    // Simulate scrollHeight > clientHeight + scrollTop (would compute distanceFromBottom > 200)
    // by setting scroll properties before firing the event
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });

    // Fire a scroll event with NO preceding wheel/touchstart — simulates layout reflow
    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

    // onScrollStateChange should not report isAtBottom:false because no user intent was signaled
    const calls = onScrollStateChange.mock.calls;
    const reportedFalse = calls.some(([state]) => state.isAtBottom === false);
    expect(reportedFalse).toBe(false);
  });

  it('disengages auto-scroll when wheel event precedes scroll', () => {
    const onScrollStateChange = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user' as const,
        content: 'Hi',
        parts: [{ type: 'text' as const, text: 'Hi' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(
      <MessageList
        sessionId="test"
        messages={messages}
        onScrollStateChange={onScrollStateChange}
      />
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLElement;

    // Simulate user scrolling: wheel event first sets the intent flag
    scrollEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

    // Mutate scroll position to simulate being scrolled up (distanceFromBottom > 200)
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });

    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

    // onScrollStateChange should report isAtBottom:false because user intent was present
    expect(onScrollStateChange).toHaveBeenCalledWith(
      expect.objectContaining({ isAtBottom: false })
    );
  });

  it('clears user-scroll intent after 150ms debounce', () => {
    vi.useFakeTimers();
    const onScrollStateChange = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user' as const,
        content: 'Hi',
        parts: [{ type: 'text' as const, text: 'Hi' }],
        timestamp: new Date().toISOString(),
      },
    ];
    const { container } = render(
      <MessageList
        sessionId="test"
        messages={messages}
        onScrollStateChange={onScrollStateChange}
      />
    );

    const scrollEl = container.querySelector('.overflow-y-auto') as HTMLElement;

    // User scrolls via wheel
    scrollEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));

    // Advance timers past the 150ms debounce to clear intent flag
    vi.advanceTimersByTime(200);

    // Now fire a scroll event — intent flag should be cleared; should not disengage
    Object.defineProperty(scrollEl, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollEl, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(scrollEl, 'clientHeight', { value: 200, configurable: true });
    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Should not report false after debounce cleared the flag
    const callsAfterDebounce = onScrollStateChange.mock.calls.filter(
      ([state]) => state.isAtBottom === false
    );
    expect(callsAfterDebounce.length).toBe(0);

    vi.useRealTimers();
  });
});
