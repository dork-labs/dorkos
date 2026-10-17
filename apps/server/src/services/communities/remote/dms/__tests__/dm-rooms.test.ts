/**
 * An enrolled agent's direct messages join its rooms (DOR-2955): listed as the agent, as rooms
 * of kind `dm`, none from a space without them, and a failed read changes nothing rather than
 * taking every copy for gone.
 */
import type { CommunityRef, CommunityRoom } from '@dorkos/shared/community-adapter';
import type { CommunityWireDirectMessage } from '@dorkos/shared/community-wire';
import { describe, expect, it, vi } from 'vitest';
import type { RemoteConnectionStore } from '../../connection-store.js';
import { RemoteDmCommunityAdapter } from '../../adapter/remote-dm-adapter.js';
import { PinnedHttpError } from '../../pinned-origin.js';
import { agentRooms } from '../dm-rooms.js';

const REF = 'remote_dm_space' as CommunityRef;

const dm: CommunityWireDirectMessage = {
  id: 'dm-bo-ana',
  member: { memberId: 'remote-bo', displayName: 'Bo' },
  agent: {
    memberId: 'remote-ana',
    displayName: 'Ana',
    handle: 'ana',
    ownerMemberId: 'remote-ada',
    ownerDisplayName: 'Ada',
  },
  createdAt: '2026-10-16T00:00:00.000Z',
  unreadCount: 2,
};

/** The real adapter with its request answered by `answer`. */
function adapter(answer: () => Promise<unknown>) {
  const value = new RemoteDmCommunityAdapter(REF, 'owner', {} as RemoteConnectionStore);
  const request = vi.fn(answer);
  Object.assign(value, { request });
  return { value, request };
}

describe('an enrolled agent’s direct messages', () => {
  it('are rooms of kind dm, read as the agent', async () => {
    const { value, request } = adapter(async () => ({ dms: [dm] }));

    const rooms = await value.listDirectMessageRooms({ actingMemberId: 'remote-ana' });

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      roomId: 'dm-bo-ana',
      kind: 'dm',
      title: 'Direct message with Bo',
      community: REF,
    });
    expect(request).toHaveBeenCalledWith(
      '/api/v1/dms',
      undefined,
      { actingMemberId: 'remote-ana' },
      'GET'
    );
  });

  it('are never asked of a space that says it holds none, nor started there', async () => {
    const { value, request } = adapter(async () => ({ dms: [dm] }));
    Object.assign(value, { features: { has: async (name: string) => name !== 'agentDms' } });

    await expect(value.supportsDirectMessages()).resolves.toBe(false);
    await expect(value.listDirectMessages()).resolves.toEqual([]);
    expect(request).not.toHaveBeenCalled();
  });

  it('are none from a space with no such route', async () => {
    const { value } = adapter(async () => {
      throw new PinnedHttpError(404);
    });

    await expect(value.listDirectMessageRooms({ actingMemberId: 'remote-ana' })).resolves.toEqual(
      []
    );
  });

  it('throw on any other failure, so no copy is taken for gone', async () => {
    const { value } = adapter(async () => {
      throw new PinnedHttpError(503);
    });

    await expect(value.listDirectMessageRooms({ actingMemberId: 'remote-ana' })).rejects.toThrow();
  });

  it('join the agent’s channels, and their failure fails the whole read', async () => {
    const channel = { roomId: 'general' } as CommunityRoom;
    const dmRoom = { roomId: 'dm-bo-ana', kind: 'dm' } as CommunityRoom;
    const both = {
      listRooms: vi.fn(async () => [channel]),
      listDirectMessageRooms: vi.fn(async () => [dmRoom]),
    };
    await expect(agentRooms(both, 'remote-ana')).resolves.toEqual([channel, dmRoom]);
    expect(both.listDirectMessageRooms).toHaveBeenCalledWith({ actingMemberId: 'remote-ana' });

    await expect(agentRooms({ listRooms: async () => [channel] }, 'remote-ana')).resolves.toEqual([
      channel,
    ]);

    both.listDirectMessageRooms.mockRejectedValueOnce(new Error('down'));
    await expect(agentRooms(both, 'remote-ana')).rejects.toThrow('down');
  });
});
