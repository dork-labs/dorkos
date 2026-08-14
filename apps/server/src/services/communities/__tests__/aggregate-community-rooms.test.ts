/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CommunityWarningSchema,
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

  it('never lets a synchronously-throwing adapter take down the whole listing', async () => {
    // `allSettled` only settles promises. An adapter that throws before
    // returning one escapes it entirely and rejects the caller's request —
    // taking the OTHER communities' rooms with it.
    const local = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    local.seedRoom({ entries: 1 });
    const exploding = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(exploding, 'listRooms').mockImplementation(() => {
      throw new Error('adapter blew up before returning a promise');
    });

    const { rooms, warnings } = await aggregateCommunityRooms({
      communities: [source(local, 'This machine'), source(exploding, 'Dork Labs')],
    });

    expect(rooms).toHaveLength(1);
    expect(warnings).toEqual([
      { community: REMOTE, label: 'Dork Labs', message: 'Dork Labs could not be reached.' },
    ]);
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

  it('carries a label on every warning, so a degraded community is nameable', async () => {
    const broken = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    vi.spyOn(broken, 'listRooms').mockRejectedValue(new Error('boom'));

    const { warnings } = await aggregateCommunityRooms({
      communities: [
        source(broken, 'Dork Labs'),
        source(
          new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' }),
          'This machine',
          { status: 'not-admitted', disclosure: 'Not in this one yet.' }
        ),
      ],
    });

    expect(warnings).toHaveLength(2);
    for (const warning of warnings) expect(warning.label).toBeTruthy();
  });

  it('emits warnings that parse, including for a not-admitted community with no disclosure', async () => {
    const remote = new FakeCommunityAdapter({ community: REMOTE, type: 'buzz' });
    remote.seedRoom({ entries: 1 });
    const broken = new FakeCommunityAdapter({ community: LOCAL_COMMUNITY, type: 'local' });
    vi.spyOn(broken, 'listRooms').mockRejectedValue(new Error('boom'));

    const { warnings } = await aggregateCommunityRooms({
      communities: [
        // A backend that reached 'not-admitted' without supplying a disclosure.
        // The fallback is what a surface renders in that case, so it has to be
        // real text: an empty one would produce a warning that cannot be shown
        // and would slip past every other assertion in this file.
        source(remote, 'Dork Labs', { status: 'not-admitted' }),
        source(broken, 'This machine'),
      ],
    });

    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      const parsed = CommunityWarningSchema.safeParse(warning);
      expect(
        parsed.success,
        `malformed warning: ${parsed.success ? '' : parsed.error.message}`
      ).toBe(true);
    }
  });

  it('returns an empty list rather than failing when nothing is configured', async () => {
    await expect(aggregateCommunityRooms({ communities: [] })).resolves.toEqual({
      rooms: [],
      warnings: [],
    });
  });
});
