// @vitest-environment jsdom
/**
 * What `Conversation.Timeline` promises both surfaces.
 *
 * Deliberately NOT about geometry: jsdom reports every element as 0 x 0, so
 * "did it scroll" is a browser question and `apps/e2e` is where it is asked.
 * What can be answered here is what the list DRAWS and what it hands its host.
 */
import { createRef, type ReactNode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
/**
 * The two moves a landing makes, hoisted so a test can read WHICH row it was
 * taken to — the wrapper's `data-landed-on` says what KIND of landing happened
 * and cannot tell two `requested` landings apart.
 */
const virtual = vi.hoisted(() => ({ scrollToIndex: vi.fn(), scrollToEnd: vi.fn() }));
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
    scrollToEnd: virtual.scrollToEnd,
    scrollToIndex: virtual.scrollToIndex,
    isAtEnd: () => true,
  }),
}));
import type { PendingPost } from '@/layers/entities/room';
import { Conversation } from '..';
import type { ConversationCapabilities } from '../model/capabilities';
import type { ConversationRow, ConversationRowRenderer } from '../lib/row-kinds';
import { LANDING_MARK_MS, type ConversationTimelineHandle } from '../ui/Timeline';

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
  mentions: false,
  streamHealth: false,
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

/**
 * A `landOnRow` getter that answers ONCE, which is the shipped contract.
 *
 * Reading a request consumes it (`TimelineLandingInput.landOnRow`), so a test
 * handing over `() => 'entry-1'` is testing a thing the product does not do —
 * and would go on passing after the two defects that contract exists to close
 * came back.
 */
function oneShot(rowId: string): () => string | undefined {
  let unanswered = true;
  return () => {
    if (!unanswered) return undefined;
    unanswered = false;
    return rowId;
  };
}

/**
 * A row that can hold the caret, drawn under the DOM id a host addresses it by.
 *
 * The plain `renderRow` above draws neither, which is right for the tests about
 * what the list DECIDES and useless for the one about what it MARKS: an element
 * with no id cannot be found and one with no tabindex cannot be focused.
 */
const focusableRow: ConversationRowRenderer = (row) => (
  <div id={`room-entry-${row.id}`} tabIndex={-1} data-testid={`focusable-${row.id}`}>
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

/**
 * The tree {@link mount} renders, exposed so a test can re-render it.
 *
 * A `rerender` needs the whole element again, and the landing's re-arm can only
 * be seen ACROSS a render — the same getter answering something new.
 */
function tree(
  props: Partial<Parameters<typeof Conversation.Timeline>[0]> = {},
  capabilities: Partial<ConversationCapabilities> = {}
) {
  return (
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

/** Mount a timeline inside the conversation every part reads. */
function mount(
  props: Partial<Parameters<typeof Conversation.Timeline>[0]> = {},
  capabilities: Partial<ConversationCapabilities> = {}
) {
  return render(tree(props, capabilities));
}

afterEach(() => {
  virtual.scrollToIndex.mockClear();
  virtual.scrollToEnd.mockClear();
});

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

  it('publishes the message-row count, not the row count', () => {
    // e2e's `waitForHistory` (apps/e2e/pages/RoomsPage.ts, DOR-1377) polls
    // `data-message-row-count` to know a room's whole history has landed,
    // instead of inferring it from the scroller's measured/estimated height. A
    // day divider is a row the virtualizer counts but is not a seeded message,
    // so it must NOT inflate this number — otherwise the same "estimate looks
    // like the real count" trap the geometry check fell into just moves here.
    mount({
      'data-testid': 'timeline',
      rows: [
        { kind: 'day-divider', id: 'divider-1', label: 'Today' },
        messageRow('entry-1'),
        messageRow('entry-2'),
      ],
    });

    expect(screen.getByTestId('timeline')).toHaveAttribute('data-message-row-count', '2');
  });

  describe('where it opens', () => {
    /** The landing's own answer, which only the wrapper publishes. */
    function landedOn(props: Partial<Parameters<typeof Conversation.Timeline>[0]> = {}) {
      mount({ 'data-testid': 'timeline', ...props });
      return screen.getByTestId('timeline').getAttribute('data-landed-on');
    }

    it('opens at the newest message when there is nothing to come back to', () => {
      expect(landedOn()).toBe('end');
    });

    it('comes back to the row the reader was on', () => {
      // **Seeded defect:** ignore `resumeRow` in the landing → red. This is the
      // phone thread-return fix: the panel is a full-screen push that unmounts
      // the whole timeline, so the row has to be asked for at landing time and
      // the host is the only thing that survives to answer.
      expect(landedOn({ resumeRow: () => 'entry-2' })).toBe('remembered');
    });

    it('says so when the remembered row is no longer in the loaded page', () => {
      // Distinct from `end` on purpose: the reader DID have a position and it
      // could not be honoured, which is a different event from never having had
      // one — and the browser suites tell the two apart by this word alone.
      expect(landedOn({ resumeRow: () => 'entry-gone' })).toBe('end-row-gone');
    });

    it('opens on the row it was ASKED for', () => {
      // DOR-687: a search hit addresses one message, and this is the landing
      // that honours it. Seeded defect: drop the `landOnRow` branch → `end`.
      expect(landedOn({ landOnRow: oneShot('entry-1') })).toBe('requested');
    });

    it('puts an UNANSWERED request ahead of a remembered position', () => {
      // The precedence, and the only assertion that can catch it being wrong:
      // both getters answer with a row that IS in the page, so whichever branch
      // runs first decides. Flip the two and this reads 'remembered'.
      //
      // "Unanswered" is the whole qualification — see the remount case below.
      expect(landedOn({ landOnRow: oneShot('entry-1'), resumeRow: () => 'entry-2' })).toBe(
        'requested'
      );
    });

    it('stands down for a remembered position once the request has been answered', () => {
      // **The remount defect.** On a phone the thread panel is a full-screen
      // push that UNMOUNTS the timeline, so closing one mounts a fresh landing
      // with the same getters. A request that kept answering would win that
      // landing too — throwing a reader who had scrolled to message 300 back to
      // the message they searched for, every single time they closed a thread.
      // That is the exact thing `resumeRow` exists to prevent.
      const landOnRow = oneShot('entry-1');
      const resumeRow = () => 'entry-2';

      mount({ 'data-testid': 'timeline', landOnRow, resumeRow });
      expect(screen.getByTestId('timeline')).toHaveAttribute('data-landed-on', 'requested');
      cleanup();

      // The same getters, a brand new timeline — which is what a remount is.
      mount({ 'data-testid': 'timeline', landOnRow, resumeRow });
      expect(screen.getByTestId('timeline')).toHaveAttribute('data-landed-on', 'remembered');
    });

    it('re-opens the landing for a NEW request in the SAME conversation', () => {
      // **The blocker.** Clicking a search hit in the room you are already
      // reading is an in-place search-param navigation: `conversationId` does
      // not change, so the arm guard never lifts on its own and the room used
      // to sit exactly where it was while the URL claimed otherwise.
      //
      // Asserted on the INDEX the list was taken to, because `data-landed-on`
      // reads 'requested' both times and cannot tell the two apart.
      let answer: string | undefined = 'entry-1';
      const landOnRow = () => {
        const asked = answer;
        answer = undefined;
        return asked;
      };
      const { rerender } = mount({ 'data-testid': 'timeline', landOnRow });
      expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(0, { align: 'center' });

      // A second search, answered in the room already on screen.
      answer = 'entry-2';
      rerender(tree({ 'data-testid': 'timeline', landOnRow }));

      expect(virtual.scrollToIndex).toHaveBeenLastCalledWith(1, { align: 'center' });
    });

    it('leaves a reader where they are when a NEW request names a row that is not here', () => {
      // The other half of the re-arm: a re-opened landing that cannot be
      // honoured must not restart the ORDINARY landing. The reader is somewhere
      // in this history by their own hand, and yanking them to its newest
      // message because the message they asked for is not here would take away
      // their place and give nothing back.
      let answer: string | undefined = 'entry-1';
      const landOnRow = () => {
        const asked = answer;
        answer = undefined;
        return asked;
      };
      const { rerender } = mount({ 'data-testid': 'timeline', landOnRow });
      virtual.scrollToIndex.mockClear();
      virtual.scrollToEnd.mockClear();

      answer = 'entry-gone';
      rerender(tree({ 'data-testid': 'timeline', landOnRow }));

      expect(virtual.scrollToIndex).not.toHaveBeenCalled();
      expect(virtual.scrollToEnd).not.toHaveBeenCalled();
    });

    it('falls back to the usual landing when the asked-for row is not in the page', () => {
      // A room whose history no longer reaches the message a link names. The
      // link must not swallow the landing — the room still opens somewhere
      // sensible, and `useEntryLanding` is what says so out loud.
      expect(landedOn({ landOnRow: oneShot('entry-gone') })).toBe('end');
    });

    it('leaves a remembered position standing when the asked-for row is not there', () => {
      expect(landedOn({ landOnRow: oneShot('entry-gone'), resumeRow: () => 'entry-2' })).toBe(
        'remembered'
      );
    });

    it('leaves the caret on the row it was asked for, which is the mark', () => {
      // "Focus IS the flash" — the same doctrine `scrollToRow` states. Without
      // it a reader lands somewhere in a wall of messages with nothing saying
      // which one answered them. Geometry is a browser question (jsdom lays
      // nothing out); WHICH element ends up focused is answerable here.
      mount({
        renderRow: focusableRow,
        domIdOf: (row) => `room-entry-${row.id}`,
        landOnRow: oneShot('entry-2'),
      });

      // A frame later, because the row may have had to be scrolled into
      // existence first.
      return waitFor(() =>
        expect(document.activeElement).toBe(document.getElementById('room-entry-entry-2'))
      );
    });

    it('marks the landed row visibly, not only with the caret', async () => {
      // **`:focus-visible` is why this exists.** A row focused
      // PROGRAMMATICALLY after a MOUSE click does not match it, and clicking a
      // search result is the mouse path — so the ring a reader was promised
      // could be drawn for a keyboard user and never for anybody else.
      // `data-landed` is styled unconditionally (`index.css`).
      //
      // Only the ATTRIBUTE and its removal are asserted here: jsdom computes no
      // styles and runs no animations, so what the mark LOOKS like was settled
      // in design (a fading inset ring, with a still one under
      // `prefers-reduced-motion`) and is a browser's question.
      vi.useFakeTimers();
      try {
        mount({
          renderRow: focusableRow,
          domIdOf: (row) => `room-entry-${row.id}`,
          landOnRow: oneShot('entry-2'),
        });

        await vi.waitFor(() =>
          expect(document.getElementById('room-entry-entry-2')).toHaveAttribute(
            'data-landed',
            'true'
          )
        );

        // And it stops talking on its own. A mark that stayed would be
        // furniture on every row a reader ever searched for.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(LANDING_MARK_MS + 100);
        });
        expect(document.getElementById('room-entry-entry-2')).not.toHaveAttribute('data-landed');
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks no row when nothing was asked for', () => {
      // The positive control for the mark: without it, a timeline that marked a
      // row on every open would pass the test above.
      mount({ renderRow: focusableRow, domIdOf: (row) => `room-entry-${row.id}` });

      expect(document.querySelector('[data-landed]')).toBeNull();
    });

    it('leaves the caret alone when nothing was asked for', () => {
      // The positive control. Without it the test above passes against a
      // timeline that focuses a row on every open.
      mount({ renderRow: focusableRow, domIdOf: (row) => `room-entry-${row.id}` });

      expect(document.activeElement).toBe(document.body);
    });
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
