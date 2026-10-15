import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { ownerNoticeFrom } from '../../communities/remote/community-owner-notice-cache.js';
import {
  OWNER_NOTICE_SWEEP_MS,
  createOwnerNoticeSweep,
  sweepOwnerNotices,
  type OwnerNoticeSweepDeps,
} from '../emitters/community-owner-notice-sweep.js';

const notice = ownerNoticeFrom({
  open: null,
  completed: {
    replacementId: '11111111-1111-4111-8111-111111111111',
    newOwnerDisplayName: 'Riley',
    completedAt: '2026-10-05T09:00:00.000Z',
    wasYours: true,
  },
})!;

/** A connection as the pairing service describes it, readable unless told otherwise. */
function described(
  ref: string,
  over: Partial<CommunityConnectionDescriptor> = {}
): CommunityConnectionDescriptor {
  const effective = { read: true, post: true, enrollAgent: true, stream: true };
  return {
    ref,
    label: `Space ${ref}`,
    status: 'connected',
    access: { state: 'verified', effective },
    ...over,
  } as unknown as CommunityConnectionDescriptor;
}

function deps(
  statuses: Record<string, CommunityConnectionDescriptor | Error>,
  notices: Record<string, typeof notice | undefined>
): OwnerNoticeSweepDeps & { announce: ReturnType<typeof vi.fn>; notice: ReturnType<typeof vi.fn> } {
  return {
    connections: async () =>
      Object.keys(statuses).map((ref) => ({
        communityRef: ref as CommunityRef,
        ownerAuthorId: 'owner',
      })),
    status: async (ref) => {
      const answer = statuses[ref]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    notice: vi.fn(async (ref: CommunityRef) => notices[ref]),
    announce: vi.fn(async () => undefined),
  };
}

describe('the background owner-notice check (DOR-2760)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Purpose: fails if an owner is not told of a takeover request found in the background, or if
  // one space that fails, cannot read, or is not connected stops the others or gets asked.
  it('tells the owner about each readable space’s notice and skips the rest', async () => {
    const d = deps(
      {
        a: described('a'),
        broken: new Error('offline'),
        unverified: described('unverified', {
          access: {
            state: 'unverified',
            effective: { read: true, post: true, enrollAgent: true, stream: true },
          },
        } as Partial<CommunityConnectionDescriptor>),
        pending: described('pending', {
          status: 'pending',
        } as Partial<CommunityConnectionDescriptor>),
        quiet: described('quiet'),
      },
      { a: notice, unverified: notice, pending: notice }
    );
    expect(await sweepOwnerNotices(d)).toBe(1);
    expect(d.announce).toHaveBeenCalledTimes(1);
    expect(d.announce).toHaveBeenCalledWith('a', 'Space a', notice);
    expect(d.notice.mock.calls.map((call) => call[0])).toEqual(['a', 'quiet']);
  });

  // Purpose: fails if the check never runs on its own, waits a whole interval after a restart,
  // runs twice at once, or keeps running after stop.
  it('runs soon after start, then on its interval, one at a time, until stopped', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const d = deps({ a: described('a') }, { a: notice });
    d.notice.mockImplementation(() => new Promise((resolve) => (release = () => resolve(notice))));
    const sweep = createOwnerNoticeSweep(d, OWNER_NOTICE_SWEEP_MS);
    sweep.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.notice).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(OWNER_NOTICE_SWEEP_MS);
    expect(d.notice).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(OWNER_NOTICE_SWEEP_MS);
    expect(d.notice).toHaveBeenCalledTimes(2);
    release();
    sweep.stop();
    await vi.advanceTimersByTimeAsync(OWNER_NOTICE_SWEEP_MS * 3);
    expect(d.notice).toHaveBeenCalledTimes(2);
  });
});
