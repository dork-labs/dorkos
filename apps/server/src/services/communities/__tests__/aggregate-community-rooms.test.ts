/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import {
  LOCAL_COMMUNITY,
  type CommunityAdapter,
  type CommunityRef,
  type CommunityRoom,
} from '@dorkos/shared/community-adapter';
import { FakeCommunityAdapter } from '@dorkos/test-utils/fake-community-adapter';
import {
  aggregateCommunityRooms,
  type CommunityListingSource,
} from '../aggregate-community-rooms.js';

/** A second community, addressed by a ULID the way a real one would be. */
const REMOTE = '01K1BXCQ4M7GKZ9V0S2R7XQ3AB' as CommunityRef;

/** One listing source, with the descriptor the warnings need. */
function source(
  adapter: CommunityAdapter,
  label: string,
  connection?: CommunityListingSource['connection']
): CommunityListingSource {
  return {
    adapter,
    descriptor: { community: adapter.community, label, type: adapter.type },
    ...(connection ? { connection } : {}),
  };
}

describe('aggregateCommunityRooms', () => {
  it('merges every community and sorts by last activity, newest first', async () => {
    const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    local.seedRoom({ entries: 1 });
    remote.seedRoom({ entries: 1 });
    local.seedRoom({ entries: 1 });

    const { rooms, warnings } = await aggregateCommunityRooms({
      communities: [source(local, 'This machine'), source(remote, 'Dork Labs')],
    });

    expect(warnings).toEqual([]);
    expect(rooms).toHaveLength(3);
    const timestamps = rooms.map((r) => Date.parse(r.lastActivityAt));
    expect(timestamps, 'newest first').toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('degrades one failing community to a warning, and still lists the others', async () => {
    const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    local.seedRoom({ entries: 1 });
    const broken = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(broken, 'listRooms').mockRejectedValue(new Error('relay closed the socket'));

    const { rooms, warnings } = await aggregateCommunityRooms({
      communities: [source(local, 'This machine'), source(broken, 'Dork Labs')],
    });

    expect(rooms, 'a working community is unaffected by a broken one').toHaveLength(1);
    // The adapter's own text does NOT become the sentence a person reads: a
    // relay refusal carries the remote's `event.message`, so passing it through
    // would let a server we do not run write copy for our cockpit. The raw text
    // goes to the log instead.
    expect(warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs could not be reached.' },
    ]);
    expect(warnings[0]!.message).not.toContain('relay closed the socket');
  });

  it('gives a slow community a budget rather than letting it stall the list', async () => {
    const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    local.seedRoom({ entries: 1 });
    const slow = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(slow, 'listRooms').mockImplementation(
      () => new Promise<CommunityRoom[]>(() => {}) // never settles
    );

    const { rooms, warnings } = await aggregateCommunityRooms({
      communities: [source(local, 'This machine'), source(slow, 'Dork Labs')],
      timeoutMs: 20,
    });

    expect(rooms).toHaveLength(1);
    // Told apart from an ordinary failure by CLASS, not by matching the error
    // text — which is why a slow community reads differently from a broken one.
    expect(warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs took too long to answer.' },
    ]);
  });

  it('lists zero rooms for a not-admitted community, including ones it listed a minute ago', async () => {
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });
    remote.seedRoom({ entries: 1 });

    // Before: the community is connected and its rooms list normally.
    const before = await aggregateCommunityRooms({
      communities: [source(remote, 'Dork Labs', { status: 'connected' })],
    });
    expect(before.rooms).toHaveLength(2);

    // After a removal, the next connect reports 'not-admitted'. The rooms it
    // listed a minute ago are dropped rather than left clickable — a list of
    // rooms that each fail on read reads as a broken product, not as a changed
    // membership.
    const after = await aggregateCommunityRooms({
      communities: [
        source(remote, 'Dork Labs', {
          status: 'not-admitted',
          disclosure: 'Ask whoever runs this community to let you in.',
        }),
      ],
    });

    expect(
      after.rooms,
      'a not-admitted community contributes none of the rooms it listed before'
    ).toEqual([]);
    expect(after.warnings).toEqual([
      {
        community: REMOTE,
        label: 'Dork Labs',
        message: 'Ask whoever runs this community to let you in.',
      },
    ]);
  });

  it('does not suppress a listing for unreachable or unauthorized — the asymmetry is the point', async () => {
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });

    for (const status of ['unreachable', 'unauthorized'] as const) {
      const { rooms, warnings } = await aggregateCommunityRooms({
        communities: [source(remote, 'Dork Labs', { status, error: 'nope' })],
      });
      expect(rooms, `${status} says nothing about membership`).toHaveLength(1);
      expect(warnings).toEqual([]);
    }
  });
});
