// @vitest-environment jsdom
/**
 * `@mentions`, drawn inside a real room message.
 *
 * Slice 2c: the server resolves `@handle` occurrences to `mentionSpans` at
 * write time (`RoomEntry.mentionSpans`); this is what turns each span into a
 * {@link MentionPill} inside the message body `RoomEntryRow` renders. The
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
import { RoomEntryRow } from '../ui/RoomEntryRow';

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
  ['ana', { id: 'ana', kind: 'human', displayName: 'Ana', mentionHandle: 'ana', origin: 'local' }],
  [
    'bo',
    {
      id: 'bo',
      kind: 'agent',
      displayName: 'Bo',
      mentionHandle: 'bo',
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

function renderRow(target: RoomEntry) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <RoomEntryRow
      roomId="room-1"
      entry={target}
      author={{ id: 'ana', kind: 'human', displayName: 'Ana' }}
      authorRef={AUTHORS.get('ana')}
      authors={AUTHORS}
      viewerAuthorId="ana"
      authorNames={new Map([['ana', 'Ana']])}
      reactionFrequents={['👍', '❤️', '🎉']}
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

describe('RoomEntryRow — mentions inside a message', () => {
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
    // `@bo` — the roster's `mentionHandle` — as the card's own subtitle line.
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
