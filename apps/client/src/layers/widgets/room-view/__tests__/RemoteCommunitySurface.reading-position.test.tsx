// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { RemoteCommunityRoomSchema } from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RemoteCommunitySurface } from '../ui/RemoteCommunitySurface';

/**
 * The surface's half of "reopen where the reader left off": it is told which row
 * is at the top (or `undefined` once the reader is caught up at the bottom) and
 * saves it. The timeline itself needs real layout, so it is replaced by a stub
 * that hands the test the callback the surface gave it.
 */
const timeline = vi.hoisted(() => ({
  onTopRow: undefined as ((rowId: string | undefined) => void) | undefined,
}));
vi.mock('@/layers/features/conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/conversation')>();
  return {
    ...actual,
    Conversation: {
      ...actual.Conversation,
      Timeline: (props: { onTopRow?: (rowId: string | undefined) => void }) => {
        timeline.onTopRow = props.onTopRow;
        return null;
      },
    },
  };
});

afterEach(() => {
  cleanup();
  timeline.onTopRow = undefined;
});

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: true, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: true, stream: true },
    verifiedAt: '2026-09-16T10:00:00Z',
  },
} as const;
const room = RemoteCommunityRoomSchema.parse({
  community: 'a',
  roomId: 'same',
  remoteCommunityId: 'deployment',
  kind: 'channel',
  title: 'General',
  slug: 'general',
  topic: null,
  archived: false,
  createdAt: '2026-09-16T10:00:00Z',
  lastActivityAt: '2026-09-16T10:00:00Z',
  unreadCount: 0,
  visibility: 'public',
  readable: true,
  writable: true,
  joined: true,
  stale: false,
  cacheCursor: null,
  lastRemoteSeq: 0,
  access,
});

async function mount(storedAnchor: string | null) {
  const transport = createMockTransport();
  vi.mocked(transport.listCommunityConnections).mockResolvedValue([
    {
      ref: 'a' as never,
      remoteCommunityId: 'deployment',
      label: 'Community A',
      pinnedOrigin: 'https://a.example.com',
      connectedHumanMemberId: 'person',
      status: 'connected',
      expiresAt: null,
      access,
      attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    },
  ]);
  vi.mocked(transport.getCommunityNavigation).mockResolvedValue({
    ownerKey: 'local-owner',
    installationDestination: { path: '/', search: {} },
    order: [],
    destinations: [
      { ref: 'a' as never, roomId: 'same', threadId: null, scrollAnchorEntryId: storedAnchor },
    ],
  });
  vi.mocked(transport.getRemoteCommunityRoom).mockResolvedValue(room);
  vi.mocked(transport.listRemoteCommunityEntries).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    entries: [],
    nextCursor: null,
    lastRemoteSeq: 0,
    stale: false,
  });
  vi.mocked(transport.listRemoteCommunityMembers).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    members: [],
    stale: false,
  });
  vi.mocked(transport.subscribeRemoteCommunityRoom).mockImplementation(
    async (_ref, _room, _callback, options) =>
      new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      )
  );
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queries}>
      <TransportProvider transport={transport}>
        <TooltipProvider>
          <RemoteCommunitySurface community="a" roomId="same" onThread={vi.fn()} />
        </TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
  await waitFor(() => expect(timeline.onTopRow).toBeDefined());
  // The stored destination has to have arrived before the reader moves.
  await waitFor(() => expect(transport.getCommunityNavigation).toHaveBeenCalled());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return transport;
}

const anchorsSaved = (transport: ReturnType<typeof createMockTransport>) =>
  vi
    .mocked(transport.rememberCommunityNavigation)
    .mock.calls.map(([destination]) => destination.scrollAnchorEntryId);

/** Wait out the surface's 400ms save delay, plus a margin. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

describe('remote community reading position', () => {
  // Purpose: a reader who reopened a channel on a saved row and then read down to the
  // newest message has caught up, so the saved row is forgotten and the channel next
  // opens at its newest message. Fails if the surface ignores "caught up" (it used to,
  // and the channel kept reopening on a row the reader had long since read past).
  it('forgets a saved row once the reader is caught up at the bottom', async () => {
    const transport = await mount('old-row');
    act(() => timeline.onTopRow!(undefined));
    await settle();
    expect(anchorsSaved(transport)).toEqual([null]);
  });

  // Purpose: scrolling up and straight back down before the save lands saves nothing.
  // Fails if a pending save survives the reader coming back to the bottom.
  it('drops a pending save when the reader returns to the bottom first', async () => {
    const transport = await mount(null);
    act(() => timeline.onTopRow!('mid-row'));
    act(() => timeline.onTopRow!(undefined));
    await settle();
    expect(anchorsSaved(transport)).toEqual([]);
  });

  // Purpose: a row this view saved itself is forgotten too, even before the stored
  // destination has caught up with that save. Fails if "caught up" is judged only
  // from the stored destination.
  it('forgets a row it saved itself when the reader then catches up', async () => {
    const transport = await mount(null);
    act(() => timeline.onTopRow!('mid-row'));
    await settle();
    act(() => timeline.onTopRow!(undefined));
    await settle();
    expect(anchorsSaved(transport)).toEqual(['mid-row', null]);
  });

  // Purpose: a reader already at the bottom with nothing saved causes no writes at all.
  it('saves nothing when nothing was saved and the reader is at the bottom', async () => {
    const transport = await mount(null);
    act(() => timeline.onTopRow!(undefined));
    await settle();
    expect(anchorsSaved(transport)).toEqual([]);
  });
});
