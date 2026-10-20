import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { MemberRoom } from '@dorkos/shared/team-schemas';
import {
  agentStatusLine,
  directMessageMode,
  sharedChannels,
  splitSharedChannels,
} from '../lib/direct-message-rules';

/** A room as the room list carries it, with only what the rule reads. */
function listed(id: string, over: Partial<RoomSummary> = {}): RoomSummary {
  return {
    id,
    kind: 'channel',
    slug: id,
    title: id,
    archived: false,
    unreadCount: 0,
    ...over,
  } as RoomSummary;
}

/** One of the agent's rooms, as its roster lists them. */
function agentRoom(id: string, over: Partial<MemberRoom> = {}): MemberRoom {
  return { id, name: `${id} room`, slug: id, kind: 'channel', memberCount: 3, ...over };
}

describe('directMessageMode', () => {
  it('draws every chat as a session while the experiment is off', () => {
    expect(directMessageMode({ enabled: false, isDirect: true })).toBe('off');
    expect(directMessageMode({ enabled: false, isDirect: true, view: 'session' })).toBe('off');
  });

  it('draws only an agent’s Direct chat as a DM', () => {
    expect(directMessageMode({ enabled: true, isDirect: false })).toBe('off');
    expect(directMessageMode({ enabled: true, isDirect: true })).toBe('dm');
  });

  it('draws the session behind the DM when the route asks for it', () => {
    expect(directMessageMode({ enabled: true, isDirect: true, view: 'session' })).toBe('session');
  });
});

describe('sharedChannels', () => {
  it('lists the channels both are in, in the agent’s order, as #slug', () => {
    const shared = sharedChannels(
      [agentRoom('launch'), agentRoom('design'), agentRoom('ops')],
      [listed('design'), listed('launch'), listed('ops')]
    );
    expect(shared).toEqual([
      { id: 'launch', label: '#launch' },
      { id: 'design', label: '#design' },
      { id: 'ops', label: '#ops' },
    ]);
  });

  it('leaves out a channel the person can see but never joined', () => {
    // The owner sees every room; only a member has a read cursor to count.
    const shared = sharedChannels(
      [agentRoom('launch'), agentRoom('design')],
      [listed('launch'), listed('design', { unreadCount: null })]
    );
    expect(shared.map((channel) => channel.id)).toEqual(['launch']);
  });

  it('leaves out direct messages, archived channels and the DM itself', () => {
    const shared = sharedChannels(
      [
        agentRoom('dm-1', { kind: 'dm', slug: null }),
        agentRoom('old'),
        agentRoom('this-dm', { kind: 'dm', slug: null }),
        agentRoom('launch'),
      ],
      [
        listed('dm-1', { kind: 'dm' }),
        listed('old', { archived: true }),
        listed('this-dm', { kind: 'dm' }),
        listed('launch'),
      ],
      'this-dm'
    );
    expect(shared).toEqual([{ id: 'launch', label: '#launch' }]);
  });

  it('names a channel with no slug by its title', () => {
    expect(sharedChannels([agentRoom('x', { slug: null })], [listed('x')])).toEqual([
      { id: 'x', label: 'x room' },
    ]);
  });

  it('says nothing until both lists have answered', () => {
    expect(sharedChannels(undefined, [listed('a')])).toEqual([]);
    expect(sharedChannels([agentRoom('a')], undefined)).toEqual([]);
  });
});

describe('splitSharedChannels', () => {
  it('names three and counts the rest', () => {
    const channels = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: `#${id}` }));
    const { visible, more } = splitSharedChannels(channels);
    expect(visible.map((channel) => channel.id)).toEqual(['a', 'b', 'c']);
    expect(more).toBe(2);
  });

  it('counts nothing when everything fits', () => {
    expect(splitSharedChannels([{ id: 'a', label: '#a' }]).more).toBe(0);
  });
});

describe('agentStatusLine', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names the room an agent is working in, the way this client names it', () => {
    const activity = {
      working: { roomId: 'r1', roomName: 'Launch', since: '2026-10-20T10:00:00.000Z' },
      lastActiveAt: null,
    };
    expect(agentStatusLine(activity, () => '#launch')).toBe('Working in #launch');
    expect(agentStatusLine(activity)).toBe('Working in Launch');
  });

  it('says when an idle agent last worked', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:04:00.000Z'));
    expect(agentStatusLine({ working: null, lastActiveAt: '2026-10-20T10:00:00.000Z' })).toBe(
      'Idle · last active 4m ago'
    );
    expect(agentStatusLine({ working: null, lastActiveAt: '2026-10-20T10:03:50.000Z' })).toBe(
      'Idle · last active just now'
    );
  });

  it('says nothing for an agent that never ran, or before the roster answers', () => {
    expect(agentStatusLine({ working: null, lastActiveAt: null })).toBeNull();
    expect(agentStatusLine(undefined)).toBeNull();
  });
});
