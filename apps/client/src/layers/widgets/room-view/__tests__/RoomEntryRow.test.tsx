// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomAttachment, RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { MessageGrouping } from '@/layers/shared/model';
import { RoomEntryRow } from '../ui/RoomEntryRow';

// The row reads route state to decide where its author face and its mention
// pills lead (`useProfileDeepLink`), and this file mounts it with no router.
// Where those links actually go has its own file —
// `RoomEntryRow.click-to-profile.test.tsx`, which mounts a real router and
// asserts the id that travels. Here it is stubbed so the row renders, which is
// what this file is about.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
  };
});

/** The shipped quick row, which is what a fresh install's capsule offers. */
const FREQUENTS = ['👍', '❤️', '🎉'];

/** The roster, as a reaction's "who reacted" line reads it. */
const NAMES = new Map([
  ['ana', 'Ana'],
  ['author-you', 'You'],
]);

/** The roster a `<mention>` resolves against — same members `rowElement` draws. */
const AUTHORS = new Map([
  [
    'ana',
    {
      id: 'ana',
      kind: 'agent' as const,
      displayName: 'Ana',
      handle: 'ana',
      origin: 'local' as const,
    },
  ],
  [
    'author-you',
    {
      id: 'author-you',
      kind: 'human' as const,
      displayName: 'You',
      handle: 'you',
      origin: 'local' as const,
    },
  ],
]);

/** A desktop: `useIsMobile` reads matchMedia, and the menu branches on it. */
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  useRoomDraftStore.setState({ drafts: {} });
  useRoomOpenThreadStore.setState({ open: {} });
});

function entry(overrides: Partial<RoomEntry> = {}): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text: 'why is the build slow?' },
    mentions: [],
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
    ...overrides,
  };
}

/** One pill, as the wire carries it. */
function pill(emoji: string, authorIds: string[]): RoomEntryReaction {
  return { emoji, authorIds, firstAt: '2026-07-26T10:00:00.000Z' };
}

/** One posted file, as the wire carries it — every field server-derived. */
function file(overrides: Partial<RoomAttachment> = {}): RoomAttachment {
  return {
    id: 'att-1',
    name: 'screenshot.png',
    mimeType: 'image/png',
    size: 2048,
    preview: 'image',
    url: '/api/rooms/room-1/attachments/att-1',
    ...overrides,
  };
}

/**
 * The row as JSX, so a test can re-render it with one prop changed — which is
 * how "the stream died while this was on screen" is expressed.
 */
function rowElement(
  target: RoomEntry,
  streamStalled?: boolean,
  grouping: MessageGrouping = { position: 'only' },
  isMember?: boolean
) {
  return (
    <RoomEntryRow
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'agent', displayName: 'Ana', color: '#888' }}
      authorRef={{
        id: 'ana',
        kind: 'agent',
        displayName: 'Ana',
        handle: 'ana',
        origin: 'local',
      }}
      authors={AUTHORS}
      viewerAuthorId="author-you"
      authorNames={NAMES}
      reactionFrequents={FREQUENTS}
      streamStalled={streamStalled}
      grouping={grouping}
      isMember={isMember}
    />
  );
}

function renderRow(
  target: RoomEntry = entry(),
  options: {
    transport?: Transport;
    streamStalled?: boolean;
    grouping?: MessageGrouping;
    isMember?: boolean;
  } = {}
) {
  const transport = options.transport ?? createMockTransport();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(rowElement(target, options.streamStalled, options.grouping, options.isMember), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('RoomEntryRow — the action surface', () => {
  it('draws the capsule in the one order every rendering uses', () => {
    // The design's capsule, made mechanical (`specs/room-messaging-design` §2):
    // the reader's three most-used emoji, then the picker, then the commands —
    // which kept the order they had before reactions arrived.
    //
    // Spelled out rather than compared against `ENTRY_ACTION_ORDER`. The bar now
    // BUILDS its output by mapping over that constant, so asserting against it
    // would compare the constant with itself and pass through any reordering.
    renderRow();
    const toolbar = screen.getByTestId('entry-actions');

    expect(
      within(toolbar)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label'))
    ).toEqual([
      'React with thumbsup',
      'React with heart',
      'React with tada',
      'Pick a reaction',
      'Reply in thread',
      'Copy text',
      'Mention Ana',
    ]);
  });

  it('offers the frequents the server counted, in the server’s order', () => {
    // Most-used first, and the row is whatever the server said it is — a client
    // that sorted or padded here would disagree with the capsule the NEXT
    // reaction's response hands it, and the row would reshuffle under the cursor.
    renderRow();

    expect(
      within(screen.getByTestId('entry-actions'))
        .getAllByRole('button')
        .slice(0, 3)
        .map((button) => button.textContent)
    ).toEqual(FREQUENTS);
  });

  it('makes the message itself the one tab stop', () => {
    // The keyboard path starts here: reaching the toolbar means reaching the
    // message first, which is also the only stop a room costs per message.
    renderRow();

    expect(screen.getByTestId('room-entry')).toHaveAttribute('tabindex', '0');
  });

  it('takes its name from the author line already on screen', () => {
    // Naming the article "Message from Ana" over a row that visibly says "Ana"
    // would make a screen reader say it twice — the DOR-583 shape, and why this
    // row shipped unnamed. The feed pattern needs a name to move between
    // articles WITH, so the name is the visible line pointed at rather than a
    // second sentence written for screen readers.
    renderRow();
    const row = screen.getByTestId('room-entry');

    expect(row).toHaveAccessibleName(/Ana/);
    expect(row.getAttribute('aria-labelledby')).toBe(
      screen.getByText('Ana').parentElement!.getAttribute('id')
    );
  });

  it('names a row rendered outside any feed, and gives it no place in a set', () => {
    // Naming is universal for message rows and position is one consumer of it,
    // so a row with no feed around it is still named. Pinned here so the two
    // halves stay separable: every surface that renders this row names it,
    // and only the ones that navigate a set number it.
    renderRow();
    const row = screen.getByTestId('room-entry');

    expect(row).toHaveAccessibleName(/Ana/);
    expect(row).not.toHaveAttribute('aria-posinset');
    expect(row).not.toHaveAttribute('aria-setsize');
  });

  it('names a continuation row, which has no author line to point at', () => {
    // The design drops the author line for a run from the same person. Sighted
    // readers get who is speaking from the grouping; this is how everyone else
    // gets the same fact.
    renderRow(entry(), { grouping: { position: 'middle' } });

    expect(screen.queryByText('Ana')).not.toBeInTheDocument();
    expect(screen.getByTestId('room-entry')).toHaveAccessibleName(/Ana/);
  });

  it('points at the words as the article’s description, where the words are short', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');

    expect(row.getAttribute('aria-describedby')).toBe(
      document.querySelector('[data-slot="message-content"]')!.getAttribute('id')
    );
  });

  it('describes a pasted diff in a line, instead of reading the diff out', () => {
    // The defect: the description was the whole rendered body, so landing on
    // this row announced every line of the diff before saying anything about
    // the message. Without the fix this assertion sees the diff.
    renderRow(entry({ body: { text: 'try this:\n\n```diff\n- const a = 1\n+ const a = 2\n```' } }));
    const row = screen.getByTestId('room-entry');

    expect(row).toHaveAccessibleDescription('try this: code block');
    // And the description is NOT the content element any more, which is what
    // used to carry the whole body.
    expect(row.getAttribute('aria-describedby')).not.toBe(
      document.querySelector('[data-slot="message-content"]')!.getAttribute('id')
    );
  });

  it('declares no keyboard shortcut on the row itself', () => {
    // It said "Enter" on every article, so crossing a room announced one fact
    // once per message. The capsule's discoverability moved to a named control
    // — see the touch-reachable button below — which also works on a finger.
    renderRow();

    expect(screen.getByTestId('room-entry')).not.toHaveAttribute('aria-keyshortcuts');
  });

  it('offers a named way into the actions that a touch screen reader can activate', () => {
    // The capsule is revealed by hover (no finger produces one) or by focus
    // (reached with an arrow key VoiceOver does not send), and until it is
    // revealed it is `pointer-events-none` — so a double-tap on one of its
    // buttons landed on the message underneath. This button is the way in.
    renderRow();

    const reach = screen.getByTestId('entry-actions-reach');
    expect(reach).toHaveAccessibleName('Message actions');
    // Not a tab stop: a room stays one Tab per message.
    expect(reach).toHaveAttribute('tabindex', '-1');

    fireEvent.click(reach);

    // Focus is inside the capsule, which is what turns its pointer events back
    // on (`focus-within` on the toolbar) for every button in it.
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toHaveFocus();
  });

  it('reads the actions LAST, whatever order the layout draws them in', () => {
    // Read order is what a screen reader follows, so the toolbar comes after
    // the message: a row that opened with "Reply in thread, Copy text" would
    // say what you can DO before saying who spoke or what they said. The
    // capsule still appears ABOVE the message, because `order-first` moves the
    // box without moving the reading order — which is exactly why this cannot
    // be checked by looking at the screen, and has to be pinned here.
    renderRow();
    const reach = screen.getByTestId('entry-actions-reach');
    const rail = screen.getByTestId('entry-actions').parentElement!;
    const content = document.querySelector('[data-slot="message-content"]')!;

    // The way in for a touch screen reader is announced BEFORE the toolbar it
    // hands focus to — a control that follows the thing it opens is a control
    // nobody swiping forwards reaches in time.
    expect(reach.compareDocumentPosition(rail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And both follow the words, with the rail last of everything.
    expect(content.compareDocumentPosition(reach) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(rail).toBe(rail.parentElement!.lastElementChild);
    // The visual order is the one that is inverted, and only in CSS.
    expect(rail.className).toContain('order-first');
  });

  it('carries the whole date on the time it shows', () => {
    // A room scrolled back a week shows nothing but clock times, so "which day
    // was this?" had no answer on the surface, in the markup, or to a screen
    // reader.
    renderRow();
    const stamp = document.querySelector('time')!;

    expect(stamp).toHaveAttribute('datetime', '2026-07-26T10:00:00.000Z');
    expect(stamp.getAttribute('title')).toMatch(/2026/);
  });

  it('reveals a continuation’s timestamp on focus as well as on hover', () => {
    // Hover-only meant a keyboard reader crossing a run of messages from one
    // person could not see when any of them was said — the one fact the
    // grouping takes away.
    renderRow(entry(), { grouping: { position: 'middle' } });

    expect(document.querySelector('time')!.className).toContain(
      'group-focus-within:text-msg-timestamp'
    );
  });

  it('leaves Ctrl+End to the feed rather than taking it for the toolbar', () => {
    // Bare End is the group's own — jump to the last button. The MODIFIED press
    // belongs to the feed a room's rows sit in, where it is the way out of the
    // history altogether. Pinned on a row rendered alone, because with a feed
    // around it the container's answer lands second and hides whether the group
    // grabbed it on the way past.
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    const first = screen.getByRole('button', { name: 'React with thumbsup' });
    const last = screen.getByRole('button', { name: 'Mention Ana' });

    fireEvent.keyDown(first, { key: 'End', ctrlKey: true });
    expect(last).not.toHaveFocus();
    expect(first).toHaveFocus();

    // Unmodified, it still does what it always did.
    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
  });

  it('keeps every action out of the tab order, always', () => {
    // The tab order has to be CLOSED for a room to cost one press per message.
    // Opening it while the row has focus reads like it would work and does not:
    // focusing the row makes its buttons tabbable in the same tick, so the next
    // Tab lands on the first one anyway and fifty messages still cost a hundred
    // and fifty presses.
    renderRow();
    const toolbar = screen.getByTestId('entry-actions');

    for (const button of within(toolbar).getAllByRole('button')) {
      expect(button).toHaveAttribute('tabindex', '-1');
    }
  });

  it('announces the actions as a toolbar', () => {
    renderRow();

    expect(screen.getByRole('toolbar', { name: 'Message actions' })).toBeInTheDocument();
  });

  it('moves into the actions on an arrow key', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    // The capsule's FIRST tenant, which is now a reaction rather than Reply.
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toHaveFocus();
  });

  it('moves into the actions on Enter', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toHaveFocus();
  });

  it('steps along the actions with arrows, wrapping at the ends', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    const first = screen.getByRole('button', { name: 'React with thumbsup' });
    const reply = screen.getByRole('button', { name: 'Reply in thread' });
    const copy = screen.getByRole('button', { name: 'Copy text' });
    const mention = screen.getByRole('button', { name: 'Mention Ana' });

    fireEvent.keyDown(reply, { key: 'ArrowRight' });
    expect(copy).toHaveFocus();

    fireEvent.keyDown(copy, { key: 'ArrowRight' });
    expect(mention).toHaveFocus();

    // Wraps rather than dead-ending, so the set can be cycled without looking —
    // round the whole capsule, reactions included.
    fireEvent.keyDown(mention, { key: 'ArrowRight' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(mention).toHaveFocus();
  });

  it('gives the message back its focus on Escape', () => {
    // The way out. Without it, a keyboard reader who stepped into the toolbar
    // has to Tab forward and come all the way back around.
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    fireEvent.keyDown(screen.getByRole('button', { name: 'React with thumbsup' }), {
      key: 'Escape',
    });

    expect(row).toHaveFocus();
  });

  it('leaves an arrow pressed inside the message text alone', () => {
    // Only the row itself opens the toolbar. Otherwise an arrow key used to move
    // a caret through selected text would yank focus away mid-selection.
    renderRow();
    const content = document.querySelector('[data-slot="message-content"]')!;
    fireEvent.keyDown(content, { key: 'ArrowRight', bubbles: true });

    expect(screen.getByRole('button', { name: 'React with thumbsup' })).not.toHaveFocus();
  });

  it('renders links as real anchors, so the browser already offers a link menu', () => {
    // Pins the premise behind having NO carve-out for a right-click on a link
    // (DOR-1272): `MarkdownContent` under `linkSafety` renders a genuine
    // `<a href>` (`MarkdownLink`), not a button, so the browser's own menu
    // already has "Copy Link Address" to offer and our menu isn't taking
    // anything away. If this ever fails, the carve-out has to be reconsidered.
    renderRow(entry({ body: { text: 'see [the run](https://example.com/run)' } }));
    const row = screen.getByTestId('room-entry');

    expect(within(row).queryByRole('button', { name: 'the run' })).not.toBeInTheDocument();
    const link = within(row).getByRole('link', { name: 'the run' });
    expect(link).toHaveAttribute('href', 'https://example.com/run');
  });

  it('opens the thread panel when the reply button is pressed', () => {
    renderRow(entry({ id: 'reply-9', parentEntryId: 'root-1', threadRootEntryId: 'root-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    // The root, not the reply that was pressed — see `replyRootFor`.
    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1');
  });

  it('gives a notice no actions at all', () => {
    // Nobody said it, so there is no author to mention and nothing to answer.
    renderRow(entry({ kind: 'notice', body: { text: 'Ana stopped replying here' } }));

    expect(screen.queryByTestId('entry-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
  });
});

describe('RoomEntryRow — telling one notice from another', () => {
  /** The notice's own mark, which is what tells the five codes apart. */
  function mark(): SVGElement | null {
    return screen.getByTestId('room-notice').querySelector('svg');
  }

  it('says which kind of notice it is, not just that it is one', () => {
    // The room says five different things in its own voice and drew all five
    // identically, with `body.notice` read by nothing in the client — so a turn
    // that errored looked exactly like a room admitting it widened who answers
    // here. Red if the code stops reaching the render.
    renderRow(
      entry({
        kind: 'notice',
        body: { text: 'Kai ran into a problem', notice: 'turn_failed', subjectAuthorId: 'kai' },
      })
    );

    expect(screen.getByTestId('room-notice')).toHaveAttribute('data-notice', 'turn_failed');
  });

  it('is the only notice drawn warm, because it is the only one going wrong', () => {
    renderRow(
      entry({
        kind: 'notice',
        body: { text: 'Kai ran into a problem', notice: 'turn_failed', subjectAuthorId: 'kai' },
      })
    );
    expect(screen.getByTestId('room-notice')).toHaveClass('text-status-warning');
    const failedMark = mark()?.outerHTML;
    cleanup();

    // Everything else is the room working as designed and saying so. A column of
    // amber over a busy afternoon teaches a reader to stop looking.
    for (const code of ['agent_busy', 'budget_reached', 'cascade_stopped'] as const) {
      renderRow(entry({ kind: 'notice', body: { text: 'the room said something', notice: code } }));
      const row = screen.getByTestId('room-notice');
      expect(row).toHaveClass('text-muted-foreground');
      expect(row).not.toHaveClass('text-status-warning');
      // …and still tells itself apart from the failure, by its mark.
      expect(mark()?.outerHTML).not.toBe(failedMark);
      cleanup();
    }
  });

  it('draws the mark as decoration, never as a second sentence', () => {
    // An icon with a name would make a screen reader read "warning" ahead of a
    // sentence that goes on to explain itself in full.
    renderRow(
      entry({
        kind: 'notice',
        body: { text: 'Kai ran into a problem', notice: 'turn_failed', subjectAuthorId: 'kai' },
      })
    );

    expect(mark()).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('room-notice').textContent).toBe('Kai ran into a problem');
  });

  it('still draws a notice whose code this client has never heard of', () => {
    // The server adds codes; a client that is a release behind must not render a
    // blank line where a sentence should be.
    renderRow(entry({ kind: 'notice', body: { text: 'something new happened' } }));

    expect(screen.getByTestId('room-notice')).toHaveTextContent('something new happened');
    expect(mark()).not.toBeNull();
  });
});

describe('RoomEntryRow — the pills under a message', () => {
  it('draws nothing at all under a message nobody has reacted to', () => {
    // Behaviour 4's other half, and the one that keeps a room quiet: no pill
    // row, and no ghost + either. The affordance is the capsule until there is
    // something for a ghost to sit beside.
    renderRow();

    expect(screen.queryByTestId('entry-reactions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entry-reactions-add')).not.toBeInTheDocument();
  });

  it('ends the row with a ghost + the moment one reaction exists', () => {
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }));

    expect(screen.getByTestId('entry-reactions')).toBeInTheDocument();
    expect(screen.getByTestId('entry-reactions-add')).toBeInTheDocument();
  });

  it('glows the pill the reader is on, and leaves the others plain', () => {
    renderRow(entry({ reactions: [pill('👍', ['ana', 'author-you']), pill('🎉', ['ana'])] }));

    const [mine, theirs] = screen.getAllByTestId('entry-reaction');
    expect(mine).toHaveAttribute('data-mine', 'true');
    expect(mine).toHaveAttribute('aria-pressed', 'true');
    expect(theirs).not.toHaveAttribute('data-mine');
    expect(theirs).toHaveAttribute('aria-pressed', 'false');
  });

  it('names who reacted rather than counting them', () => {
    renderRow(entry({ reactions: [pill('👍', ['ana', 'author-you'])] }));

    // The reader first, and by name for everybody else — a count would answer a
    // question nobody in a five-person room is asking.
    expect(screen.getByTestId('entry-reaction')).toHaveAttribute('title', 'You and Ana reacted 👍');
  });

  it('gives a pill no invisible reach, because measurement said it made things worse', () => {
    // A pill renders 50.7×26 on a 390px phone, which clears WCAG 2.5.8 on its
    // own. It briefly carried 12px of `::after` reach to claim 44px, and in
    // Chromium that put it under the thread reply row's own reach — the pill's
    // real target dropped to 30px and 18px of it opened a thread instead. The
    // reach is gone; the size is the size.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }));

    expect(screen.getByTestId('entry-reaction').className).not.toContain('after:');
  });

  it('takes a reaction back when its own pill is pressed', async () => {
    const transport = createMockTransport();
    renderRow(entry({ reactions: [pill('👍', ['author-you'])] }), { transport });

    fireEvent.click(screen.getByTestId('entry-reaction'));

    // `on: false`, named rather than flipped — the one body a retry survives.
    await vi.waitFor(() =>
      expect(transport.toggleReaction).toHaveBeenCalledWith('room-1', 'entry-1', {
        emoji: '👍',
        on: false,
      })
    );
  });

  it('wraps ten pills and puts the rest behind “+N more”', () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      pill(String.fromCodePoint(0x1f600 + i), ['ana'])
    );
    renderRow(entry({ reactions: many }));

    expect(screen.getAllByTestId('entry-reaction')).toHaveLength(10);
    expect(screen.getByTestId('entry-reactions-more')).toHaveTextContent('+3 more');

    // A count with somewhere to go, not a label about reactions you cannot see.
    fireEvent.click(screen.getByTestId('entry-reactions-more'));
    expect(screen.getAllByTestId('entry-reaction')).toHaveLength(13);
  });

  it('keeps the pills out of the tab order and reaches them with ArrowDown', () => {
    // The capsule's promise, extended: a message with ten reactions on it would
    // otherwise cost eleven presses to walk past. Up and right reach the capsule
    // above the message; down reaches the pills below it.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }));
    const row = screen.getByTestId('room-entry');

    for (const button of within(screen.getByTestId('entry-reactions')).getAllByRole('button')) {
      expect(button).toHaveAttribute('tabindex', '-1');
    }

    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowDown' });
    expect(screen.getByTestId('entry-reaction')).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId('entry-reaction'), { key: 'Escape' });
    expect(row).toHaveFocus();
  });

  it('leaves the arrows to the reader when there is no group below the message', () => {
    // Changed deliberately (DOR-757, N-f). ArrowUp and ArrowDown used to be
    // swallowed into the capsule by every message, so a keyboard reader on a
    // message longer than the window could not scroll through it without
    // leaving the message first. The capsule keeps ArrowRight and Enter, which
    // is two ways in; the arrows go back to scrolling.
    renderRow();
    const row = screen.getByTestId('room-entry');
    const first = screen.getByRole('button', { name: 'React with thumbsup' });

    row.focus();
    const down = fireEvent.keyDown(row, { key: 'ArrowDown' });
    expect(first).not.toHaveFocus();
    expect(down).toBe(true); // not prevented, so the scroller still gets it

    const up = fireEvent.keyDown(row, { key: 'ArrowUp' });
    expect(first).not.toHaveFocus();
    expect(up).toBe(true);
  });

  it('refuses a pick from a picker that was already open when the room went quiet', () => {
    // The narrow window the reviewer of #639 named: the stall arrives mid-
    // interaction, so the surface a person is looking at was drawn while the
    // room was still live. Every other reaction control is gated at press time;
    // this one is a whole grid that was already on screen.
    const transport = createMockTransport();
    const held = entry({ reactions: [pill('👍', ['ana'])] });
    const { rerender } = renderRow(held, { transport });

    // Open it while the room is healthy.
    fireEvent.click(screen.getByTestId('entry-reactions-add'));
    const picker = screen.getByTestId('reaction-picker');
    const option = within(picker).getAllByRole('button')[0]!;
    expect(option).toBeEnabled();

    // The stream gives up with the picker still open.
    rerender(rowElement(held, true));

    expect(within(screen.getByTestId('reaction-picker')).getAllByRole('button')[0]).toBeDisabled();
    fireEvent.click(within(screen.getByTestId('reaction-picker')).getAllByRole('button')[0]!);
    expect(transport.toggleReaction).not.toHaveBeenCalled();
  });

  it('stops offering reactions when the room has stopped listening', () => {
    // Reactions go with the composer (design record §4): a write whose result
    // would never come back is worse than a control that says it cannot be used.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }), { streamStalled: true });

    expect(screen.getByTestId('entry-reaction')).toBeDisabled();
    expect(screen.getByTestId('entry-reactions-add')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toBeDisabled();
  });

  it('stops offering reactions in a room you left — same refusal a post gets', () => {
    // DOR-1233: the owner sees every room on the install whether or not they
    // are on its roster, and a reaction on one they left refuses the
    // identical `MEMBER_NOT_FOUND` a post does — same reasoning as the
    // stream-stalled case above, different cause.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }), { isMember: false });

    expect(screen.getByTestId('entry-reaction')).toBeDisabled();
    expect(screen.getByTestId('entry-reactions-add')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toBeDisabled();
  });

  it('offers reactions normally once membership is not in question', () => {
    // The default (`isMember` omitted) has to keep meaning "yes" — no caller
    // resolves membership before this row exists today, so an `undefined`
    // read as "unknown, so disable" would silently mute reactions everywhere.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }));

    expect(screen.getByTestId('entry-reaction')).not.toBeDisabled();
  });
});

describe('RoomEntryRow — the origin mark beside an entry (chats-as-channels spec §4.3, §9, DOR-879)', () => {
  /** Render one entry with its author's roster-carried `origin` set directly. */
  function renderWithOrigin(origin: 'local' | { platform: string }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <RoomEntryRow
        roomId="room-1"
        entry={entry()}
        author={{
          id: 'ana',
          kind: 'human',
          displayName: 'Miguel',
          color: '#888',
          isExternal: origin !== 'local',
        }}
        authorRef={{
          id: 'ana',
          kind: 'human',
          displayName: 'Miguel',
          handle: 'miguel',
          origin,
        }}
        authors={AUTHORS}
        viewerAuthorId="author-you"
        authorNames={NAMES}
        reactionFrequents={FREQUENTS}
        grouping={{ position: 'only' }}
      />,
      {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={createMockTransport()}>
              <TooltipProvider>{children}</TooltipProvider>
            </TransportProvider>
          </QueryClientProvider>
        ),
      }
    );
  }

  it('marks an external author beside their message — legible at a glance, not a tooltip', () => {
    renderWithOrigin({ platform: 'telegram' });

    const mark = screen.getByTestId('origin-mark');
    expect(mark).toHaveTextContent('Telegram');
    expect(mark).toBeVisible();
  });

  it('marks nothing for a local author', () => {
    renderWithOrigin('local');
    expect(screen.queryByTestId('origin-mark')).not.toBeInTheDocument();
  });
});

/**
 * The row derives `messageItem`'s slots ONCE and hands each one to a different
 * part of itself as an ordinary string prop — the gutter's class to the gutter,
 * the toolbar's to the toolbar, and so on. Nothing about a string prop says
 * which slot it came from, so two of them can be crossed and every other test
 * in this file still passes: the row renders, the words are there, the buttons
 * work, and the page is quietly wrong. These are the assertions that notice.
 *
 * Each one pins a token no other slot carries, so a swap cannot land on a
 * lookalike — `text-xs` versus `text-[10px]` is the whole difference between the
 * timestamp on a group's first line and the one that appears in the gutter on
 * hover.
 */
describe('RoomEntryRow — the layout slot each part is drawn with', () => {
  /** The row's two columns, in DOM order: the identity gutter, then the body. */
  function columns(): { gutter: HTMLElement; body: HTMLElement } {
    const row = screen.getByTestId('room-entry');
    return { gutter: row.children[0] as HTMLElement, body: row.children[1] as HTMLElement };
  }

  it('draws the row itself from the root slot', () => {
    renderRow();

    expect(screen.getByTestId('room-entry')).toHaveClass('rounded-msg');
  });

  it('draws the identity column from the gutter slot, and the rest from the body slot', () => {
    // The fixed-width identity column is what makes every author line up; a
    // body drawn with it would be one avatar wide.
    renderRow();
    const { gutter, body } = columns();

    expect(gutter).toHaveClass('w-[var(--msg-gutter-width)]');
    expect(body).toHaveClass('flex-1');
    expect(body).not.toHaveClass('w-[var(--msg-gutter-width)]');
  });

  it('draws the author line and the name in it from their own slots', () => {
    renderRow();
    const name = screen.getByText('Ana');

    // `items-baseline` is what sits the name, the origin mark and the time on
    // one line rather than stacking them.
    expect(name.parentElement).toHaveClass('items-baseline');
    expect(name).toHaveClass('font-medium');
  });

  it('draws each timestamp from the slot for where it sits', () => {
    // A group start's time sits on the author line; a continuation's sits in
    // the gutter, smaller and absolutely placed. Crossing the two is invisible
    // in a snapshot and obvious on a screen.
    renderRow();
    expect(document.querySelector('time')).toHaveClass('text-xs');

    cleanup();
    renderRow(entry(), { grouping: { position: 'middle' } });
    expect(document.querySelector('time')).toHaveClass('text-[10px]');
  });

  it('draws the words from the content slot and the toolbar from the actions slot', () => {
    renderRow();

    // The measure a message's prose is read at.
    expect(document.querySelector('[data-slot="message-content"]')).toHaveClass(
      'max-w-[var(--msg-content-max-width)]'
    );
    // Opaque, because the capsule is drawn ON TOP of the words it acts on.
    expect(screen.getByTestId('entry-actions')).toHaveClass('bg-popover');
  });
});

/**
 * Where the files posted with a message sit, and what the row says about them.
 *
 * The block itself is `RoomEntryAttachments` and is tested there. What only the
 * whole row can answer is where it lands in the content column and whether a
 * message with no files still renders exactly as it did before rooms carried
 * any — which is every message written until now.
 */
describe('RoomEntryRow — the files posted with a message', () => {
  it('hangs the files under the words and above the pills', () => {
    // Asserted by document position rather than by child index: the content
    // column's children come and go — the author line on a group start, the
    // orphan notice, the pill row — so an index would pass for the wrong reason
    // on one grouping and fail for the wrong reason on the next.
    renderRow(entry({ attachments: [file()], reactions: [pill('👍', ['ana'])] }));
    const content = document.querySelector('[data-slot="message-content"]')!;
    const files = screen.getByTestId('room-entry-attachments');
    const pills = screen.getByTestId('entry-reactions');

    expect(content.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(files.compareDocumentPosition(pills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('tells a screen reader a file came with the words, in the one description', () => {
    // The block is a SIBLING of the rendered body, so a description pointing at
    // the body alone would say nothing about it — a reader crossing the room
    // would hear "why is the build slow?" and never learn a screenshot came
    // with it. One description per row, holding both.
    renderRow(entry({ attachments: [file()] }));

    expect(screen.getByTestId('room-entry')).toHaveAccessibleDescription(
      'why is the build slow? 1 file: screenshot.png'
    );
  });

  /**
   * The row's markup with `useId`'s counter flattened out. Every id on the row
   * is minted from one `useId`, and the counter runs on for the life of the
   * module — so two renderings of the same tree differ by the id and by nothing
   * else, and comparing them raw would only ever prove that.
   */
  function markup(): string {
    return screen.getByTestId('room-entry').outerHTML.replace(/_r_[0-9a-z]+_/g, 'ID');
  }

  it('leaves a message with no files exactly as it was', () => {
    // Byte-identical, not merely "looks fine": an entry written before rooms
    // carried files has no `attachments` field at all, and an empty one is the
    // same row — no wrapper, no rail, no ghost.
    renderRow(entry());
    const without = markup();
    expect(screen.queryByTestId('room-entry-attachments')).not.toBeInTheDocument();
    // And the words still describe the row — the summary path a message WITH
    // files takes must not have moved the one a message without files takes.
    expect(screen.getByTestId('room-entry').getAttribute('aria-describedby')).toBe(
      document.querySelector('[data-slot="message-content"]')!.getAttribute('id')
    );

    cleanup();
    renderRow(entry({ attachments: [] }));

    expect(markup()).toBe(without);
  });
});
