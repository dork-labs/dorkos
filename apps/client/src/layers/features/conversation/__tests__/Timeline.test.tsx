// @vitest-environment jsdom
/**
 * What `Conversation.Timeline` promises both surfaces.
 *
 * Deliberately NOT about geometry: jsdom reports every element as 0 x 0, so
 * "did it scroll" is a browser question and `apps/e2e` is where it is asked.
 * What can be answered here is what the list DRAWS and what it hands its host.
 */
import { createRef, type ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

/**
 * The virtualizer, stood in for.
 *
 * jsdom lays nothing out, so a real one measures every element at 0 and answers
 * with an empty window — which would make every assertion below vacuous. The
 * stand-in draws every row, which is what a test about WHICH rows are drawn
 * needs; whether virtualization itself works is a browser question.
 */
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
    measureElement: vi.fn(),
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    isAtEnd: () => true,
  }),
}));
import type { PendingPost } from '@/layers/entities/room';
import { Conversation } from '..';
import type { ConversationCapabilities } from '../model/capabilities';
import type { ConversationRow } from '../lib/row-kinds';
import type { ConversationRowRenderer, ConversationTimelineHandle } from '../ui/Timeline';

/**
 * A capability table declared here rather than imported from a host.
 *
 * A feature may not import a widget's model, and the point of the table is that
 * it is data — the shipped ones are exercised where they are mounted.
 */
const BASE: ConversationCapabilities = {
  reactions: false,
  threads: false,
  runWith: false,
  attachments: false,
  toolCards: false,
  mentions: false,
  presence: false,
  turnStatus: false,
  asks: false,
};

/** One message row, with everything a host would carry on it. */
function messageRow(id: string): ConversationRow {
  return {
    kind: 'message',
    id,
    payload: { text: id },
    grouping: { position: 'only' },
    author: { kind: 'human', id: 'author-me', displayName: 'Dorian' },
    at: '2026-08-18T10:00:00.000Z',
  };
}

/** Draws each row as a plain line, so the test reads what the list decided. */
const renderRow: ConversationRowRenderer = (row, ctx) => (
  <div
    data-testid={`row-${row.id}`}
    data-index={ctx.index}
    data-can-thread={ctx.onOpenThread !== undefined}
  >
    {row.kind}
  </div>
);

/** One message of this reader's own, waiting under the log. */
function pendingPost(overrides: Partial<PendingPost> = {}): PendingPost {
  return {
    clientId: 'attempt-1',
    roomId: 'room-1',
    threadRootId: null,
    text: 'still going',
    attachmentNames: [],
    attachmentIds: [],
    status: 'sending',
    entryId: null,
    at: Date.now(),
    ...overrides,
  };
}

/**
 * The two providers a pending row reaches through: it can retry its own send,
 * which is a mutation over the transport.
 */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        })
      }
    >
      <TransportProvider transport={createMockTransport()}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** Mount a timeline inside the conversation every part reads. */
function mount(
  props: Partial<Parameters<typeof Conversation.Timeline>[0]> = {},
  capabilities: Partial<ConversationCapabilities> = {}
) {
  return render(
    <Providers>
      <Conversation.Root surface="room" capabilities={{ ...BASE, ...capabilities }}>
        <Conversation.Timeline
          conversationId="room-1"
          label="Messages in #mio"
          rows={[messageRow('entry-1'), messageRow('entry-2')]}
          renderRow={renderRow}
          {...props}
        />
      </Conversation.Root>
    </Providers>
  );
}

beforeAll(() => {
  // Two DOM methods jsdom does not implement at all. Both are how a scroller
  // moves, so a test that exercises "take me there" has to have them.
  Element.prototype.scrollTo = function scrollTo(this: Element, options?: unknown) {
    if (typeof options === 'object' && options !== null && 'top' in options) {
      this.scrollTop = Number((options as { top: number }).top);
    }
  } as Element['scrollTo'];
  Element.prototype.scrollIntoView = vi.fn();
});

describe('Conversation.Timeline', () => {
  it('draws every row through the host, in order', () => {
    mount();

    expect(screen.getByTestId('row-entry-1')).toHaveAttribute('data-index', '0');
    expect(screen.getByTestId('row-entry-2')).toHaveAttribute('data-index', '1');
  });

  it('names the feed after the conversation it is drawing', () => {
    mount();

    expect(screen.getByRole('feed')).toHaveAccessibleName('Messages in #mio');
  });

  it('offers a row no way to open a thread when the conversation has none', () => {
    // Seeded defect: hand `onOpenThread` straight to the row context instead of
    // gating it on `capabilities.threads` → this goes red, and a session grows
    // a reply row it has no panel for.
    mount({ onOpenThread: vi.fn() }, { threads: false });

    expect(screen.getByTestId('row-entry-1')).toHaveAttribute('data-can-thread', 'false');
  });

  it('hands a row the way to open its thread when the conversation has threads', () => {
    mount({ onOpenThread: vi.fn() }, { threads: true });

    expect(screen.getByTestId('row-entry-1')).toHaveAttribute('data-can-thread', 'true');
  });

  it('draws the messages this reader has sent and the room has not echoed back', () => {
    mount({ pending: [pendingPost()], viewerAuthorId: 'author-me' });

    expect(screen.getByTestId('room-pending')).toHaveTextContent('still going');
  });

  it('draws the pending rows after the committed ones', () => {
    const { container } = mount({ pending: [pendingPost()], viewerAuthorId: 'author-me' });

    const drawn = [
      ...container.querySelectorAll('[data-testid="row-entry-2"], [data-testid="room-pending"]'),
    ];
    expect(drawn.map((el) => el.getAttribute('data-testid'))).toEqual([
      'row-entry-2',
      'room-pending',
    ]);
  });

  it('draws the host’s skeleton instead of the list while history is loading', () => {
    mount({ loading: <p>Loading conversation...</p> });

    expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
    expect(screen.queryByTestId('row-entry-1')).not.toBeInTheDocument();
  });

  it('draws the host’s empty state when there is nothing in the conversation', () => {
    mount({ rows: [], empty: <p>Nothing said here yet</p> });

    expect(screen.getByText('Nothing said here yet')).toBeInTheDocument();
  });

  it('is not empty while a message of this reader’s own is still in flight', () => {
    // A room with a message in flight is not an empty room, whatever the log
    // says — the first thing anybody ever sends here would otherwise vanish
    // into an illustration telling them to say something.
    mount({
      rows: [],
      empty: <p>Nothing said here yet</p>,
      pending: [pendingPost()],
      viewerAuthorId: 'author-me',
    });

    expect(screen.queryByText('Nothing said here yet')).not.toBeInTheDocument();
    expect(screen.getByTestId('room-pending')).toBeInTheDocument();
  });

  it('grows no live regions on a surface that announces nothing', () => {
    // Seeded defect: mount both regions unconditionally → a channel gains two
    // silent live regions, and the lane's single announcer stops being single.
    mount();

    expect(screen.queryByTestId('transcript-announcer')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-announcer')).not.toBeInTheDocument();
  });

  it('keeps both live regions mounted and empty on a surface that does announce', () => {
    // Always mounted, never conditional on having something to say: a live
    // region added to the page with words already in it is read out whole.
    mount({ transcriptAnnouncement: '', approvalAnnouncement: '' });

    expect(screen.getByTestId('transcript-announcer')).toBeEmptyDOMElement();
    expect(screen.getByTestId('approval-announcer')).toBeEmptyDOMElement();
  });

  it('says what it is announcing when there is something to announce', () => {
    mount({ transcriptAnnouncement: 'Working on it', approvalAnnouncement: 'Allowed' });

    expect(screen.getByTestId('transcript-announcer')).toHaveTextContent('Working on it');
    expect(screen.getByTestId('approval-announcer')).toHaveTextContent('Allowed');
  });

  it('answers the peek through its handle, and says when a row is nowhere', () => {
    const ref = createRef<ConversationTimelineHandle>();
    mount({ ref });

    expect(ref.current).not.toBeNull();
    expect(ref.current!.scrollToRow('room-entry-nowhere')).toBe(false);
    // Callable, and does not throw against jsdom's unlaid-out scroller.
    ref.current!.scrollToBottom();
  });

  it('reaches a row that is on screen, and leaves the reader standing on it', () => {
    const ref = createRef<ConversationTimelineHandle>();
    render(
      <Providers>
        <Conversation.Root surface="room" capabilities={BASE}>
          <Conversation.Timeline
            ref={ref}
            conversationId="room-1"
            label="Messages in #mio"
            rows={[messageRow('entry-1')]}
            renderRow={(row) => (
              // The room's own rows are focus targets with rings, which is what
              // makes focus the flash rather than a fading highlight. The real
              // row carries the same carve-out for the same reason: it is a
              // container holding its own controls, not a control.
              // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- stands in for a message row, a tab stop by design
              <div id={`room-entry-${row.id}`} tabIndex={0} data-testid="row" />
            )}
          />
        </Conversation.Root>
      </Providers>
    );

    expect(ref.current!.scrollToRow('room-entry-entry-1')).toBe(true);
    expect(screen.getByTestId('row')).toHaveFocus();
  });
});
