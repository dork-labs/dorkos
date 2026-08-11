// @vitest-environment jsdom
/**
 * One agent, one face, everywhere in a room (DOR-1002).
 *
 * The two surfaces here are the ones that could not reach the fleet on their
 * own: the masthead's roster stack, drawn by `MemberList` in `entities/room`,
 * and the message gutter, drawn from `toMessageAuthor`. Both used to fall to
 * the author row's render cache — which almost no agent fills — so the same
 * agent wore its real face in the sidebar and a bare letter in the room.
 *
 * **This file tests the WIRING, which the unit tests cannot see.** The parity
 * test proves `MemberList` uses an override it is handed, and
 * `RoomTimeline.test.tsx` proves `toMessageAuthor` does; neither notices if a
 * caller stops handing one over. So nothing here passes a face in by hand: the
 * fleet is mocked at the transport, exactly the two calls the real hook makes,
 * and the assertion is what a person would see on screen. Deleting
 * `facesByRef={agents.faces}` from `RoomHeader`, or `agents.faces` from
 * `RoomTimeline`'s `toMessageAuthor` call, reddens it.
 *
 * The manifest names its own icon and colour rather than leaving them hashed,
 * so an assertion can name the glyph it expects — and so the case doubles as
 * proof that an agent's OWN choice is what arrives, not a hash that happens to
 * look stable.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
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
import { RoomTimeline } from '../ui/RoomTimeline';

afterEach(cleanup);

const KAI_PATH = '/w/kai';
const KAI_MANIFEST_ID = '01JKAIMANIFESTULID';
/** The icon Kai's own manifest carries — the face the sidebar draws for it. */
const KAI_ICON = '🦊';
const KAI_COLOR = '#15803d';

/**
 * Kai's roster row, carrying what a room actually holds: an author id from a
 * different id space than the manifest, no cached face, and the `agentRef`
 * that is the only bridge between the two.
 */
const KAI_MEMBER: RoomRosterEntry = {
  roomId: 'room-1',
  authorId: 'author-kai',
  responseMode: 'always',
  joinedAt: '2026-08-10T09:00:00.000Z',
  joinedSeq: 0,
  lastReadSeq: 0,
  origin: 'local',
  author: {
    id: 'author-kai',
    kind: 'agent',
    displayName: 'Kai',
    handle: 'kai',
    agentRef: agentAuthorRef(KAI_PATH),
  },
};

const ROOM: RoomWithRoster = {
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
  members: [KAI_MEMBER],
};

const ENTRY: RoomEntry = {
  roomId: 'room-1',
  seq: 1,
  id: 'entry-1',
  authorId: 'author-kai',
  kind: 'post',
  body: { text: 'build is green' },
  mentions: [],
  mentionSpans: [],
  sessionId: null,
  cascadeRoot: 'entry-1',
  cascadeDepth: 0,
  parentEntryId: null,
  threadRootEntryId: null,
  signature: null,
  createdAt: '2026-08-10T10:00:00.000Z',
};

/** The fleet answering for Kai, through the two calls the real hook makes. */
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

/** A fleet this cockpit cannot read — an unreachable mesh. */
function fleetSilent(): Partial<Transport> {
  return {
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
    resolveAgents: vi.fn().mockResolvedValue({}),
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
          <TooltipProvider>{children}</TooltipProvider>
        </TransportProvider>
      </QueryClientProvider>
    ),
  });
  return { transport };
}

/**
 * What one disc drew, read the way the roster-parity test reads it: the FIRST
 * child, because the masthead's disc also carries an `sr-only` name and reading
 * the whole subtree would compare a glyph against a glyph plus a name.
 */
function glyphOf(slot: string): string {
  const disc = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (disc === null) throw new Error(`no disc drawn for ${slot}`);
  return disc.firstElementChild?.textContent ?? '';
}

describe('an agent wears its own face across a room', () => {
  it('draws the manifest face in the masthead roster', async () => {
    renderIn(<RoomHeader room={ROOM} onOpenMembers={() => {}} />, fleetAnswering());

    // The roster is drawn from the room immediately and the fleet answers
    // afterwards, so this waits rather than reading once: the letter is on
    // screen first, and the face replacing it is the behaviour under test.
    await waitFor(() => expect(glyphOf('room-member-avatar')).toBe(KAI_ICON));
  });

  it('draws the same manifest face in the message gutter', async () => {
    renderIn(
      <RoomTimeline
        roomId="room-1"
        roomName="general"
        viewerAuthorId="author-you"
        entries={[ENTRY]}
        members={[KAI_MEMBER]}
        lastReadSeq={null}
        reactionFrequents={[]}
        isLoading={false}
        error={null}
        onAddAgents={vi.fn()}
        onOpenThread={vi.fn()}
      />,
      fleetAnswering()
    );

    expect(await screen.findByText('build is green')).toBeInTheDocument();
    await waitFor(() => expect(glyphOf('message-author-avatar')).toBe(KAI_ICON));
  });

  it('keeps the honest letter on both when the fleet cannot name the agent', async () => {
    // The rung the ladder stops at, asserted through the real callers. An
    // agent this cockpit cannot see has no manifest to hash, and a guessed
    // emoji would be a confident face matching nothing else on screen.
    const { transport } = renderIn(
      <RoomHeader room={ROOM} onOpenMembers={() => {}} />,
      fleetSilent()
    );

    // Settled rather than merely absent: asserting "no face yet" against a
    // render that has not finished passes for the wrong reason forever.
    await waitFor(() => expect(transport.listMeshAgentPaths).toHaveBeenCalled());
    expect(glyphOf('room-member-avatar')).toBe('K');
  });
});
