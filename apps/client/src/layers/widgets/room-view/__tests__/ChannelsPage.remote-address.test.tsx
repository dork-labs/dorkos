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
  address: { id: 'same-as-local-team', community: 'remote-a', thread: 'remote-thread' },
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
vi.mock('@/layers/shared/model', () => ({ useIsMobile: () => false }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('qualified channel route', () => {
  it('does not resolve a remote ID through the local team redirect or local room surface', () => {
    render(<ChannelsPage />);
    expect(screen.getByText('Remote channel')).toBeInTheDocument();
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
});
