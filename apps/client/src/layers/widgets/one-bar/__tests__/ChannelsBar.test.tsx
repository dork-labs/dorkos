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
const { working } = vi.hoisted(() => ({ working: { count: 0 } }));
const halt = vi.hoisted(() => vi.fn());

vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    // The count rides a live presence store the bar does not own. Stubbed at the
    // hook rather than the store so this file states the count it is testing.
    useOpenRoomWorking: () => working.count,
    useHaltRoom: () => ({ mutate: halt, isPending: false }),
  };
});

const detailsDialog = vi.fn();
vi.mock('@/layers/features/room-management', () => ({
  RoomDetailsDialog: (props: { focus: string }) => {
    detailsDialog(props);
    return <div data-testid="room-details">{props.focus}</div>;
  },
}));

afterEach(() => {
  cleanup();
  working.count = 0;
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

  it('says how a bridged room sees messages', () => {
    renderBar(room({ bridge: { visibility: 'partial', platformTitle: 'Ops' } }));
    expect(screen.getByText('sees mentions only')).toBeInTheDocument();
  });

  it('counts the room’s members, and opens them when pressed', async () => {
    // The focus is the part of this that survives phase R2, when the same press
    // opens the room right panel instead of the sheet.
    const user = userEvent.setup();
    renderBar(room({ members: members(3) }));

    const chip = screen.getByRole('button', { name: '3 members' });
    expect(screen.queryByTestId('room-details')).not.toBeInTheDocument();

    await user.click(chip);
    expect(screen.getByTestId('room-details')).toBeInTheDocument();
    expect(detailsDialog).toHaveBeenCalledWith(expect.objectContaining({ focus: 'members' }));
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
