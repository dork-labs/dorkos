// @vitest-environment jsdom
/**
 * Pressing a member's face and name in the room sheet opens THAT member's
 * profile (spec `profile-unification` §3, bug 7).
 *
 * The claim under test is **which id travels**, not that something opened. The
 * sheet holds author ids; the team roster the profile reads is keyed by author
 * id for people and by the id the MESH registered for agents. Passing the id
 * this surface already has would open an empty profile for every agent in every
 * room — so the whole test is mounted through `RoomDetailsDialog`, which owns
 * the join, rather than through the row, which is handed the answer and would
 * agree with anything.
 *
 * The answer is read off the URL — `?profile=<id>` is what `open()` writes, what
 * a reload reopens, and what a person shares.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import {
  agentAuthorRef,
  REACTION_FREQUENTS_DEFAULT,
  type RoomRosterEntry,
  type RoomSummary,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { TooltipProvider } from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import {
  buildProfileDeepLinkHarness,
  type ProfileDeepLinkHarness,
} from '@/test-helpers/profile-deep-link';
import { RoomDetailsDialog } from '../ui/RoomDetailsDialog';

/** The fleet the sheet reads for itself, stubbed at the hook it reads it with. */
const { mockRosterRef } = vi.hoisted(() => ({ mockRosterRef: { current: null as unknown } }));
vi.mock('../model/use-agent-picker-candidates', () => ({
  useAgentPickerCandidates: () => mockRosterRef.current,
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

afterEach(cleanup);

/**
 * The ids that must not be confused, spelled out so the assertions below read
 * as the two id spaces they actually are.
 */
const READER_AUTHOR_ID = 'author-you';
const ANA_AUTHOR_ID = 'author-ana';
const ANA_PATH = '/repo/ana';
const ANA_MESH_ID = '01JANAMESHREGISTRYULID';

const ROOM: RoomSummary = {
  id: 'room-1',
  kind: 'channel',
  slug: 'general',
  title: 'General',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T10:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  unreadCount: 0,
  participants: null,
};

const READER: RoomRosterEntry = {
  roomId: ROOM.id,
  authorId: READER_AUTHOR_ID,
  responseMode: 'always',
  joinedAt: '2026-07-26T10:00:00.000Z',
  joinedSeq: 0,
  lastReadSeq: 0,
  author: { id: READER_AUTHOR_ID, kind: 'human', displayName: 'Dorian', handle: 'dorian' },
  origin: 'local',
};

function agentMember(displayName: string, authorId: string, agentPath: string): RoomRosterEntry {
  return {
    roomId: ROOM.id,
    authorId,
    responseMode: 'mention-only',
    joinedAt: '2026-07-26T10:00:00.000Z',
    joinedSeq: 0,
    lastReadSeq: 0,
    author: {
      id: authorId,
      handle: null,
      kind: 'agent',
      displayName,
      agentRef: agentAuthorRef(agentPath),
    },
    origin: 'local',
  };
}

const ANA = agentMember('Ana', ANA_AUTHOR_ID, ANA_PATH);
/** An agent in the room that the fleet read never returned — nothing can place it. */
const STRANGER = agentMember('Zed', 'author-zed', '/repo/zed');

const FLEET: AgentPickerCandidate[] = [
  { agentPath: ANA_PATH, displayName: 'Ana', visual: null, description: null },
];

function roster(members: RoomRosterEntry[]): RoomWithRoster {
  return {
    ...ROOM,
    members,
    viewerAuthorId: READER_AUTHOR_ID,
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
  };
}

/**
 * Mount the sheet inside a real router, with the mesh answering the one join
 * that turns an agent's directory into its roster id.
 *
 * `meshAgents` is the seam the interesting failures live behind: an empty one
 * is a fleet this client could not place, and the rows must stay plain text
 * rather than offering a profile keyed on the author id they already hold.
 */
function renderSheet(
  members: RoomRosterEntry[],
  meshAgents: { id: string; name: string; projectPath: string }[] = [
    { id: ANA_MESH_ID, name: 'ana', projectPath: ANA_PATH },
  ]
): ProfileDeepLinkHarness {
  const harness = buildProfileDeepLinkHarness();
  const transport = createMockTransport({
    getRoom: vi.fn().mockResolvedValue(roster(members)),
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: meshAgents }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  mockRosterRef.current = { candidates: FLEET, isLoading: false, isError: false, retry: vi.fn() };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <harness.Wrapper>{children}</harness.Wrapper>
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );

  render(<RoomDetailsDialog room={ROOM} open onOpenChange={vi.fn()} focus="members" />, {
    wrapper,
  });
  return harness;
}

/**
 * How long to wait for a member's row to arrive.
 *
 * Generous on purpose. Two async reads stand between mounting the sheet and the
 * first row — the roster and the mesh — and this file runs alongside ~900 others
 * on a machine that is usually also running other agents. Testing Library's
 * 1000ms default is a statement about a quiet machine, and it made the first
 * case in this file red under a full-suite run while passing alone.
 */
const ROSTER_WAIT = { timeout: 5000 };

/** One member's profile control, once the roster has landed. */
function profileControl(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name: `Open ${name}’s profile` }, ROSTER_WAIT);
}

describe('a room member row opens that member’s profile', () => {
  it('carries a person’s AUTHOR id — their roster row is their author row', async () => {
    const user = userEvent.setup();
    const harness = renderSheet([READER, ANA]);

    await user.click(await profileControl('Dorian'));

    expect(harness.openProfileId()).toBe(READER_AUTHOR_ID);
  });

  it('carries an agent’s ROSTER id, never the author id the room holds', async () => {
    const user = userEvent.setup();
    const harness = renderSheet([READER, ANA]);

    await user.click(await profileControl('Ana'));

    expect(harness.openProfileId()).toBe(ANA_MESH_ID);
    // Spelled out because this is the whole point: the id the row already had
    // is the one that would have opened an empty profile.
    expect(harness.openProfileId()).not.toBe(ANA_AUTHOR_ID);
  });

  it('leaves an agent the fleet cannot place as plain text — no id, no control', async () => {
    const harness = renderSheet([READER, STRANGER]);

    // Waited on through somebody the sheet CAN place, so the absence below is
    // read after the roster landed rather than before it.
    await profileControl('Dorian');
    expect(screen.getByText('Zed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Zed’s profile' })).not.toBeInTheDocument();
    expect(harness.openProfileId()).toBeNull();
  });

  it('leaves every agent plain when the mesh named none of them', async () => {
    // The degradation that matters most: the fleet resolved a DIRECTORY for Ana
    // but the roster's own id space answered nothing, so there is no id to open
    // on. Half a join is not a profile.
    renderSheet([READER, ANA], []);

    await profileControl('Dorian');
    expect(screen.queryByRole('button', { name: 'Open Ana’s profile' })).not.toBeInTheDocument();
  });

  it('still says what a member has been doing, inside the control', async () => {
    // An `aria-label` wins over content, so the row's second line would vanish
    // for a screen reader without the description pointing back at it.
    renderSheet([READER, ANA]);

    const control = await profileControl('Ana');
    const describedBy = control.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy!)?.textContent).toMatch(/\S/);
  });
});
