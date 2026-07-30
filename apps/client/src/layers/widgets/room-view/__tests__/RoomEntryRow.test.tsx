// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomReplyTargetStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomEntryRow } from '../ui/RoomEntryRow';

/** The shipped quick row, which is what a fresh install's capsule offers. */
const FREQUENTS = ['👍', '❤️', '🎉'];

/** The roster, as a reaction's "who reacted" line reads it. */
const NAMES = new Map([
  ['ana', 'Ana'],
  ['author-you', 'You'],
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
  useRoomReplyTargetStore.setState({ targets: {}, focusRequests: {} });
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

/**
 * The row as JSX, so a test can re-render it with one prop changed — which is
 * how "the stream died while this was on screen" is expressed.
 */
function rowElement(target: RoomEntry, streamStalled?: boolean) {
  return (
    <RoomEntryRow
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'agent', displayName: 'Ana', color: '#888' }}
      authorRef={{ id: 'ana', kind: 'agent', displayName: 'Ana', mentionHandle: 'ana' }}
      viewerAuthorId="author-you"
      authorNames={NAMES}
      reactionFrequents={FREQUENTS}
      streamStalled={streamStalled}
      grouping={{ position: 'only' }}
    />
  );
}

function renderRow(
  target: RoomEntry = entry(),
  options: { transport?: Transport; streamStalled?: boolean } = {}
) {
  const transport = options.transport ?? createMockTransport();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(rowElement(target, options.streamStalled), {
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

  it('does not repeat the author, who is already on screen', () => {
    // Naming the article "Message from Ana" over a row that visibly says "Ana"
    // makes a screen reader say it twice — the DOR-583 shape. Session chat gives
    // its rows no name for the same reason.
    renderRow();

    expect(screen.getByTestId('room-entry')).not.toHaveAccessibleName();
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

  it('renders links as safety-gated buttons, so no native link menu is at stake', () => {
    // Pins the premise behind having NO carve-out for a right-click on a link:
    // `MarkdownContent` never emits an `<a href>`, so the browser's own menu has
    // no "Copy link address" to offer and our menu is taking nothing away. If
    // this ever fails, the carve-out has to be reconsidered.
    renderRow(entry({ body: { text: 'see [the run](https://example.com/run)' } }));
    const row = screen.getByTestId('room-entry');

    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'the run' })).toBeInTheDocument();
  });

  it('aims the composer at the thread when the reply button is pressed', () => {
    renderRow(entry({ id: 'reply-9', parentEntryId: 'root-1', threadRootEntryId: 'root-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    // The root, not the reply that was pressed — see `replyRootFor`.
    expect(useRoomReplyTargetStore.getState().targets['room-1']).toBe('root-1');
  });

  it('gives a notice no actions at all', () => {
    // Nobody said it, so there is no author to mention and nothing to answer.
    renderRow(entry({ kind: 'notice', body: { text: 'Ana stopped replying here' } }));

    expect(screen.queryByTestId('entry-actions')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-entry')).not.toBeInTheDocument();
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

  it('sends ArrowDown to the capsule when there are no pills to reach', () => {
    // The behaviour the row shipped with, unchanged for the messages that have
    // no down group — which is nearly all of them.
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowDown' });

    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toHaveFocus();
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
});
