// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageList, findLastWidgetFenceIndex, type MessageListHandle } from '../ui/MessageList';
import type { ChatMessage } from '../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';

afterEach(() => {
  // Pinned-to-the-bottom rendering marks the newest message seen, so clear
  // storage before the next test reads it back as "where I left off".
  cleanup();
  window.localStorage.clear();
  mockIsAtEnd.mockImplementation(() => true);
  mockMeasureElement.mockClear();
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

// Mock RunWithMenu — router + session/runtime queries, out of scope for this
// list-rendering suite (RunWithMenu has its own dedicated test).
vi.mock('../ui/message/RunWithMenu', () => ({
  RunWithMenu: () => <div data-testid="run-with-menu" />,
}));

// Mock ScrollThumb to avoid scroll measurement in unit tests
vi.mock('../ui/ScrollThumb', () => ({
  ScrollThumb: () => null,
}));

// Author identity comes from the working directory's agent and the session's
// runtime, both transport-backed caches. Mocked at their source modules (not at
// the entity barrels) so everything else those barrels export stays real.
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

// Native end-anchor scroll now rides the virtualizer (DOR-163): scrollToBottom
// calls `scrollToEnd()`, and pinned state derives from `isAtEnd()`. The mock
// defaults to pinned (isAtEnd true) so the scroll-state contract holds; tests
// that care about the pinned/not-pinned seam override `mockIsAtEnd`.
const mockScrollToEnd = vi.fn();
const mockScrollToIndex = vi.fn();
const mockIsAtEnd = vi.fn(() => true);
const mockMeasureElement = vi.fn();
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
    measureElement: mockMeasureElement,
    scrollToEnd: mockScrollToEnd,
    scrollToIndex: mockScrollToIndex,
    isAtEnd: () => mockIsAtEnd(),
  }),
}));

/**
 * Model the real virtualizer's first-commit lie: `isAtEnd()` is vacuously true
 * while `scrollElement` is still null, then tells the truth once the element is
 * attached. Here the truth is "scrolled up, not pinned".
 */
function isAtEndTrueOnlyOnFirstCommit(): void {
  let call = 0;
  mockIsAtEnd.mockImplementation(() => call++ === 0);
}

// Grouping itself (author change, time gap, day boundary) is unit-tested where
// it lives now — `lib/__tests__/build-list-rows.test.ts`. What matters here is
// that the list virtualizes ROWS: dividers are real rows with their own heights,
// not decoration inside a message.
describe('MessageList rows', () => {
  /** A message at a given local time, `hoursAgo` whole days back from now. */
  function messageOnDay(id: string, daysAgo: number, text: string): ChatMessage {
    const now = new Date();
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 10, 0, 0);
    return {
      id,
      role: 'user',
      content: text,
      parts: [{ type: 'text', text }],
      timestamp: day.toISOString(),
    };
  }

  it('renders a day divider row at each calendar boundary', () => {
    const messages = [messageOnDay('1', 1, 'Yesterday work'), messageOnDay('2', 0, 'Today work')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getAllByTestId('day-divider')).toHaveLength(2);
    expect(screen.getByText('Yesterday')).toBeDefined();
    expect(screen.getByText('Today')).toBeDefined();
  });

  it('hands every rendered row to the virtualizer to be measured', () => {
    // The row element is where measurement is wired up, and it is the only
    // place it is: the real virtualizer observes each row it is given with a
    // ResizeObserver, so anything inside a message that changes height later —
    // a tool card expanding, a touch-chip strip settling or opening its tray —
    // is re-measured without telling the list anything. Lose this ref and every
    // row keeps its first height forever, and the transcript scrolls to the
    // wrong place.
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);

    const measured = mockMeasureElement.mock.calls
      .map(([node]) => node as HTMLElement | null)
      .filter((node): node is HTMLElement => node !== null);

    expect(measured.length).toBeGreaterThan(0);
    for (const node of measured) {
      expect(node.hasAttribute('data-index')).toBe(true);
    }
  });

  it('counts dividers as virtualized rows alongside the messages', () => {
    const messages = [messageOnDay('1', 1, 'Yesterday work'), messageOnDay('2', 0, 'Today work')];
    const { container } = render(<MessageList sessionId="test-session" messages={messages} />);
    // 2 messages + 2 day dividers, each an independently measured row.
    expect(container.querySelectorAll('[data-index]')).toHaveLength(4);
  });

  it('renders no day divider when messages carry no usable timestamp', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', parts: [{ type: 'text', text: 'A' }], timestamp: '' },
    ];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.queryByTestId('day-divider')).toBeNull();
  });

  it('renders the unread rule after the stored cursor', () => {
    window.localStorage.setItem('dorkos:chat:last-seen:test-session', '1');
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.getByTestId('unread-divider')).toBeDefined();
    expect(screen.getByText('New messages')).toBeDefined();
  });

  it('renders no unread rule for a session with no stored cursor', () => {
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('renders no unread rule when the cursor is already the newest message', () => {
    window.localStorage.setItem('dorkos:chat:last-seen:test-session', '2');
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('marks the newest message seen while pinned to the bottom', () => {
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(window.localStorage.getItem('dorkos:chat:last-seen:test-session')).toBe('2');
  });

  it('opens one row above the unread rule, keeping the last seen message on screen', () => {
    window.localStorage.setItem('dorkos:chat:last-seen:anchor-session', '1');
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="anchor-session" messages={messages} />);
    // Rows: day-divider, message, unread-divider, message — the rule is row 2,
    // so the list lands on row 1 and the seen message stays visible above it.
    expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'start' });
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    // Regression pin: mounting must NOT consume the rule it just drew. The
    // first commit reports pinned only because the virtualizer has no scroll
    // element yet; marking seen on it overwrites the cursor with '2'.
    expect(window.localStorage.getItem('dorkos:chat:last-seen:anchor-session')).toBe('1');
  });

  it('lands on the newest message when there is no unread rule', () => {
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(mockScrollToEnd).toHaveBeenCalled();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('anchors once per session, not again as messages stream in', () => {
    const messages = [messageOnDay('1', 0, 'A')];
    const { rerender } = render(<MessageList sessionId="test-session" messages={messages} />);
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    rerender(
      <MessageList sessionId="test-session" messages={[...messages, messageOnDay('2', 0, 'B')]} />
    );
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('does not mark messages seen from the first commit, before the list has geometry', () => {
    window.localStorage.setItem('dorkos:chat:last-seen:unmeasured-session', '1');
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="unmeasured-session" messages={messages} />);
    expect(window.localStorage.getItem('dorkos:chat:last-seen:unmeasured-session')).toBe('1');
    expect(screen.getByTestId('unread-divider')).toBeDefined();
  });
});

describe('findLastWidgetFenceIndex (fence-based supersede, DOR-302)', () => {
  const fence = '```dorkos-ui\n{"version":1}\n```';

  function msg(id: string, content: string): ChatMessage {
    return { id, role: 'assistant', content, parts: [], timestamp: '' };
  }

  it('returns -1 when no message carries a widget fence', () => {
    expect(findLastWidgetFenceIndex([msg('1', 'plain'), msg('2', 'text')])).toBe(-1);
    expect(findLastWidgetFenceIndex([])).toBe(-1);
  });

  it('a fence-bearing message stays the last widget index across trailing TEXT-only messages', () => {
    // The DOR-302 repro: the board (index 0) followed by the agent's plain
    // reply must NOT be superseded — the fence index stays 0, so index 0
    // renders live (index >= lastWidgetFenceIndex).
    const messages = [msg('1', `board:\n${fence}`), msg('2', 'opened it for you!')];
    expect(findLastWidgetFenceIndex(messages)).toBe(0);
  });

  it('a newer fence-bearing message takes over the last widget index (older board superseded)', () => {
    const messages = [msg('1', `board:\n${fence}`), msg('2', `next turn:\n${fence}`)];
    expect(findLastWidgetFenceIndex(messages)).toBe(1);
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

  it('exposes scrollToBottom via imperative handle', () => {
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
    // Ignore the initial land-at-bottom call; assert the handle itself fires.
    mockScrollToEnd.mockClear();
    ref.current?.scrollToBottom();
    expect(mockScrollToEnd).toHaveBeenCalled();
  });

  it('scroll container has overflow-anchor none', () => {
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
    const scrollContainer = container.querySelector('.chat-scroll-area') as HTMLElement;
    expect(scrollContainer.style.overflowAnchor).toBe('none');
  });

  it('fires onScrollStateChange when isAtBottom changes', () => {
    const onScrollStateChange = vi.fn();
    const messages: ChatMessage[] = [
      {
        id: '1',
        role: 'user',
        content: 'Test',
        parts: [{ type: 'text', text: 'Test' }],
        timestamp: new Date().toISOString(),
      },
    ];
    render(
      <MessageList
        sessionId="test-session"
        messages={messages}
        onScrollStateChange={onScrollStateChange}
      />
    );
    // The initial render with isAtBottom=true from the mock should trigger the effect
    expect(onScrollStateChange).toHaveBeenCalledWith(expect.objectContaining({ isAtBottom: true }));
  });
});
