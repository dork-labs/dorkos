// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, act, waitFor } from '@testing-library/react';

/**
 * Read-state broadcast handlers the list's cursor hook registered, keyed by
 * event name. Mocked at `useEventSubscription` rather than by standing a real
 * stream up: this suite is about what the list DRAWS when a cursor moves, and
 * the connection that carries the event has its own tests.
 */
const eventHandlers = new Map<string, (payload?: unknown) => void>();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useEventSubscription: (event: string, handler: (payload?: unknown) => void) => {
      eventHandlers.set(event, handler);
    },
  };
});

import { MessageList, findLastWidgetFenceIndex, type MessageListHandle } from '../ui/MessageList';
import type { ChatMessage } from '../model/use-chat-session';
import { useAppStore } from '@/layers/shared/model';
import {
  createReadCursorHarness,
  renderWithTransport,
  sessionCursor as cursor,
} from './message-list-test-helpers';

/** The read-cursor route, as this suite answers for it. */
const readState = createReadCursorHarness();

/**
 * Render inside the transport the unread cursor reads through.
 *
 * Shadows RTL's `render` so every case in this suite gets the provider without
 * 25 call sites having to say so — the cursor is not what most of them are
 * about, but the list does not mount without it.
 */
function render(ui: React.ReactElement, options?: Parameters<typeof renderWithTransport>[2]) {
  return renderWithTransport(ui, readState.transport, options);
}

beforeEach(() => {
  readState.reset();
  eventHandlers.clear();
  // The virtualizer spies are module-level, so they carry every call the
  // PREVIOUS test made, and a spy that is already non-empty satisfies
  // `toHaveBeenCalled()` on its first poll. A case that waits for its list to
  // land by watching `mockScrollToEnd` is then not waiting for anything.
  //
  // Most cases below already guarded against that by clearing the spies
  // themselves, immediately before `render`. Clearing here generalises that
  // guard so no future test has to remember it — and repairs the one case that
  // did not have it: `anchors once per session` (DOR-1060, the CI red). Its wait
  // returned on residue, before its own list had read its cursor back, so
  // whether the anchor landed before or after the `mockClear()` that follows was
  // decided by which `act()` happened to flush the cursor promise's commit.
  //
  // Worth knowing what that cost, because it is more than a red build: on the
  // fast path that test still caught a broken anchoring guard. It stopped
  // catching one once the cursor read was SLOW — which is the CI condition. Left
  // alone it would have gone on passing over a real regression on exactly the
  // runners it was failing on.
  mockScrollToEnd.mockClear();
  mockScrollToIndex.mockClear();
});

afterEach(() => {
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

// Mock EntryRunWithMenu — router + session/runtime queries, out of scope for this
// list-rendering suite (EntryRunWithMenu has its own dedicated test).
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
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

    // Three rows: the day divider these two messages sit under, and each of
    // them. Every one measured, with the index the virtualizer knows it by.
    expect(measured.map((node) => node.getAttribute('data-index'))).toEqual(['0', '1', '2']);
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

  it('renders the unread rule after the stored cursor', async () => {
    readState.storedCursor = cursor('test-session', 1);
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    expect(await screen.findByTestId('unread-divider')).toBeDefined();
    expect(screen.getByText('New messages')).toBeDefined();
  });

  it('renders no unread rule for a session with no stored cursor', async () => {
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    // Waited out through the write the pinned list makes, so the absence is
    // observed after the cursor has landed rather than before it arrives.
    await waitFor(() => expect(readState.written).toEqual([2]));
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('renders no unread rule when the cursor already counts every message', async () => {
    readState.storedCursor = cursor('test-session', 2);
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    expect(screen.queryByTestId('unread-divider')).toBeNull();
  });

  it('clears the rule when the same person reads the session on another device', async () => {
    readState.storedCursor = cursor('cross-device-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="cross-device-session" messages={messages} />);
    expect(await screen.findByTestId('unread-divider')).toBeDefined();

    // The other screen read to the end. The cursor rides the broadcast, so this
    // one clears on the event — with no second read of the cursor behind it.
    act(() =>
      eventHandlers.get('read_cursor')?.({
        userId: 'author-me',
        threadKind: 'session',
        threadId: 'cross-device-session',
        lastReadSeq: 2,
      })
    );

    await waitFor(() => expect(screen.queryByTestId('unread-divider')).toBeNull());
  });

  it('records the whole transcript as seen while pinned to the bottom', async () => {
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    // Through the API, and nothing left in this browser: the watermark that
    // used to live here is what made two devices disagree.
    await waitFor(() => expect(readState.written).toEqual([2]));
    expect(window.localStorage.length).toBe(0);
  });

  it('opens one row above the unread rule, keeping the last seen message on screen', async () => {
    readState.storedCursor = cursor('anchor-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="anchor-session" messages={messages} />);
    // Rows: day-divider, message, unread-divider, message — the rule is row 2,
    // so the list lands on row 1 and the seen message stays visible above it.
    await waitFor(() => expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'start' }));
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    // Regression pin: mounting must NOT consume the rule it just drew. The
    // first commit reports pinned only because the virtualizer has no scroll
    // element yet; marking seen on it would move the cursor to 2.
    expect(readState.written).toEqual([]);
  });

  it('lands on the newest message when there is no unread rule', async () => {
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<MessageList sessionId="test-session" messages={messages} />);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('anchors once per session, not again as messages stream in', async () => {
    const messages = [messageOnDay('1', 0, 'A')];
    const { rerender } = render(<MessageList sessionId="test-session" messages={messages} />);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    rerender(
      <MessageList sessionId="test-session" messages={[...messages, messageOnDay('2', 0, 'B')]} />
    );
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('does not mark messages seen from the first commit, before the list has geometry', async () => {
    readState.storedCursor = cursor('unmeasured-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<MessageList sessionId="unmeasured-session" messages={messages} />);
    expect(await screen.findByTestId('unread-divider')).toBeDefined();
    expect(readState.written).toEqual([]);
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
