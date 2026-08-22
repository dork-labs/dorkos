// @vitest-environment jsdom
/**
 * The channel bar — the room's ONE masthead (spec `one-bar-header` §3.4, R1).
 *
 * What this file is really pinning is that everything the deleted `RoomHeader`
 * said still gets said: name, topic, archived, bridge visibility, what is
 * running, and who is in the room. A regression here does not crash anything; it
 * just quietly stops telling the reader something about the room they are in,
 * which is the failure mode nobody files a bug for.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import { ChannelsBar } from '../ui/ChannelsBar';
import { BarHarness } from './bar-harness';

// The fixed cluster OneBar renders. Both are real widgets with their own data
// needs; this suite is about what the BAR says, so they are stubbed at the seam.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

/** How many agents the room is currently working, as the live count answers. */
const { working, teamRoomId } = vi.hoisted(() => ({
  working: { count: 0 },
  // Which room is #team. Never `room-1` unless a test says so: the bar refuses
  // to name Home's room, so a stray match would blank every case below.
  teamRoomId: { current: 'team-room' as string | null },
}));
const halt = vi.hoisted(() => vi.fn());

vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    // The count rides a live presence store the bar does not own. Stubbed at the
    // hook rather than the store so this file states the count it is testing.
    useOpenRoomWorking: () => working.count,
    useHaltRoom: () => ({ mutate: halt, isPending: false }),
    useTeamRoom: () => ({
      status: teamRoomId.current === null ? 'missing' : 'ready',
      room: teamRoomId.current === null ? null : { id: teamRoomId.current },
      retry: vi.fn(),
    }),
  };
});

// The panel itself is mounted by the shell, not by the bar. What the bar owes
// is the press: the door, and the part of the panel it asks for.
const openRoomPanel = vi.fn();
// The fleet's faces come from the real join in the room-management slice, which
// reads two queries this bench does not mount — so the map it hands back is
// stated per test. It is keyed by `agentRef`, and empty means "this cockpit
// cannot place any of them", which is the honest default and leaves the mark on
// its glyph. That the map reaches the same agents the panel's roster draws is
// `room-agent-faces.test.tsx`.
const faces: { current: Map<string, { emoji: string; color: string; source: string }> } = {
  current: new Map(),
};
vi.mock('@/layers/features/room-management', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/room-management')>();
  return {
    ...actual,
    openRoomPanel: (focus: string, roomId: string) => openRoomPanel(focus, roomId),
    useRoomFaces: () => faces.current,
  };
});

afterEach(() => {
  cleanup();
  openRoomPanel.mockClear();
  faces.current = new Map();
  working.count = 0;
  teamRoomId.current = 'team-room';
  vi.clearAllMocks();
});

const LONG_NAME = 'Priya, Kai, Ikechi and 47 others about the quarterly migration plan';

function room(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
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
    members: [],
    ...overrides,
  } as RoomWithRoster;
}

/** Three members, which is enough for the chip to say a plural. */
function members(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    roomId: 'room-1',
    authorId: `author-${i}`,
    responseMode: 'always',
    joinedAt: '2026-08-10T09:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    origin: 'local',
    author: { id: `author-${i}`, kind: 'agent', displayName: `Agent ${i}`, handle: `a${i}` },
  })) as RoomWithRoster['members'];
}

function renderBar(open: RoomWithRoster | null) {
  return render(
    <BarHarness room={open}>
      <ChannelsBar />
    </BarHarness>
  );
}

describe('ChannelsBar', () => {
  it('names the open room', () => {
    renderBar(room());
    expect(screen.getByTitle('#general')).toBeInTheDocument();
  });

  it('says what the room is about, beside its name', () => {
    renderBar(room({ topic: 'Shipping the migration' }));
    expect(screen.getByText('Shipping the migration')).toBeInTheDocument();
  });

  it('falls back to the route name when no room is open', () => {
    // The page below is saying "That conversation isn't here" or "Pick a
    // conversation"; a bar naming a room next to either would be the worse half
    // of the pair (spec §5 case 6).
    renderBar(null);
    expect(screen.getByText('Channels')).toBeInTheDocument();
  });

  it('keeps a long room name inside the row, with the full text reachable', () => {
    // Room names are user-controlled and arrive from bridged Slack/Telegram
    // rooms, so a name that cannot truncate blows the 36px row open on a phone.
    // jsdom measures nothing — what is asserted is the mechanism (truncation
    // plus a `title`), not a width.
    renderBar(room({ kind: 'dm', slug: null, title: LONG_NAME }));
    const title = screen.getByTitle(LONG_NAME);
    expect(title).toHaveClass('truncate');
  });

  it('hides the topic before it lets the name shrink (I2)', () => {
    // The truncation ORDER is the invariant: the topic is the part a reader can
    // lose without losing the room, so it is the part that goes first — hidden
    // outright below `sm`, where a phone's bar has no width to spare.
    renderBar(room({ topic: 'Shipping the migration' }));
    expect(screen.getByText('Shipping the migration')).toHaveClass('hidden', 'sm:inline');
  });

  it('says an archived room is archived', () => {
    renderBar(room({ archived: true }));
    expect(screen.getByText('Archived')).toBeInTheDocument();
  });

  it('wears the agent’s own face for a one-to-one, and a # for a channel', () => {
    // The gap phase R2 closes. A one-to-one has had no sidebar row since
    // `sidebar-simplification` D2 and no masthead since phase R1, so between the
    // two its agent's face was drawn nowhere at all — and R1 could not draw one
    // here, because the join lived in a layer this widget may not reach. It is a
    // feature-layer hook now, read rather than re-made.
    faces.current = new Map([['ref-ana', { emoji: '🦊', color: '#e07b39', source: 'manifest' }]]);
    const withAna = room({
      kind: 'dm',
      slug: null,
      title: 'Ana',
      members: [
        {
          roomId: 'room-1',
          authorId: 'author-ana',
          responseMode: 'always',
          joinedAt: '2026-08-10T09:00:00.000Z',
          joinedSeq: 0,
          lastReadSeq: 0,
          origin: 'local',
          author: {
            id: 'author-ana',
            kind: 'agent',
            displayName: 'Ana',
            handle: 'ana',
            agentRef: 'ref-ana',
          },
        },
      ] as RoomWithRoster['members'],
    });
    const mark = () => document.querySelector('[data-slot="room-avatar"]');
    const { unmount } = renderBar(withAna);
    expect(mark()).toHaveTextContent('🦊');
    unmount();

    // A channel's mark is its `#`, whoever is in it — the face answers "who is
    // this with", which is a question only a direct message asks.
    renderBar(room({ members: members(3) }));
    expect(mark()).not.toHaveTextContent('🦊');
  });

  it('says how a bridged room sees messages', () => {
    renderBar(room({ bridge: { visibility: 'partial', platformTitle: 'Ops' } }));
    expect(screen.getByText('sees mentions only')).toBeInTheDocument();
  });

  it('counts the room’s members, and opens them when pressed', async () => {
    // Since phase R2 the press opens the right panel's Room tab on the roster.
    // The chip names what the reader wanted, not which surface answers it —
    // which is why re-pointing it from the modal to the panel was one line.
    const user = userEvent.setup();
    renderBar(room({ members: members(3) }));

    const chip = screen.getByRole('button', { name: '3 members' });
    expect(openRoomPanel).not.toHaveBeenCalled();

    await user.click(chip);
    expect(openRoomPanel).toHaveBeenCalledWith('members', 'room-1');
  });

  it('refuses to name #team here, because this route redirects it to Home', () => {
    // `?id=<team>` is a redirect (spec §3.5), and while it is in flight the page
    // below has already stopped drawing the room. A bar still announcing `#team`
    // over that empty pane is the same flash the redirect exists to prevent,
    // moved into the header.
    teamRoomId.current = 'room-1';
    renderBar(room());

    expect(screen.getByText('Channels')).toBeInTheDocument();
    expect(screen.queryByTitle('#general')).not.toBeInTheDocument();
  });

  it('lets the topic absorb the squeeze so the name keeps its width (I2)', () => {
    // **The inversion this pins.** Both are flex items, so left to themselves
    // they shrink in proportion to their content — a long topic beside a short
    // name ate the NAME first, and `#general` read as `#gen…` while the topic
    // still had room. jsdom lays nothing out, so what is asserted is the
    // mechanism: the topic carries the enormous shrink factor, the name carries
    // a floor it cannot be squeezed below.
    renderBar(room({ topic: 'Shipping the migration' }));

    const topic = screen.getByText('Shipping the migration');
    expect(topic).toHaveClass('shrink-[99999]', 'truncate', 'min-w-0');

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveClass('min-w-[6ch]');
  });

  it('names the room as the page’s heading, not just as text', () => {
    // The masthead carried the room's `h1`; with it gone the page had no heading
    // at all, which is a real loss for heading navigation and not merely a
    // selector detail. The accessible name is the spoken form.
    renderBar(room());

    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('#general');
  });

  it('shows what is running, and a Stop that halts this room', async () => {
    const user = userEvent.setup();
    working.count = 3;
    renderBar(room());

    expect(screen.getByLabelText('3 agents working')).toHaveTextContent('3');
    await user.click(screen.getByRole('button', { name: 'Stop all agents in #general' }));
    expect(halt).toHaveBeenCalledWith({ roomId: 'room-1' });
  });
});
