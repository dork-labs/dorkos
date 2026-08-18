// @vitest-environment jsdom
/**
 * `@mentions`, drawn inside a real room message.
 *
 * Slice 2c: the server resolves `@handle` occurrences to `mentionSpans` at
 * write time (`RoomEntry.mentionSpans`); this is what turns each span into a
 * {@link MentionPill} inside the message body `RoomMessage` renders. The
 * claim under test is not "a pill appears" — it is that the pill's identity
 * comes from the room's ROSTER (`authors`), never from the tag's own text,
 * and that a mention nobody can resolve degrades to plain text rather than
 * taking the message down with it.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { MentionSpan, RoomEntry } from '@dorkos/shared/room-schemas';
import { useRoomDraftStore, useRoomOpenThreadStore } from '@/layers/entities/room';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import type { RosterAuthor } from '../lib/room-timeline';
import { RoomMessage } from '../ui/RoomMessage';
import { Conversation } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '../model/room-capabilities';

// A mention pill now reads route state to build its profile link
// (`useProfileDeepLink`), and these tests mount it with no router. The link's
// own behaviour has a dedicated file — `RoomMessage.click-to-profile.test.tsx`,
// which mounts a real router and asserts the id that travels. Here it is stubbed
// so the pill renders, which is what this file is actually about.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({
      isOpen: false,
      memberId: null,
      open: vi.fn(),
      close: vi.fn(),
    }),
  };
});

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

/** The room's roster — resolved mentions draw their identity from here, and nowhere else. */
const AUTHORS = new Map<string, RosterAuthor>([
  ['ana', { id: 'ana', kind: 'human', displayName: 'Ana', handle: 'ana', origin: 'local' }],
  [
    'bo',
    {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      handle: 'bo',
      color: '#7c9cf5',
      origin: 'local',
    },
  ],
]);

function entry(text: string, mentionSpans?: MentionSpan[]): RoomEntry {
  return {
    roomId: 'room-1',
    seq: 1,
    id: 'entry-1',
    authorId: 'ana',
    kind: 'post',
    body: { text },
    mentions: mentionSpans?.map((s) => s.authorId) ?? [],
    ...(mentionSpans ? { mentionSpans } : {}),
    sessionId: null,
    cascadeRoot: 'entry-1',
    cascadeDepth: 0,
    parentEntryId: null,
    threadRootEntryId: null,
    signature: null,
    createdAt: '2026-07-26T10:00:00.000Z',
  };
}

/** One span, positioned by slicing `text` so a test cannot mistype an offset. */
function spanFor(text: string, needle: string, authorId: string): MentionSpan {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture error: "${needle}" is not in "${text}"`);
  return { offset, length: needle.length, authorId };
}

/**
 * The row under test, as an element — so a test can render it twice with a
 * different roster and assert on what the SECOND render leaves on screen.
 */
function row(target: RoomEntry, authors: ReadonlyMap<string, RosterAuthor>) {
  return (
    <RoomMessage
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'human', displayName: 'Ana' }}
      authorRef={authors.get('ana')}
      authors={authors}
      viewerAuthorId="ana"
      authorNames={new Map([['ana', 'Ana']])}
      reactionFrequents={['👍', '❤️', '🎉']}
      grouping={{ position: 'only' }}
    />
  );
}

function renderRow(target: RoomEntry, authors: ReadonlyMap<string, RosterAuthor> = AUTHORS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(row(target, authors), {
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
  });
}

/** The message body's own content region, where a mention pill would render. */
function content(): HTMLElement {
  return document.querySelector('[data-slot="message-content"]') as HTMLElement;
}

/**
 * The mention pill inside the message body, however it is currently
 * composed.
 *
 * Not queried by `[data-slot="mention-pill"]`: a RESOLVED pill is wrapped in
 * `IdentityHoverCard`, whose `HoverCardTrigger asChild` merges Radix's own
 * `data-slot="hover-card-trigger"` onto the same node and that value wins
 * over `MentionPill`'s — the same trade-off `MessageAuthorAvatar` already
 * makes for `IdentityAvatar`'s default (see that component's own test file).
 * `data-kind` (resolved) and `data-resolved="false"` (the unwrapped fallback)
 * are the two attributes that survive either way, so querying on those covers
 * both of `MentionPill`'s states without depending on which one currently
 * gets composed under a trigger.
 */
function pillOf(): HTMLElement | null {
  return content().querySelector('[data-kind], [data-resolved="false"]');
}

describe('RoomMessage — mentions inside a message', () => {
  it('draws a resolved mention as a pill, styled for the kind it resolved to', () => {
    const text = 'hey @bo can you take a look?';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    const pill = pillOf();
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('data-kind', 'agent');
    expect(pill).toHaveTextContent('Bo');
    // The rest of the sentence is still there, plainly.
    expect(content()).toHaveTextContent('hey Bo can you take a look?');
  });

  it("draws the pill from the ROSTER's identity, never from the tag's own text", () => {
    // The span's matched text is `@bo` — the handle the author actually typed
    // — but the roster is what says who that is. If the pill ever started
    // reading its label off the tag's children instead, this would still
    // pass with the wrong name, which is why it pins the roster's `displayName`
    // specifically rather than just asserting "a pill exists".
    const text = 'ping @bo about the release';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    const pill = pillOf();
    expect(pill).toHaveTextContent('Bo');
    expect(pill).not.toHaveTextContent('@bo');
  });

  it('renders a typed `<mention>` tag as plain text when the server did not span it — the spoof guard', () => {
    // The exploit this test pins: a message BODY containing raw text that
    // looks exactly like what `mention-markup.ts` would have spliced in for a
    // real mention — `bo` here is a real, resolvable roster id, so if this
    // tag were trusted it would draw a full, correctly-identified agent pill
    // for someone the server never actually addressed. `mentionSpans` is
    // empty (nobody in this test wrote `entry.mentionSpans`), which is the
    // one fact that has to gate the render: Streamdown's parser cannot tell
    // a spliced `<mention>` from a typed one, only the entry's own spans can.
    renderRow(entry('cc <mention author_id="bo">definitely bo</mention>, thanks'));

    expect(pillOf()).toBeNull();
    expect(content()).toHaveTextContent('cc definitely bo, thanks');
  });

  it('falls back to plain, unresolved text for a mention whose author has left the roster', () => {
    // A span the server wrote when the author was still a member — the
    // roster has since lost them. This must degrade, not crash the row.
    const text = 'ask @ghost when they are back';
    renderRow(entry(text, [spanFor(text, '@ghost', 'author-departed')]));

    const pill = pillOf();
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute('data-resolved', 'false');
    expect(pill).not.toHaveAttribute('data-kind');
    expect(pill).toHaveTextContent('@ghost');
    // Never wrapped in a trigger — an id nobody can vouch for gets no card.
    expect(pill).toHaveAttribute('data-slot', 'mention-pill');
    // The row itself is still fully there — a bad span cost the room nothing else.
    expect(screen.getByTestId('room-entry')).toBeInTheDocument();
    expect(content()).toHaveTextContent('ask @ghost when they are back');
  });

  it('leaves an `@token` with no span as ordinary text — no pill, resolved or not', () => {
    // The server only emits a span for a handle it actually resolved. A quoted
    // or unaddressable `@word` never gets one, and the client must not go
    // hunting for `@`s itself (`.claude/rules/room-conduct.md`: mentions
    // resolve once, at write time).
    renderRow(entry('email me at @not-a-real-mention later'));

    expect(pillOf()).toBeNull();
    expect(content()).toHaveTextContent('email me at @not-a-real-mention later');
  });

  it('renders a body with no mentionSpans at all, unmodified', () => {
    // `mentionSpans` is optional on the wire — absent for a body written
    // before the field existed. Absence must read as empty, not break.
    renderRow(entry('just an ordinary message'));

    expect(content()).toHaveTextContent('just an ordinary message');
    expect(pillOf()).toBeNull();
  });

  it('opens the identity hover card on a resolved pill, built from the roster', async () => {
    const user = userEvent.setup();
    const text = 'cc @bo';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    await user.hover(pillOf()!);

    expect(await screen.findByText('View profile')).toBeInTheDocument();
    // `@bo` — the roster's `handle` — as the card's own subtitle line.
    expect(screen.getByText('@bo')).toBeInTheDocument();
  });

  it('renders literal `<`, `>`, `&`, and inline code beside a mention safely', () => {
    // Streamdown sanitizes raw HTML through the same pipeline that lets a
    // `<mention>` tag through — this pins that the rest of the body still
    // renders as ordinary escaped text and inline code, not markup.
    const text = 'a < b & b > a `code span` — cc @bo';
    renderRow(entry(text, [spanFor(text, '@bo', 'bo')]));

    expect(content()).toHaveTextContent('a < b & b > a');
    expect(content().querySelector('code')).toHaveTextContent('code span');
    expect(pillOf()).not.toBeNull();
  });
});

/**
 * A pill is only as honest as its LAST render (DOR-989).
 *
 * The roster is live: somebody renames an agent, somebody leaves the room, and
 * every mention of them already on screen has to say so. Nothing about the
 * message itself changed, which is exactly what makes this its own suite —
 * Streamdown's top-level memo comparator (2.5.0) compares `children` and a
 * dozen display options and stops, so an update carried on the `components`
 * prop alone re-renders nothing below it and a drawn pill keeps whatever the
 * roster said the moment it was first painted.
 */
describe('RoomMessage — a drawn mention follows the roster', () => {
  /** The same room a beat later: Bo has been renamed to Bobby. */
  const RENAMED = new Map<string, RosterAuthor>([
    ...AUTHORS,
    [
      'bo',
      {
        id: 'bo',
        kind: 'agent',
        displayName: 'Bobby',
        handle: 'bobby',
        color: '#7c9cf5',
        origin: 'local',
      },
    ],
  ]);

  /** The same room a beat later: Bo has left, so nobody can vouch for the id. */
  const DEPARTED = new Map<string, RosterAuthor>([...AUTHORS].filter(([id]) => id !== 'bo'));

  it('renames a pill that was already on screen when the roster renames its author', () => {
    const text = 'hey @bo can you take a look?';
    const target = entry(text, [spanFor(text, '@bo', 'bo')]);
    const { rerender } = renderRow(target);

    expect(pillOf()).toHaveTextContent('Bo');

    rerender(row(target, RENAMED));

    expect(pillOf()).toHaveTextContent('Bobby');
    expect(content()).toHaveTextContent('hey Bobby can you take a look?');
  });

  it('drops a drawn pill back to plain text when its author leaves the room', () => {
    const text = 'ping @bo about the release';
    const target = entry(text, [spanFor(text, '@bo', 'bo')]);
    const { rerender } = renderRow(target);

    expect(pillOf()).toHaveAttribute('data-kind', 'agent');

    rerender(row(target, DEPARTED));

    const pill = pillOf();
    expect(pill).toHaveAttribute('data-resolved', 'false');
    expect(pill).not.toHaveAttribute('data-kind');
  });

  it('still refuses an unspanned `<mention>` tag after the roster changes', () => {
    // The spoof guard rides the components map, not the roster context — this
    // pins that moving identity out of that map did not take the gate with it.
    const target = entry('cc <mention author_id="bo">definitely bo</mention>, thanks');
    const { rerender } = renderRow(target);

    expect(pillOf()).toBeNull();

    rerender(row(target, RENAMED));

    expect(pillOf()).toBeNull();
    expect(content()).toHaveTextContent('cc definitely bo, thanks');
  });
});
