// @vitest-environment jsdom
/**
 * Direct messages with an agent in a space, in the app (DOR-2955): "Message" on an agent's row
 * only where the space holds them, a plain refusal when the owner has them off, the owner's
 * switch, the line saying whose agent it is and who reads along, an honest note when the agent's
 * computer is off, and the owner's read-only copy of someone's direct message with their agent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, withSpacesExperiment } from '@dorkos/test-utils';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { RemoteCommunityDm } from '@dorkos/shared/community-dm-views';
import type {
  RemoteCommunityEnrollment,
  RemoteCommunityMember,
} from '@dorkos/shared/community-views';
import { TransportProvider } from '@/layers/shared/model';
import { TooltipProvider } from '@/layers/shared/ui';
import { RemoteCommunityRoster } from '../ui/RemoteCommunityRoster';
import { RemoteDmRoom } from '../ui/dms/RemoteDmRoom';

const navigate = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));

afterEach(() => {
  cleanup();
  navigate.mockReset();
});

const ref = 'a' as CommunityRef;
const capabilities = { read: true, post: true, enrollAgent: true, stream: true };
const access = {
  state: 'verified',
  effective: capabilities,
  lastKnown: { lifecycle: 'active', capabilities, verifiedAt: '2026-10-16T10:00:00Z' },
} as const;

const agent: RemoteCommunityMember = {
  community: ref,
  memberId: 'remote-scout',
  kind: 'agent',
  displayName: 'Scout',
  handle: 'scout',
  role: null,
  ownerMemberId: 'remote-bo',
  joinedAt: '2026-10-01T00:00:00.000Z',
};

const dm = (over: Partial<RemoteCommunityDm> = {}): RemoteCommunityDm => ({
  community: ref,
  roomId: 'dm-1',
  member: { memberId: 'remote-ada', displayName: 'Ada' },
  agent: {
    memberId: 'remote-scout',
    displayName: 'Scout',
    ownerMemberId: 'remote-bo',
    ownerDisplayName: 'Bo',
  },
  readOnly: false,
  unreadCount: 0,
  createdAt: '2026-10-16T10:00:00Z',
  ...over,
});

const enrollment: RemoteCommunityEnrollment = {
  community: ref,
  localAgentId: 'local-scout',
  remoteMemberId: 'remote-scout',
  displayName: 'Scout',
  ownerMemberId: 'remote-bo',
  ownerDisplayName: 'Bo',
  active: true,
  roomIds: ['general'],
  acceptsDms: false,
};

/** A transport for one verified space that holds direct messages, or not. */
function transportFor(available: boolean, dms: RemoteCommunityDm[] = []) {
  const transport = withSpacesExperiment(createMockTransport());
  vi.mocked(transport.listCommunityConnections).mockResolvedValue([
    {
      ref,
      remoteCommunityId: 'deployment',
      label: 'Space A',
      pinnedOrigin: 'https://a.example.com',
      connectedHumanMemberId: 'remote-ada',
      status: 'connected',
      expiresAt: null,
      access,
      attention: { state: 'unavailable', unreadCount: null, mentionCount: null, verifiedAt: null },
    },
  ]);
  vi.mocked(transport.listRemoteCommunityDms).mockResolvedValue({
    community: ref,
    available,
    dms: available ? dms : [],
  });
  return transport;
}

let lastQueries: QueryClient | undefined;

/** One message in a direct message, as the local server sends it. */
function message(seq: number, text = `message ${seq}`) {
  return {
    community: ref,
    roomId: 'dm-1',
    id: `e${seq}`,
    authorId: 'remote-ada',
    authorKind: 'human',
    authorDisplayName: 'Ada',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    depth: 0,
    remoteSeq: seq,
    attachments: [],
    cursor: `c${seq}`,
    createdAt: '2026-10-16T10:00:00Z',
  } as never;
}

function page(from: number, to: number) {
  const entries = Array.from({ length: to - from + 1 }, (_, i) => message(from + i));
  return {
    community: ref,
    roomId: 'dm-1',
    entries,
    nextCursor: null,
    lastRemoteSeq: to,
    stale: false,
  };
}

function wrap(transport: ReturnType<typeof transportFor>, children: ReactNode) {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastQueries = queries;
  return render(
    <QueryClientProvider client={queries}>
      <TransportProvider transport={transport}>
        <TooltipProvider>{children}</TooltipProvider>
      </TransportProvider>
    </QueryClientProvider>
  );
}

function roster(transport: ReturnType<typeof transportFor>, canEnroll = false) {
  return wrap(
    transport,
    <RemoteCommunityRoster
      roster={{ community: ref, roomId: 'general', members: [agent], stale: false }}
      failed={false}
      canMention
      onMention={() => undefined}
      community={ref}
      roomId="general"
      online
      canEnroll={canEnroll}
      agentsKey="k"
      accessFingerprint="f"
    />
  );
}

describe('Message on an agent’s row', () => {
  it('is not offered on the person’s own agents', async () => {
    const transport = transportFor(true);
    wrap(
      transport,
      <RemoteCommunityRoster
        roster={{
          community: ref,
          roomId: 'general',
          members: [
            agent,
            {
              ...agent,
              memberId: 'remote-mine',
              displayName: 'Mine',
              handle: 'mine',
              ownerMemberId: 'remote-ada',
            },
          ],
          stale: false,
        }}
        failed={false}
        canMention
        onMention={() => undefined}
        community={ref}
        roomId="general"
        online
        canEnroll={false}
        agentsKey="k"
        accessFingerprint="f"
      />
    );
    expect(await screen.findByRole('button', { name: 'Message Scout' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Message Mine' })).not.toBeInTheDocument()
    );
    expect(screen.getByText('Mention @mine')).toBeInTheDocument();
  });

  it('is there only where the space holds direct messages', async () => {
    roster(transportFor(false));
    await screen.findByText('Mention @scout');
    // Give the list its chance to land; still nothing.
    await waitFor(() => expect(screen.queryByText('Message')).not.toBeInTheDocument());
    cleanup();

    roster(transportFor(true));
    expect(await screen.findByRole('button', { name: 'Message Scout' })).toBeInTheDocument();
  });

  it('opens the direct message, starting it the first time', async () => {
    const transport = transportFor(true);
    vi.mocked(transport.startRemoteCommunityDm).mockResolvedValue(dm());
    roster(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Message Scout' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ search: { community: ref, id: 'dm-1' } })
      )
    );
    expect(transport.startRemoteCommunityDm).toHaveBeenCalledWith(ref, 'remote-scout');
  });

  it('says plainly when the agent isn’t taking them', async () => {
    const transport = transportFor(true);
    vi.mocked(transport.startRemoteCommunityDm).mockRejectedValue(
      Object.assign(new Error('refused'), { code: 'AGENT_NOT_TAKING_DMS' })
    );
    roster(transport);

    fireEvent.click(await screen.findByRole('button', { name: 'Message Scout' }));

    expect(await screen.findByText('Scout isn’t taking direct messages.')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('the owner’s switch', () => {
  it('is shown on their agent where the space holds them, and reaches the space', async () => {
    const transport = transportFor(true);
    vi.mocked(transport.listRemoteCommunityAgents).mockResolvedValue([enrollment]);
    vi.mocked(transport.setRemoteCommunityAgentDms).mockResolvedValue({
      localAgentId: 'local-scout',
      acceptsDms: true,
    });
    roster(transport, true);

    const toggle = await screen.findByRole('switch', { name: 'Takes direct messages' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(transport.setRemoteCommunityAgentDms).toHaveBeenCalledWith(ref, 'local-scout', true)
    );
  });

  it('is not shown where the space holds none', async () => {
    const transport = transportFor(false);
    vi.mocked(transport.listRemoteCommunityAgents).mockResolvedValue([enrollment]);
    roster(transport, true);

    await screen.findByText('Leave channel');
    expect(screen.queryByRole('switch', { name: 'Takes direct messages' })).not.toBeInTheDocument();
  });
});

describe('a direct message', () => {
  it('opens nothing until the space says whether the room is one', async () => {
    const transport = transportFor(true, [dm()]);
    vi.mocked(transport.listRemoteCommunityDms).mockReturnValue(new Promise(() => undefined));
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );
    // Long enough for the connection list and the owner's authority to land.
    await waitFor(() => expect(transport.listRemoteCommunityDms).toHaveBeenCalled());
    expect(screen.queryByText('the room')).not.toBeInTheDocument();
  });

  it('says so, and opens no room, when the list can’t be read', async () => {
    const transport = transportFor(true, [dm()]);
    vi.mocked(transport.listRemoteCommunityDms).mockRejectedValue(new Error('down'));
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );
    expect(
      await screen.findByText(/Couldn’t load this space’s direct messages\./)
    ).toBeInTheDocument();
    expect(screen.queryByText('the room')).not.toBeInTheDocument();
  });

  it('reads only what came after the newest message it holds, and keeps both', async () => {
    const transport = transportFor(true, [dm({ readOnly: true, localAgentId: 'local-scout' })]);
    vi.mocked(transport.listRemoteCommunityAgentDmEntries)
      .mockResolvedValueOnce(page(151, 250) as never)
      .mockResolvedValueOnce(page(251, 253) as never);
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );
    expect(await screen.findByText('message 250')).toBeInTheDocument();
    await lastQueries!.refetchQueries();
    expect(await screen.findByText('message 253')).toBeInTheDocument();
    expect(screen.getByText('message 151')).toBeInTheDocument();
    expect(transport.listRemoteCommunityAgentDmEntries).toHaveBeenLastCalledWith(
      ref,
      'dm-1',
      'local-scout',
      'c250'
    );
  });

  it('says whose agent it is and that its owner can read it, above the room', async () => {
    const transport = transportFor(true, [dm()]);
    vi.mocked(transport.listRemoteCommunityMembers).mockResolvedValue({
      community: ref,
      roomId: 'dm-1',
      members: [{ ...agent, availability: 'available', lastSeenAt: '2026-10-16T10:00:00Z' }],
      stale: false,
    });
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );

    expect(await screen.findByText('· Bo’s agent · Bo can read this')).toBeInTheDocument();
    expect(screen.getByText('the room')).toBeInTheDocument();
    expect(screen.queryByText(/won’t answer/)).not.toBeInTheDocument();
  });

  it('says the agent won’t answer while its computer is off, and still lets the person post', async () => {
    const transport = transportFor(true, [dm()]);
    vi.mocked(transport.listRemoteCommunityMembers).mockResolvedValue({
      community: ref,
      roomId: 'dm-1',
      members: [{ ...agent, availability: 'offline', lastSeenAt: '2026-10-16T09:00:00Z' }],
      stale: false,
    });
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );

    expect(
      await screen.findByText('Offline. Scout won’t answer until its computer is back on.')
    ).toBeInTheDocument();
    expect(screen.getByText('the room')).toBeInTheDocument();
  });

  it('is an ordinary room when the address names a channel', async () => {
    wrap(
      transportFor(true, [dm()]),
      <RemoteDmRoom community={ref} roomId="general">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );
    expect(await screen.findByText('the room')).toBeInTheDocument();
    expect(screen.queryByText(/can read this/)).not.toBeInTheDocument();
  });

  it('opens read-only for the owner, read through their agent, with no room under it', async () => {
    const transport = transportFor(true, [dm({ readOnly: true, localAgentId: 'local-scout' })]);
    vi.mocked(transport.listRemoteCommunityAgentDmEntries).mockResolvedValue({
      community: ref,
      roomId: 'dm-1',
      entries: [
        {
          community: ref,
          roomId: 'dm-1',
          id: 'e1',
          authorId: 'remote-ada',
          authorKind: 'human',
          authorDisplayName: 'Ada',
          text: 'Can you check the build?',
          mentions: [],
          parentEntryId: null,
          threadRootEntryId: null,
          depth: 0,
          remoteSeq: 1,
          attachments: [],
          cursor: 'c1',
          createdAt: '2026-10-16T10:00:00Z',
        } as never,
      ],
      nextCursor: null,
      lastRemoteSeq: 1,
      stale: false,
    });
    wrap(
      transport,
      <RemoteDmRoom community={ref} roomId="dm-1">
        {() => <p>the room</p>}
      </RemoteDmRoom>
    );

    expect(await screen.findByText('Can you check the build?')).toBeInTheDocument();
    expect(screen.getByText('Ada with Scout')).toBeInTheDocument();
    expect(screen.getByText('Only Ada and Scout can post here.')).toBeInTheDocument();
    expect(screen.queryByText('the room')).not.toBeInTheDocument();
    expect(screen.queryByText('Reply in thread')).not.toBeInTheDocument();
    expect(transport.listRemoteCommunityAgentDmEntries).toHaveBeenCalledWith(
      ref,
      'dm-1',
      'local-scout',
      undefined
    );
  });
});
