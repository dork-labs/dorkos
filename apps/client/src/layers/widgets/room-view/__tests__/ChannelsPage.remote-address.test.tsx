// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ChannelsPage } from '../ui/ChannelsPage';

const { redirect, remote, local, navigate, address } = vi.hoisted(() => ({
  redirect: vi.fn(() => 'show'),
  remote: vi.fn(),
  local: vi.fn(),
  navigate: vi.fn(),
  address: { id: 'same-as-local-team', community: 'remote-a', thread: 'remote-thread' } as {
    id?: string;
    community?: string;
    thread?: string;
  },
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => address,
  useNavigate: () => navigate,
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
vi.mock('@/layers/shared/model', () => ({ useIsMobile: () => false }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  address.id = 'same-as-local-team';
  address.community = 'remote-a';
  address.thread = 'remote-thread';
});

describe('qualified channel route', () => {
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
