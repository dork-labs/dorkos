// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils/mock-factories';
import type { Transport } from '@dorkos/shared/transport';
import type { RoomAttachment, RoomEntry, RoomEntryReaction } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { MessageGrouping } from '@/layers/shared/model';
import { RoomMessage } from '../ui/RoomMessage';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// The row reads route state to decide where its author face and its mention pills lead
// (`useProfileDeepLink`), and this file mounts it with no router.
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
    <RoomMessage
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
          <TooltipProvider>
            {/* The same conversation the room mounts (`RoomSurface`): its rows read
                capabilities from it, so a bench without one is testing a component
                in a state the app never puts it in. */}
            <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
              {children}
            </Conversation.Root>
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
}

describe('RoomMessage — the action surface', () => {
  it('makes the message itself the one tab stop', () => {
    // The keyboard path starts here: reaching the toolbar means reaching the
    // message first, which is also the only stop a room costs per message.
    renderRow();

    expect(screen.getByTestId('room-entry')).toHaveAttribute('tabindex', '0');
  });

  it('leaves Ctrl+End to the feed rather than taking it for the toolbar', () => {
    // Bare End is the group's own — jump to the last button.
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    const first = screen.getByRole('button', { name: 'React with thumbsup' });
    // Copy link is the capsule's last command (DOR-5046).
    const last = screen.getByRole('button', { name: 'Copy link' });

    fireEvent.keyDown(first, { key: 'End', ctrlKey: true });
    expect(last).not.toHaveFocus();
    expect(first).toHaveFocus();

    // Unmodified, it still does what it always did.
    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
  });

  it('moves into the actions on an arrow key', () => {
    renderRow();
    const row = screen.getByTestId('room-entry');
    row.focus();
    fireEvent.keyDown(row, { key: 'ArrowRight' });

    // The capsule's FIRST tenant, which is now a reaction rather than Reply.
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toHaveFocus();
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

  it('renders links as real anchors, so the browser already offers a link menu', () => {
    // Pins the premise behind having NO carve-out for a right-click on a link (DOR-1272):
    // `MarkdownContent` renders a genuine `<a href>` (`MarkdownLink`), not a button, so the
    // browser's own menu already has "Copy Link Address" to offer and our menu isn't taking
    // anything away.
    renderRow(entry({ body: { text: 'see [the run](https://example.com/run)' } }));
    const row = screen.getByTestId('room-entry');

    expect(within(row).queryByRole('button', { name: 'the run' })).not.toBeInTheDocument();
    const link = within(row).getByRole('link', { name: 'the run' });
    expect(link).toHaveAttribute('href', 'https://example.com/run');
  });

  it('indents a list the same way the session transcript does (DOR-2074)', () => {
    // `render-room-body.tsx` puts `msg-prose` on the body's `MarkdownContent` — the same
    // typography hook `StreamingText` (session) puts on its own, `index.css`'s `.msg-prose ol/ul`
    // rule being what gives a list its left padding and outside marker position.
    renderRow(entry({ body: { text: '1. one\n2. two' } }));
    const row = screen.getByTestId('room-entry');
    const list = within(row).getByRole('list');

    expect(list.closest('.msg-prose')).not.toBeNull();
  });

  it('opens the thread panel when the reply button is pressed', () => {
    renderRow(entry({ id: 'reply-9', parentEntryId: 'root-1', threadRootEntryId: 'root-1' }));

    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    // The root, not the reply that was pressed — see `replyRootFor`.
    expect(useRoomOpenThreadStore.getState().open['room-1']?.rootEntryId).toBe('root-1');
  });
});

describe('RoomMessage — telling one notice from another', () => {
  /** The notice's own mark, which is what tells the five codes apart. */
  function mark(): SVGElement | null {
    return screen.getByTestId('room-notice').querySelector('svg');
  }

  it('draws a failing schedule warm and a slept-through one quiet (DOR-4073, DOR-4078)', () => {
    renderRow(
      entry({
        kind: 'notice',
        body: {
          text: 'Weekly report failed twice in a row: an unknown error. Next try: 10:00.',
          notice: 'schedule_failed',
          scheduleRun: { scheduleId: 'weekly', runId: 'run-2' },
        },
      })
    );
    expect(screen.getByTestId('room-notice')).toHaveClass('text-foreground');
    expect(mark()).toHaveClass('text-status-warning-fg');
    // Open run is words after the sentence, not a filled button, with its hit
    // area in padding: 24px with a mouse, 44px on touch.
    const action = screen.getByRole('button', { name: 'Open run' });
    expect(action).toHaveClass(
      'underline',
      'py-1',
      '-my-1',
      'pointer-coarse:py-3.5',
      'pointer-coarse:-my-3.5'
    );
    expect(action.className).not.toMatch(/\bbg-|\bborder\b|\bh-\d/);
    cleanup();

    renderRow(
      entry({
        kind: 'notice',
        body: {
          text: 'Weekly report missed 9:00, likely because this computer was asleep.',
          notice: 'schedule_missed',
        },
      })
    );
    expect(screen.getByTestId('room-notice')).toHaveClass('text-muted-foreground');
    expect(mark()).not.toHaveClass('text-status-warning-fg');
    expect(screen.queryByRole('button', { name: 'Open run' })).toBeNull();
  });
});

describe('RoomMessage — the pills under a message', () => {
  it('ends the row with a ghost + the moment one reaction exists', () => {
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }));

    expect(screen.getByTestId('entry-reactions')).toBeInTheDocument();
    expect(screen.getByTestId('entry-reactions-add')).toBeInTheDocument();
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

  it('keeps the pills out of the tab order and reaches them with ArrowDown', () => {
    // The capsule's promise, extended: a message with ten reactions on it would otherwise cost
    // eleven presses to walk past.
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

  it('refuses a pick from a picker that was already open when the room went quiet', () => {
    // The narrow window the reviewer of #639 named: the stall arrives mid- interaction, so the
    // surface a person is looking at was drawn while the room was still live.
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

  it('stops offering reactions in a room you left — same refusal a post gets', () => {
    // DOR-1233: the owner sees every room on the install whether or not they are on its roster,
    // and a reaction on one they left refuses the identical `MEMBER_NOT_FOUND` a post does — same
    // reasoning as the stream-stalled case above, different cause.
    renderRow(entry({ reactions: [pill('👍', ['ana'])] }), { isMember: false });

    expect(screen.getByTestId('entry-reaction')).toBeDisabled();
    expect(screen.getByTestId('entry-reactions-add')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'React with thumbsup' })).toBeDisabled();
  });
});

describe('RoomMessage — the origin mark beside an entry (chats-as-channels spec §4.3, §9, DOR-879)', () => {
  /** Render one entry with its author's roster-carried `origin` set directly. */
  function renderWithOrigin(origin: 'local' | { platform: string }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <RoomMessage
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
              <TooltipProvider>
                {/* The same conversation the room mounts (`RoomSurface`): its rows read
                    capabilities from it, so a bench without one is testing a component
                    in a state the app never puts it in. */}
                <Conversation.Root surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
                  {children}
                </Conversation.Root>
              </TooltipProvider>
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
});

/** Where the files posted with a message sit, and what the row says about them. */
describe('RoomMessage — the files posted with a message', () => {
  it('hangs the files under the words and above the pills', () => {
    // Asserted by document position rather than by child index: the content column's children
    // come and go — the author line on a group start, the orphan notice, the pill row — so an
    // index would pass for the wrong reason on one grouping and fail for the wrong reason on the
    // next.
    renderRow(entry({ attachments: [file()], reactions: [pill('👍', ['ana'])] }));
    const content = document.querySelector('[data-slot="message-content"]')!;
    const files = screen.getByTestId('room-entry-attachments');
    const pills = screen.getByTestId('entry-reactions');

    expect(content.compareDocumentPosition(files) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(files.compareDocumentPosition(pills) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
