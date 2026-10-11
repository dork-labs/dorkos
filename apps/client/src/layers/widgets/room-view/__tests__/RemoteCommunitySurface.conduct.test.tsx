// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, withSpacesExperiment } from '@dorkos/test-utils';
import {
  RemoteCommunityEntrySchema,
  RemoteCommunityRoomSchema,
  type RemoteCommunityStanding,
} from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RemoteCommunitySurface } from '../ui/RemoteCommunitySurface';

afterEach(cleanup);
// A confirmed post scrolls the timeline to it; jsdom has no layout to scroll.
beforeAll(() => {
  HTMLElement.prototype.scrollTo ??= vi.fn();
});

const access = {
  state: 'verified',
  effective: { read: true, post: true, enrollAgent: false, stream: true },
  lastKnown: {
    lifecycle: 'active',
    capabilities: { read: true, post: true, enrollAgent: false, stream: true },
    verifiedAt: '2026-10-01T10:00:00Z',
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
  createdAt: '2026-10-01T10:00:00Z',
  lastActivityAt: '2026-10-01T10:00:00Z',
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
function entry(id: string, authorId: string, text: string, seq: number) {
  return RemoteCommunityEntrySchema.parse({
    community: 'a',
    roomId: 'same',
    id,
    authorId,
    authorKind: 'human',
    authorDisplayName: authorId === 'person' ? 'Pat' : 'Sam',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    remoteSeq: seq,
    attachments: [],
    cursor: `cursor-${seq}`,
    createdAt: '2026-10-01T10:00:00Z',
  });
}
const theirs = entry('theirs', 'sam', 'Buy cheap watches', 1);
const mine = entry('mine', 'person', 'Hello all', 2);

function standing(over: Partial<RemoteCommunityStanding> = {}): RemoteCommunityStanding {
  return {
    community: 'a' as never,
    roomId: 'same',
    mutedUntil: null,
    slowModeSeconds: 0,
    rules: { text: null, version: 0, acceptedVersion: 0 },
    ...over,
  };
}

function mount(state: RemoteCommunityStanding = standing()) {
  const transport = withSpacesExperiment(createMockTransport());
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
  vi.mocked(transport.getRemoteCommunityStanding).mockResolvedValue(state);
  vi.mocked(transport.getRemoteCommunityRoom).mockResolvedValue(room);
  vi.mocked(transport.listRemoteCommunityEntries).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    entries: [theirs, mine],
    nextCursor: null,
    lastRemoteSeq: 2,
    stale: false,
  });
  vi.mocked(transport.listRemoteCommunityMembers).mockResolvedValue({
    community: room.community,
    roomId: room.roomId,
    members: [
      {
        community: 'a' as never,
        memberId: 'person',
        kind: 'human',
        displayName: 'Pat',
        handle: 'pat',
        role: 'member',
        ownerMemberId: null,
        joinedAt: '2026-10-01T10:00:00Z',
      },
    ],
    stale: false,
  });
  vi.mocked(transport.setRemoteCommunityReadCursor).mockResolvedValue({
    cursor: null,
    unreadCount: 0,
  });
  vi.mocked(transport.subscribeRemoteCommunityRoom).mockImplementation(
    async (_ref, _room, callback, options) => {
      callback({
        type: 'snapshot',
        room,
        entries: [],
        cursor: null,
        lastRemoteSeq: 0,
        stale: false,
      });
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      );
    }
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
  return transport;
}

async function send(text: string) {
  const input = await screen.findByRole('combobox');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });
  return input;
}

describe('a person’s standing in a space channel', () => {
  it('says when a mute ends and holds the post', async () => {
    const until = new Date(Date.now() + 60 * 60_000).toISOString();
    const transport = mount(standing({ mutedUntil: until }));
    expect((await screen.findAllByText(/You’re muted here until/)).length).toBeGreaterThan(0);
    await send('Can I talk?');
    expect(transport.postRemoteCommunityEntry).not.toHaveBeenCalled();
  });

  it('asks for the rules before the first post, and opens the channel once they are accepted', async () => {
    const transport = mount(
      standing({ rules: { text: 'Be kind.\nNo ads.', version: 2, acceptedVersion: 1 } })
    );
    expect(await screen.findByText('Accept this space’s rules to post.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read the rules' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/No ads\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept rules' }));
    await waitFor(() => expect(transport.acceptRemoteCommunityRules).toHaveBeenCalledWith('a', 2));
    await waitFor(() =>
      expect(screen.queryByText('Accept this space’s rules to post.')).not.toBeInTheDocument()
    );
    vi.mocked(transport.postRemoteCommunityEntry).mockResolvedValue(mine);
    await send('Hello all');
    await waitFor(() => expect(transport.postRemoteCommunityEntry).toHaveBeenCalled());
  });

  it('counts down slow mode after a held post, with the message back in the box', async () => {
    const transport = mount(standing({ slowModeSeconds: 30 }));
    expect(await screen.findByText('Slow mode: one message every 30s.')).toBeInTheDocument();
    vi.mocked(transport.postRemoteCommunityEntry).mockRejectedValueOnce(
      Object.assign(new Error('Slow'), {
        code: 'COMMUNITY_SLOW_MODE',
        status: 429,
        retryAfterMs: 12_000,
      })
    );
    const input = await send('Too soon');
    expect(await screen.findByText('Slow mode. Post again in 12s.')).toBeInTheDocument();
    expect(input).toHaveValue('Too soon');
    expect(screen.queryByText('Delivery not confirmed.')).not.toBeInTheDocument();
  });

  it('refetches the standing when a post is held for the rules, and asks for them', async () => {
    const transport = mount();
    await screen.findByRole('combobox');
    vi.mocked(transport.getRemoteCommunityStanding).mockResolvedValue(
      standing({ rules: { text: 'New rules.', version: 1, acceptedVersion: 0 } })
    );
    vi.mocked(transport.postRemoteCommunityEntry).mockRejectedValueOnce(
      Object.assign(new Error('Rules'), { code: 'COMMUNITY_RULES_NOT_ACCEPTED', status: 403 })
    );
    await send('Hi');
    expect(await screen.findByRole('button', { name: 'Read the rules' })).toBeInTheDocument();
  });
});

describe('reporting and naming in a space', () => {
  it('reports someone else’s message with a reason and a note, never your own', async () => {
    const transport = mount();
    await screen.findByText('Buy cheap watches');
    // Pat's own message has no Report button; Sam's has one.
    expect(screen.getAllByRole('button', { name: 'Report' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    const send = within(dialog).getByRole('button', { name: 'Send report' });
    expect(send).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('Spam'));
    fireEvent.change(within(dialog).getByLabelText('Note (optional)'), {
      target: { value: ' Third ad today ' },
    });
    fireEvent.click(send);
    await waitFor(() =>
      expect(transport.reportRemoteCommunityEntry).toHaveBeenCalledWith('a', 'same', 'theirs', {
        reason: 'spam',
        note: 'Third ad today',
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('changes your name in the space, starting from the one it shows now', async () => {
    const transport = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Your name' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Name');
    await waitFor(() => expect(field).toHaveValue('Pat'));
    fireEvent.change(field, { target: { value: 'Pat Q' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    await waitFor(() =>
      expect(transport.setRemoteCommunityDisplayName).toHaveBeenCalledWith('a', 'Pat Q')
    );
  });

  it('says why a name is refused and keeps what was typed', async () => {
    const transport = mount();
    vi.mocked(transport.setRemoteCommunityDisplayName).mockRejectedValue(
      new Error('That name is taken in this space. Try another.')
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Your name' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('Name');
    fireEvent.change(field, { target: { value: 'Olive Owner' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save name' }));
    expect(
      await within(dialog).findByText('That name is taken in this space. Try another.')
    ).toBeInTheDocument();
    expect(field).toHaveValue('Olive Owner');
  });
});
