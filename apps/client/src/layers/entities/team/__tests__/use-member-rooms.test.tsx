// @vitest-environment jsdom
/**
 * What `useMemberRooms` asks for, and — more importantly — when it asks for
 * nothing. A profile is mounted app-wide and holds the last member it showed,
 * so "we know who, but nobody is looking" is a real state, and a hook that
 * fetched in it would put a request on every route change.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { MemberRoom } from '@dorkos/shared/team-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { memberRoomsKey, TEAM_ROSTER_KEY } from '../api/query-keys';
import { useMemberRooms } from '../model/use-member-rooms';

const TEAM_ROOM: MemberRoom = { id: 'room-1', name: '#team', kind: 'channel', memberCount: 3 };

function setup(listMemberRooms: Transport['listMemberRooms']) {
  const transport = createMockTransport({ listMemberRooms } as Partial<Transport>);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(cleanup);

describe('useMemberRooms', () => {
  it('reads the rooms of the member it was given', async () => {
    const listMemberRooms = vi.fn().mockResolvedValue({ rooms: [TEAM_ROOM] });
    const { wrapper } = setup(listMemberRooms);

    const { result } = renderHook(() => useMemberRooms('person-1'), { wrapper });

    await waitFor(() => expect(result.current.data).toEqual({ rooms: [TEAM_ROOM] }));
    expect(listMemberRooms).toHaveBeenCalledWith('person-1');
  });

  it('asks for nothing when no member is named', async () => {
    const listMemberRooms = vi.fn().mockResolvedValue({ rooms: [] });
    const { wrapper } = setup(listMemberRooms);

    const { result } = renderHook(() => useMemberRooms(null), { wrapper });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(listMemberRooms).not.toHaveBeenCalled();
  });

  it('asks for nothing while the caller says it is not looking', async () => {
    const listMemberRooms = vi.fn().mockResolvedValue({ rooms: [] });
    const { wrapper } = setup(listMemberRooms);

    const { result } = renderHook(() => useMemberRooms('person-1', { enabled: false }), {
      wrapper,
    });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(listMemberRooms).not.toHaveBeenCalled();
  });

  it('gives each member their own cache entry', async () => {
    const listMemberRooms = vi
      .fn()
      .mockImplementation((memberId: string) =>
        Promise.resolve({ rooms: memberId === 'person-1' ? [TEAM_ROOM] : [] })
      );
    const { client, wrapper } = setup(listMemberRooms);

    const first = renderHook(() => useMemberRooms('person-1'), { wrapper });
    await waitFor(() => expect(first.result.current.data?.rooms).toHaveLength(1));
    const second = renderHook(() => useMemberRooms('agent-ana'), { wrapper });
    await waitFor(() => expect(second.result.current.data?.rooms).toHaveLength(0));

    expect(client.getQueryData(memberRoomsKey('person-1'))).toEqual({ rooms: [TEAM_ROOM] });
    expect(client.getQueryData(memberRoomsKey('agent-ana'))).toEqual({ rooms: [] });
  });

  it('is refreshed by anything that invalidates the roster', async () => {
    // The whole reason the key is nested: a rename, a new face or a freshly
    // registered agent all invalidate `['team']`, and every one of them can
    // change who is in a room. Red the moment this key moves out from under it.
    const listMemberRooms = vi.fn().mockResolvedValue({ rooms: [TEAM_ROOM] });
    const { client, wrapper } = setup(listMemberRooms);

    const { result } = renderHook(() => useMemberRooms('person-1'), { wrapper });
    await waitFor(() => expect(result.current.data?.rooms).toHaveLength(1));

    await client.invalidateQueries({ queryKey: [...TEAM_ROSTER_KEY] });

    await waitFor(() => expect(listMemberRooms).toHaveBeenCalledTimes(2));
  });

  it('surfaces an unknown member as an error rather than an empty list', async () => {
    // "Nobody by that name" and "nowhere yet" are different sentences on a
    // profile, so the hook must not flatten a 404 into `{ rooms: [] }`.
    const listMemberRooms = vi.fn().mockRejectedValue(new Error('No member with that id'));
    const { wrapper } = setup(listMemberRooms);

    const { result } = renderHook(() => useMemberRooms('ghost'), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toBeUndefined();
  });
});
