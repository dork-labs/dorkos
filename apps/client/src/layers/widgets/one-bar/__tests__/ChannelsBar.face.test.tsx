// @vitest-environment jsdom
/**
 * A one-to-one wears its agent's own face in the bar — through the REAL join.
 *
 * `ChannelsBar.test.tsx` stubs `useRoomFaces`, which is right for a suite about
 * what the bar draws: it states the map per case and never leaves the answer to
 * two network reads. But a stub cannot see the thing that actually broke this
 * for two phases — the join itself. `agentAuthorRef` hashes a directory, and the
 * roster carries that hash; a bar that looked the face up under any other key
 * would find nothing and fall back to a letter disc, and a stubbed map keyed the
 * way the test happens to key it would agree with the bug.
 *
 * So nothing here is mocked below the transport. The fleet is answered by the
 * same two calls the real hook makes, the room carries the same `agentRef` the
 * server sends, and what is asserted is the glyph a person would see.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import { agentAuthorRef, type RoomWithRoster } from '@dorkos/shared/room-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { ChannelsBar } from '../ui/ChannelsBar';
import { BarHarness } from './bar-harness';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/** #team is resolved separately by the bar; it is not this room. */
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return {
    ...actual,
    useTeamRoom: () => ({ status: 'missing', room: null, retry: vi.fn() }),
    useOpenRoomWorking: () => 0,
    useRoomWorking: () => 0,
  };
});

const ANA_PATH = '/w/ana';
const ANA_EMOJI = '🦊';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(cleanup);

/** A one-to-one with Ana, carrying the handle the server really sends. */
function dmWithAna(): RoomWithRoster {
  return {
    id: 'room-dm',
    kind: 'dm',
    slug: null,
    title: 'Ana',
    topic: null,
    workspaceId: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-08-22T09:00:00.000Z',
    lastActivityAt: '2026-08-22T09:00:00.000Z',
    unreadCount: 0,
    participants: null,
    viewerAuthorId: 'me',
    reactionFrequents: [],
    members: [
      {
        roomId: 'room-dm',
        authorId: 'me',
        responseMode: 'always',
        joinedAt: '2026-08-22T09:00:00.000Z',
        joinedSeq: 0,
        lastReadSeq: 0,
        origin: 'local',
        author: { id: 'me', kind: 'human', displayName: 'You', handle: null },
      },
      {
        roomId: 'room-dm',
        authorId: 'author-ana',
        responseMode: 'always',
        joinedAt: '2026-08-22T09:00:00.000Z',
        joinedSeq: 1,
        lastReadSeq: 0,
        origin: 'local',
        author: {
          id: 'author-ana',
          kind: 'agent',
          displayName: 'Ana',
          handle: 'ana',
          // The one-way hash of the directory (ADR 260726-170126) — the only
          // bridge between this roster and the fleet.
          agentRef: agentAuthorRef(ANA_PATH),
        },
      },
    ],
  } as unknown as RoomWithRoster;
}

/** The fleet answering for Ana through the two calls the real hook makes. */
function fleetAnswering(): Partial<Transport> {
  return {
    listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [{ projectPath: ANA_PATH }] }),
    resolveAgents: vi.fn().mockResolvedValue({
      [ANA_PATH]: {
        id: '01MANAMANIFESTULID',
        runtime: 'claude-code',
        icon: ANA_EMOJI,
        color: '#e07b39',
      },
    }),
  } as unknown as Partial<Transport>;
}

function renderBar(overrides: Partial<Transport>) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <BarHarness room={dmWithAna()}>
      <ChannelsBar />
    </BarHarness>,
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <TransportProvider transport={transport}>{children}</TransportProvider>
        </QueryClientProvider>
      ),
    }
  );
}

/** What the room's mark drew — the glyph, not the element. */
function markGlyph(): string {
  return document.querySelector('[data-slot="room-avatar"]')?.textContent ?? '';
}

describe("the bar's room mark, joined for real", () => {
  it("wears the agent's own emoji for a one-to-one", async () => {
    renderBar(fleetAnswering());

    await waitFor(() => expect(markGlyph()).toContain(ANA_EMOJI));
  });

  it('keeps the honest letter when the fleet cannot place the agent', async () => {
    // An agent this cockpit has never heard of — a directory that has moved, a
    // mesh read that came back without it. The mark says a letter rather than
    // inventing a face, which is the rule the whole `room-agent-faces` file
    // exists for.
    renderBar({
      listMeshAgentPaths: vi.fn().mockResolvedValue({ agents: [] }),
      resolveAgents: vi.fn().mockResolvedValue({}),
    } as unknown as Partial<Transport>);

    // Awaited on the same signal the passing case waits for, so this asserts an
    // absence AFTER the fleet answered rather than before it.
    await waitFor(() => expect(markGlyph()).not.toBe(''));
    expect(markGlyph()).not.toContain(ANA_EMOJI);
  });
});
