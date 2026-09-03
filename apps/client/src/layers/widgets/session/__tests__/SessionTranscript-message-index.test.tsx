// @vitest-environment jsdom
import type React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * The list holds its unread rule in server state now (team-room-home §D4), so
 * it subscribes to the read-cursor broadcast. Nothing here is about read state
 * — the subscription is stubbed out, and the cursor comes back empty from the
 * harness transport below.
 */
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useEventSubscription: () => {} };
});

import { SessionTranscript } from '../ui/SessionTranscript';
import type { ChatMessage } from '@/layers/shared/model';
import { createReadCursorHarness, renderWithTransport } from './session-transcript-test-helpers';

/** The read-cursor route, which answers "never read" for every session here. */
const readState = createReadCursorHarness();

/** Render inside the transport the list's unread cursor reads through. */
function render(ui: React.ReactElement) {
  return renderWithTransport(ui, readState.transport);
}

/**
 * Regression pins for the two rules that must keep MESSAGE semantics after the
 * list started virtualizing rows: the widget-fence supersede rule (DOR-302) and
 * the `isNew` entry-animation gate. Both compare positions in the original
 * messages array, so a day divider shifting every row index below it must not
 * change their answers. Fixtures deliberately span two days for that reason.
 */

/** Props the list hands each message row, captured in render order. */
interface CapturedMessageProps {
  message: ChatMessage;
  isNew: boolean;
  isLatestWidgetMessage: boolean;
  isFinalMessage: boolean;
}

const { captured } = vi.hoisted(() => ({ captured: [] as unknown[] }));

// Stand in for SessionMessage to read the props it receives. The dividers stay
// real — they are what shifts the row indices this suite is about, and they
// come from `features/conversation`, which is not mocked here.
vi.mock('../ui/SessionMessage', () => ({
  SessionMessage: (props: unknown) => {
    captured.push(props);
    return <div data-testid="message-item" />;
  },
}));

vi.mock('@/layers/features/conversation', async () => ({
  ...(await vi.importActual<object>('@/layers/features/conversation')),
  ScrollThumb: () => null,
}));

vi.mock('@/layers/entities/agent/model/use-current-agent', () => ({
  useCurrentAgent: () => ({ data: null }),
}));
vi.mock('@/layers/entities/session/model/use-session-runtime', () => ({
  useSessionRuntime: () => 'claude-code',
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ key: `virt-${i}`, index: i, start: i * 80 })),
    getTotalSize: () => count * 80,
    measureElement: () => {},
    scrollToEnd: () => {},
    scrollToIndex: () => {},
    isAtEnd: () => true,
  }),
}));

const FENCE = '```dorkos-ui\n{"version":1}\n```';

/** A message on a specific day, so consecutive fixtures land on both sides of a divider. */
function messageOnDay(
  id: string,
  daysAgo: number,
  content: string,
  role: ChatMessage['role'] = 'assistant'
): ChatMessage {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 10, 0, 0);
  return {
    id,
    role,
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: day.toISOString(),
  };
}

/** Props captured for the last render pass, one entry per message row. */
function rows(): CapturedMessageProps[] {
  return captured as CapturedMessageProps[];
}

beforeEach(() => {
  captured.length = 0;
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('SessionTranscript message-index rules', () => {
  it('keys the widget-fence supersede rule to the message index, not the row index', () => {
    const messages = [
      messageOnDay('1', 1, 'older board'),
      messageOnDay('2', 0, `newest board:\n${FENCE}`),
    ];
    render(<SessionTranscript sessionId="test-session" messages={messages} />);

    // The fence lives at MESSAGE index 1, which sits at ROW index 3 (two day
    // dividers precede it). Reading row indices would mark the older message
    // live too, freezing the real board.
    const byId = new Map(rows().map((row) => [row.message.id, row]));
    expect(byId.get('1')?.isLatestWidgetMessage).toBe(false);
    expect(byId.get('2')?.isLatestWidgetMessage).toBe(true);
  });

  it('fires the entry animation only for messages appended after the history snapshot', () => {
    const history = [messageOnDay('1', 1, 'first'), messageOnDay('2', 0, 'second')];
    const { rerender } = render(<SessionTranscript sessionId="test-session" messages={history} />);

    captured.length = 0;
    rerender(
      <SessionTranscript
        sessionId="test-session"
        messages={[...history, messageOnDay('3', 0, 'live')]}
      />
    );

    // History count is 2. Message index 1 sits at row index 3, so a row-index
    // read would falsely animate it as new.
    const byId = new Map(rows().map((row) => [row.message.id, row]));
    expect(byId.get('1')?.isNew).toBe(false);
    expect(byId.get('2')?.isNew).toBe(false);
    expect(byId.get('3')?.isNew).toBe(true);
  });

  it('names only the last message as the final one', () => {
    // The rule Retry hangs off (DOR-1677). No divider ever sorts AFTER the last
    // message, so this rule cannot confuse the two positions the way the fence
    // rule above can — but it can still count the wrong list: two messages here
    // occupy four rows, so measuring against the row count names nothing final
    // at all.
    const messages = [
      messageOnDay('1', 1, 'earlier turn'),
      messageOnDay('2', 0, 'the turn that failed'),
    ];
    render(<SessionTranscript sessionId="test-session" messages={messages} />);

    const byId = new Map(rows().map((row) => [row.message.id, row]));
    expect(byId.get('1')?.isFinalMessage).toBe(false);
    expect(byId.get('2')?.isFinalMessage).toBe(true);
  });

  it('takes the final flag off a turn as soon as anything follows it', () => {
    // The hazard itself: a failed turn stops being retryable the moment the
    // person says something else, because Retry re-sends the LAST user message
    // and that is now the new one.
    const failed = messageOnDay('2', 0, 'the turn that failed');
    const { rerender } = render(
      <SessionTranscript
        sessionId="test-session"
        messages={[messageOnDay('1', 0, 'ask', 'user'), failed]}
      />
    );
    expect(rows().find((row) => row.message.id === '2')?.isFinalMessage).toBe(true);

    captured.length = 0;
    rerender(
      <SessionTranscript
        sessionId="test-session"
        messages={[
          messageOnDay('1', 0, 'ask', 'user'),
          failed,
          messageOnDay('3', 0, 'never mind, do this instead', 'user'),
        ]}
      />
    );

    expect(rows().find((row) => row.message.id === '2')?.isFinalMessage).toBe(false);
  });

  it('keeps the tail final when a settling turn swaps its identity', () => {
    // The streaming boundary. While the turn runs, the tail is the synthetic
    // in-progress bubble; the turn-end reconcile replaces it with canonical
    // history under a different id, in the same position. A rule keyed to
    // message IDENTITY would blink Retry off and on across that swap; one keyed
    // to POSITION does not move.
    const asked = messageOnDay('u-1', 0, 'do the thing', 'user');
    const live: ChatMessage = {
      id: '__in_progress_turn__',
      role: 'assistant',
      content: '',
      parts: [{ type: 'error', message: 'The sidecar exited.', category: 'execution_error' }],
      timestamp: '',
      _streaming: true,
    };
    const { rerender } = render(
      <SessionTranscript sessionId="test-session" messages={[asked, live]} isTextStreaming />
    );
    expect(rows().find((row) => row.message.id === '__in_progress_turn__')?.isFinalMessage).toBe(
      true
    );

    captured.length = 0;
    const settled: ChatMessage = { ...live, id: 'canonical-1', _streaming: false };
    rerender(<SessionTranscript sessionId="test-session" messages={[asked, settled]} />);

    expect(rows().find((row) => row.message.id === 'canonical-1')?.isFinalMessage).toBe(true);
  });
});
