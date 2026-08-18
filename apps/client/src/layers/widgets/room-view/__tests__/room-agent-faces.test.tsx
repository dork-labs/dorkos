// @vitest-environment jsdom
/**
 * One agent, one face, everywhere in a room (DOR-1002).
 *
 * Four surfaces here could not reach the fleet on their own and each used to
 * decide for itself: the masthead's roster stack and the room's own mark, both
 * drawn by `entities/room`; the message gutter, drawn from `toMessageAuthor`;
 * and a mention's hover card. All four fell back to the author row's render
 * cache — which almost no agent fills — so the same agent wore its real face in
 * the sidebar and a bare letter in the room, or in a DM wore its face in the
 * roster and a letter in the mark 200px away.
 *
 * **This file tests the WIRING, which the unit tests cannot see.** The parity
 * test proves `MemberList` uses an override it is handed, and
 * `RoomTimeline.test.tsx` proves `toMessageAuthor` does; neither notices if a
 * caller stops handing one over. So nothing here passes a face in by hand: the
 * fleet is mocked at the transport, exactly the two calls the real hook makes,
 * and every assertion is what a person would see on screen.
 *
 * The manifest names its own icon and colour rather than leaving them hashed,
 * so an assertion can name the glyph it expects — and so each case doubles as
 * proof that an agent's OWN choice arrives, not a hash that happens to look
 * stable.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import {
  agentAuthorRef,
  type RoomEntry,
  type RoomRosterEntry,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RoomHeader } from '../ui/RoomHeader';
import { ConversationRoot } from '@/layers/features/conversation';
import { ROOM_CAPABILITIES } from '@/layers/widgets/room-view';
import { RoomTimeline } from '../ui/RoomTimeline';

// A mention pill reads route state to build its profile link
// (`useProfileDeepLink`), and this file mounts it with no router — without the
// stub the message body renders as "This content couldn't be displayed" and
// every face assertion below is reading an error boundary. The link's own
// behaviour has a dedicated file (`RoomEntryRow.click-to-profile.test.tsx`),
// which mounts a real router; here it is stubbed so the pill renders at all.
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useProfileDeepLink: () => ({ isOpen: false, memberId: null, open: vi.fn(), close: vi.fn() }),
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

afterEach(cleanup);

const KAI_PATH = '/w/kai';
const KAI_MANIFEST_ID = '01JKAIMANIFESTULID';
/** The icon Kai's own manifest carries — the face the sidebar draws for it. */
const KAI_ICON = '🦊';
const KAI_COLOR = '#15803d';

/** An agent on the roster that this cockpit's fleet has never heard of. */
const GHOST_PATH = '/w/ghost';

/**
 * One roster row, carrying what a room actually holds: an author id from a
 * different id space than the manifest, no cached face, and the `agentRef`
 * that is the only bridge between the two.
 */
function agentMember(id: string, displayName: string, path: string): RoomRosterEntry {
  return {
    roomId: 'room-1',
    authorId: id,
    responseMode: 'always',
    joinedAt: '2026-08-10T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: {
      id,
      kind: 'agent',
      displayName,
      handle: displayName.toLowerCase(),
      agentRef: agentAuthorRef(path),
    },
  };
}

const KAI_MEMBER = agentMember('author-kai', 'Kai', KAI_PATH);
const GHOST_MEMBER = agentMember('author-ghost', 'Ghost', GHOST_PATH);

function room(kind: 'channel' | 'dm', members: RoomRosterEntry[]): RoomWithRoster {
  return {
    id: 'room-1',
    kind,
    slug: 'general',
    title: 'general',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-10T09:00:00.000Z',
    lastActivityAt: '2026-08-10T09:00:00.000Z',
    reactionFrequents: [],
    viewerAuthorId: 'author-you',
    members,
  };
}

/** A post by Kai that also mentions Kai, spanned exactly as the server spans it. */
const MENTION_TEXT = 'ask @kai about it';
const ENTRY: RoomEntry = {
  roomId: 'room-1',
  seq: 1,
  id: 'entry-1',
  authorId: 'author-kai',
  kind: 'post',
  body: { text: MENTION_TEXT },
  mentions: ['author-kai'],
  mentionSpans: [
    { offset: MENTION_TEXT.indexOf('@kai'), length: '@kai'.length, authorId: 'author-kai' },
  ],
  sessionId: null,
  cascadeRoot: 'entry-1',
  cascadeDepth: 0,
  parentEntryId: null,
  threadRootEntryId: null,
  signature: null,
  createdAt: '2026-08-10T10:00:00.000Z',
};

/** The fleet answering for Kai — and never for Ghost — through the real two calls. */
function fleetAnswering(): Partial<Transport> {
  return {
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: KAI_PATH }] }),
    resolveAgents: vi.fn().mockResolvedValue({
      [KAI_PATH]: {
        id: KAI_MANIFEST_ID,
        runtime: 'claude-code',
        icon: KAI_ICON,
        color: KAI_COLOR,
      },
    }),
  } as unknown as Partial<Transport>;
}

function renderIn(ui: ReactNode, overrides: Partial<Transport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const transport = createMockTransport(overrides);
  transport.listRooms = vi.fn().mockResolvedValue([]);
  render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>
          <TooltipProvider>
            {/* The same conversation the room mounts (`RoomSurface`): its rows read
              capabilities from it, so a bench without one is testing a component
              in a state the app never puts it in. */}
            <ConversationRoot surface="room" capabilities={ROOM_CAPABILITIES} anchor="rail">
              {children}
            </ConversationRoot>
          </TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
  return { transport };
}

/**
 * What each disc of a kind drew, in document order.
 *
 * The FIRST child of each, because the masthead's disc also carries an
 * `sr-only` name and reading the whole subtree would compare a glyph against a
 * glyph plus a name. A list rather than one, so a render holding a resolvable
 * and an unresolvable agent can be read in a single tick.
 */
function glyphsOf(slot: string): string[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)].map(
    (disc) => disc.firstElementChild?.textContent ?? ''
  );
}

/** The timeline, rendered for one room's roster. */
function timeline(members: RoomRosterEntry[]) {
  return (
    <RoomTimeline
      roomId="room-1"
      roomName="general"
      viewerAuthorId="author-you"
      entries={[ENTRY]}
      members={members}
      lastReadSeq={null}
      reactionFrequents={[]}
      isLoading={false}
      error={null}
      onAddAgents={vi.fn()}
      onOpenThread={vi.fn()}
    />
  );
}

describe('an agent wears its own face across a room', () => {
  it('draws the manifest face in the masthead roster', async () => {
    renderIn(
      <RoomHeader room={room('channel', [KAI_MEMBER])} onOpenMembers={() => {}} />,
      fleetAnswering()
    );

    // The roster is drawn from the room immediately and the fleet answers
    // afterwards, so this waits rather than reading once: the letter is on
    // screen first, and the face replacing it is the behaviour under test.
    await waitFor(() => expect(glyphsOf('room-member-avatar')).toEqual([KAI_ICON]));
  });

  it('draws the same manifest face in the room’s own mark for a direct message', async () => {
    // The mark and the roster stack sit 200px apart in the same masthead. Only
    // a DM draws a face here — `RoomAvatar` decides that, which is why the
    // channel cases above pass it the same faces and see no change.
    renderIn(
      <RoomHeader room={room('dm', [KAI_MEMBER])} onOpenMembers={() => {}} />,
      fleetAnswering()
    );

    await waitFor(() => expect(glyphsOf('room-avatar')).toEqual([KAI_ICON]));
  });

  it('draws the same manifest face in the message gutter', async () => {
    renderIn(timeline([KAI_MEMBER]), fleetAnswering());

    expect(await screen.findByText(/ask/)).toBeInTheDocument();
    await waitFor(() => expect(glyphsOf('message-author-avatar')).toEqual([KAI_ICON]));
  });

  it('draws the same manifest face on the hover card a mention opens', async () => {
    // The card opens off a message whose disc is already wearing the face, so a
    // card reading the author row's cache instead put two faces for one agent
    // on screen at once — the sharpest form of the bug this ticket closes.
    const user = userEvent.setup();
    renderIn(timeline([KAI_MEMBER]), fleetAnswering());

    // Hovered before the fleet has necessarily answered, then waited on: a
    // fleet answer that lands after the pill was drawn reaches it only through
    // the context, which is the path that used to be missing entirely.
    //
    // Queried inside the message BODY: the row's own header names Kai too, and
    // `findByText` would not know which one it had.
    const pill = await waitFor(() => {
      const body = document.querySelector('[data-slot="message-content"]');
      const found = body?.querySelector<HTMLElement>('[data-kind]');
      if (!found) throw new Error('no resolved mention pill yet');
      return found;
    });
    await user.hover(pill);
    await screen.findByText('View profile');

    const card = document.querySelector('[data-slot="identity-hover-card"]');
    expect(card).not.toBeNull();
    await waitFor(() =>
      expect(
        card?.querySelector('[data-slot="identity-avatar"]')?.firstElementChild?.textContent
      ).toBe(KAI_ICON)
    );
  });

  it('keeps the honest letter for the agent the fleet could not name, beside one it could', async () => {
    // The rung the ladder stops at, through the real callers — and proved
    // without a timing assumption. Kai and Ghost are in one roster and one
    // render: waiting for KAI's face to PAINT is what proves the fleet has
    // answered, so Ghost's letter read in the same tick is a statement rather
    // than a race. Gating on a query having been CALLED would not do it — that
    // is satisfied at initiation, and with nothing to resolve the second query
    // never runs at all.
    renderIn(
      <RoomHeader room={room('channel', [KAI_MEMBER, GHOST_MEMBER])} onOpenMembers={() => {}} />,
      fleetAnswering()
    );

    await waitFor(() => expect(glyphsOf('room-member-avatar')[0]).toBe(KAI_ICON));
    expect(glyphsOf('room-member-avatar')[1]).toBe('G');
  });

  it('keeps the honest letter in the gutter too, beside a face it could resolve', async () => {
    const ghostEntry: RoomEntry = { ...ENTRY, id: 'entry-2', authorId: 'author-ghost' };
    renderIn(
      <RoomTimeline
        roomId="room-1"
        roomName="general"
        viewerAuthorId="author-you"
        entries={[ENTRY, ghostEntry]}
        members={[KAI_MEMBER, GHOST_MEMBER]}
        lastReadSeq={null}
        reactionFrequents={[]}
        isLoading={false}
        error={null}
        onAddAgents={vi.fn()}
        onOpenThread={vi.fn()}
      />,
      fleetAnswering()
    );

    await waitFor(() => expect(glyphsOf('message-author-avatar')[0]).toBe(KAI_ICON));
    expect(glyphsOf('message-author-avatar')[1]).toBe('G');
  });
});
