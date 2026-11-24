// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, act, waitFor } from '@testing-library/react';

/** Read-state broadcast handlers the list's cursor hook registered, keyed by event name. */
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

import { SessionTranscript, findLastWidgetFenceIndex } from '../ui/SessionTranscript';
import type { ChatMessage } from '@/layers/shared/model';
import { useAppStore } from '@/layers/shared/model';
import {
  createReadCursorHarness,
  renderWithTransport,
  sessionCursor as cursor,
} from './session-transcript-test-helpers';

/** The read-cursor route, as this suite answers for it. */
const readState = createReadCursorHarness();

/** Render inside the transport the unread cursor reads through. */
function render(ui: React.ReactElement, options?: Parameters<typeof renderWithTransport>[2]) {
  return renderWithTransport(ui, readState.transport, options);
}

beforeEach(() => {
  readState.reset();
  eventHandlers.clear();
  // The virtualizer spies are module-level, so they carry every call the PREVIOUS test made, and
  // a spy that is already non-empty satisfies `toHaveBeenCalled()` on its first poll.
  mockScrollToEnd.mockClear();
  mockScrollToIndex.mockClear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  mockIsAtEnd.mockImplementation(() => true);
  mockMeasureElement.mockClear();
  // Reset store to defaults between tests
  useAppStore.getState().resetAllSettings();
});

// Mock Streamdown to avoid complex rendering in unit tests
vi.mock('streamdown', () => ({
  Streamdown: ({ children }: { children: string }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

// Mock ToolApproval to avoid needing TransportProvider in unit tests
vi.mock('@/layers/features/chat/ui/tools/ToolApproval', () => ({
  ToolApproval: ({ toolName }: { toolName: string }) => (
    <div data-testid="tool-approval">{toolName}</div>
  ),
}));

// Mock QuestionPrompt to avoid needing TransportProvider in unit tests
vi.mock('@/layers/features/chat/ui/message/QuestionPrompt', () => ({
  QuestionPrompt: () => <div data-testid="question-prompt">Question prompt</div>,
}));

// Mock EntryRunWithMenu — router + session/runtime queries, out of scope for this
// list-rendering suite (EntryRunWithMenu has its own dedicated test).
vi.mock('@/layers/features/entry-actions/ui/EntryRunWithMenu', () => ({
  EntryRunWithMenu: () => <div data-testid="run-with-menu" />,
}));

// Mock ScrollThumb to avoid scroll measurement in unit tests
vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));

// Author identity comes from the working directory's agent and the session's runtime, both
// transport-backed caches.
vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/query/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

// Native end-anchor scroll now rides the virtualizer (DOR-163): scrollToBottom calls
// `scrollToEnd()`, and pinned state derives from `isAtEnd()`.
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
 * Model the real virtualizer's first-commit lie: `isAtEnd()` is vacuously true while
 * `scrollElement` is still null, then tells the truth once the element is attached.
 */
function isAtEndTrueOnlyOnFirstCommit(): void {
  let call = 0;
  mockIsAtEnd.mockImplementation(() => call++ === 0);
}

// Grouping itself (author change, time gap, day boundary) is unit-tested where it lives now —
// `lib/__tests__/build-list-rows.test.ts`.
describe('SessionTranscript rows', () => {
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
    render(<SessionTranscript sessionId="test-session" messages={messages} />);
    expect(screen.getAllByTestId('day-divider')).toHaveLength(2);
    expect(screen.getByText('Yesterday')).toBeDefined();
    expect(screen.getByText('Today')).toBeDefined();
  });

  it('hands every rendered row to the virtualizer to be measured', () => {
    // The row element is where measurement is wired up, and it is the only place it is: the real
    // virtualizer observes each row it is given with a ResizeObserver, so anything inside a
    // message that changes height later — a tool card expanding, a touch-chip strip settling or
    // opening its tray — is re-measured without telling the list anything.
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(<SessionTranscript sessionId="test-session" messages={messages} />);

    const measured = mockMeasureElement.mock.calls
      .map(([node]) => node as HTMLElement | null)
      .filter((node): node is HTMLElement => node !== null);

    // Three rows: the day divider these two messages sit under, and each of
    // them. Every one measured, with the index the virtualizer knows it by.
    expect(measured.map((node) => node.getAttribute('data-index'))).toEqual(['0', '1', '2']);
  });

  it('counts dividers as virtualized rows alongside the messages', () => {
    const messages = [messageOnDay('1', 1, 'Yesterday work'), messageOnDay('2', 0, 'Today work')];
    const { container } = render(
      <SessionTranscript sessionId="test-session" messages={messages} />
    );
    // 2 messages + 2 day dividers, each an independently measured row.
    expect(container.querySelectorAll('[data-index]')).toHaveLength(4);
  });

  it('renders the unread rule after the stored cursor', async () => {
    readState.storedCursor = cursor('test-session', 1);
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<SessionTranscript sessionId="test-session" messages={messages} />);
    expect(await screen.findByTestId('unread-divider')).toBeDefined();
    expect(screen.getByText('New messages')).toBeDefined();
  });

  it('clears the rule when the same person reads the session on another device', async () => {
    readState.storedCursor = cursor('cross-device-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<SessionTranscript sessionId="cross-device-session" messages={messages} />);
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
    render(<SessionTranscript sessionId="test-session" messages={messages} />);
    // Through the API, and nothing left in this browser: the watermark that
    // used to live here is what made two devices disagree.
    await waitFor(() => expect(readState.written).toEqual([2]));
    expect(window.localStorage.length).toBe(0);
  });

  it('opens one row above the unread rule, keeping the last seen message on screen', async () => {
    readState.storedCursor = cursor('anchor-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<SessionTranscript sessionId="anchor-session" messages={messages} />);
    // Rows: day-divider, message, unread-divider, message — the rule is row 2,
    // so the list lands on row 1 and the seen message stays visible above it.
    await waitFor(() => expect(mockScrollToIndex).toHaveBeenCalledWith(1, { align: 'start' }));
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    // Regression pin: mounting must NOT consume the rule it just drew.
    expect(readState.written).toEqual([]);
  });

  it('opens on the row a search hit asked for, and not at the end', async () => {
    // The wiring DOR-1579 rests on: `?message=` becomes a row getter in `SessionPage` and has to
    // reach the timeline's landing through this component.
    const messages = [messageOnDay('1', 0, 'A'), messageOnDay('2', 0, 'B')];
    render(
      <SessionTranscript
        sessionId="landing-session"
        messages={messages}
        landOnRow={() => 'msg-2'}
      />
    );

    await waitFor(() => expect(mockScrollToIndex).toHaveBeenCalledWith(2, { align: 'center' }));
    expect(mockScrollToEnd).not.toHaveBeenCalled();
  });

  it('anchors once per session, not again as messages stream in', async () => {
    const messages = [messageOnDay('1', 0, 'A')];
    const { rerender } = render(<SessionTranscript sessionId="test-session" messages={messages} />);
    await waitFor(() => expect(mockScrollToEnd).toHaveBeenCalled());
    mockScrollToEnd.mockClear();
    mockScrollToIndex.mockClear();
    rerender(
      <SessionTranscript
        sessionId="test-session"
        messages={[...messages, messageOnDay('2', 0, 'B')]}
      />
    );
    expect(mockScrollToEnd).not.toHaveBeenCalled();
    expect(mockScrollToIndex).not.toHaveBeenCalled();
  });

  it('does not mark messages seen from the first commit, before the list has geometry', async () => {
    readState.storedCursor = cursor('unmeasured-session', 1);
    isAtEndTrueOnlyOnFirstCommit();
    const messages = [messageOnDay('1', 0, 'Seen'), messageOnDay('2', 0, 'Unseen')];
    render(<SessionTranscript sessionId="unmeasured-session" messages={messages} />);
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

  it('a newer fence-bearing message takes over the last widget index (older board superseded)', () => {
    const messages = [msg('1', `board:\n${fence}`), msg('2', `next turn:\n${fence}`)];
    expect(findLastWidgetFenceIndex(messages)).toBe(1);
  });
});

describe('SessionTranscript', () => {
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
    render(<SessionTranscript sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Hello world')).toBeDefined();
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
    render(<SessionTranscript sessionId="test-session" messages={messages} />);
    expect(screen.getByText('Read …')).toBeDefined();
  });
});
