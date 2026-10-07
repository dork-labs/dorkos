// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ChannelsPage } from '../ui/ChannelsPage';

const { redirect, remote, local, navigate, sentTo, spaces, address } = vi.hoisted(() => ({
  redirect: vi.fn(() => 'show'),
  remote: vi.fn(),
  local: vi.fn(),
  navigate: vi.fn(),
  sentTo: vi.fn(),
  /** The spaces experiment (DOR-2740) as the config read reports it. */
  spaces: { enabled: true, isLoading: false },
  address: { id: 'same-as-local-team', community: 'remote-a', thread: 'remote-thread' } as {
    id?: string;
    community?: string;
    thread?: string;
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => address,
  useNavigate: () => navigate,
  Navigate: (props: unknown) => {
    sentTo(props);
    return null;
  },
}));
vi.mock('../model/use-team-room-redirect', () => ({ useTeamRoomRedirect: redirect }));
vi.mock('../ui/RemoteCommunitySurface', () => ({
  RemoteCommunitySurface: (props: unknown) => {
    remote(props);
    return <p>Remote channel</p>;
  },
}));
vi.mock('../ui/RoomSurface', () => ({
  RoomSurface: (props: unknown) => {
    local(props);
    return <p>Local channel</p>;
  },
}));
vi.mock('../ui/RoomFlow', () => ({ RoomHistorySkeleton: () => <p>Loading local rooms</p> }));
vi.mock('../ui/CommunityPageHeading', () => ({
  CommunityPageHeading: ({ community, roomId }: { community: string; roomId?: string }) => (
    <h1>{`${community} heading for ${roomId}`}</h1>
  ),
}));
vi.mock('@/layers/shared/model', () => ({
  useIsMobile: () => false,
  useCommunityAuthority: () => ({ epoch: 1, ownerKey: 'owner' }),
}));
vi.mock('@/layers/entities/config', () => ({
  useSpacesState: () => spaces,
}));
const { connections } = vi.hoisted(() => ({
  connections: { data: [] as Array<Record<string, unknown>> },
}));
vi.mock('@/layers/entities/community', () => ({
  useCommunityConnections: () => connections,
  useEndCommunityConnection: () => ({
    mutate: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useUnsentCommunityDrafts: () => [],
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  connections.data = [];
  address.id = 'same-as-local-team';
  address.community = 'remote-a';
  address.thread = 'remote-thread';
  spaces.enabled = true;
  spaces.isLoading = false;
});

describe('qualified channel route', () => {
  // DOR-2334: a Community that seems to be gone (or was deleted) says so in place of its rooms,
  // which could never load. It fails if the page still draws the remote channel.
  it('shows a gone Community instead of its channel', () => {
    connections.data = [
      {
        ref: 'remote-a',
        label: 'Alpha',
        status: 'connected',
        access: null,
        seemsGoneSince: '2026-09-01T00:00:00.000Z',
      },
    ];
    render(<ChannelsPage />);
    expect(screen.getByText('This space seems to be gone')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove local copy' })).toBeInTheDocument();
    expect(remote).not.toHaveBeenCalled();
  });

  it('does not resolve a remote ID through the local team redirect or local room surface', () => {
    render(<ChannelsPage />);
    expect(screen.getByText('Remote channel')).toBeInTheDocument();
    // The page names the Community and its channel, never the local room the id shadows.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'remote-a heading for same-as-local-team'
    );
    expect(redirect).toHaveBeenCalledWith(undefined, 'remote-thread', undefined);
    expect(local).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledWith(
      expect.objectContaining({
        community: 'remote-a',
        roomId: 'same-as-local-team',
        threadId: 'remote-thread',
      })
    );
    const props = remote.mock.calls[0]![0] as { onThread: (id?: string) => void };
    props.onThread('new-thread');
    expect(navigate).toHaveBeenCalledWith({
      to: '/channels',
      search: { community: 'remote-a', id: 'same-as-local-team', thread: 'new-thread' },
    });
  });

  it('keeps one heading across the Community’s bare address and its channel', () => {
    address.id = undefined;
    address.thread = undefined;
    const { rerender } = render(<ChannelsPage />);
    const before = screen.getByRole('heading', { level: 1 });
    address.id = 'general';
    rerender(<ChannelsPage />);
    // The same element, so focus the switcher put on it survives the second hop.
    expect(screen.getByRole('heading', { level: 1 })).toBe(before);
    expect(before).toHaveTextContent('remote-a heading for general');
  });
});

// Purpose: spaces ship off (DOR-2740), so a space's address leads to the channel
// list instead, and nothing of the space is asked for or drawn on the way. Fails
// if the page stops reading the experiment, or decides before the config answers.
describe('a space address while spaces are off', () => {
  it('goes to the channel list and draws no space', () => {
    spaces.enabled = false;
    const { container } = render(<ChannelsPage />);
    expect(sentTo).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/channels', search: {}, replace: true })
    );
    expect(remote).not.toHaveBeenCalled();
    expect(local).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('draws nothing, and goes nowhere, until the config has answered', () => {
    spaces.enabled = false;
    spaces.isLoading = true;
    const { container } = render(<ChannelsPage />);
    expect(container).toBeEmptyDOMElement();
    expect(sentTo).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();
  });

  it('leaves a local room’s address alone', () => {
    spaces.enabled = false;
    address.community = undefined;
    address.id = 'general';
    render(<ChannelsPage />);
    expect(screen.getByText('Local channel')).toBeInTheDocument();
    expect(sentTo).not.toHaveBeenCalled();
  });
});

describe('local channel headings', () => {
  it('names the page "Channels" before a conversation is picked', () => {
    address.community = undefined;
    address.id = undefined;
    render(<ChannelsPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'Channels' })).toHaveAttribute(
      'data-page-heading'
    );
  });

  it('adds none for an open room, whose name in the channel bar is its heading', () => {
    address.community = undefined;
    address.id = 'general';
    render(<ChannelsPage />);
    expect(screen.getByText('Local channel')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
