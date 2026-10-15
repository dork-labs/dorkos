// @vitest-environment jsdom
/**
 * A space roster that shows agents' availability is read again every minute, so "Available"
 * does not outlast a computer that went to sleep; any other roster is never polled (DOR-2878).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockTransport, spacesExperiment } from '@dorkos/test-utils';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type {
  RemoteCommunityMember,
  RemoteCommunityMembersResponse,
} from '@dorkos/shared/community-views';
import { confirmCommunityAuthority, invalidateCommunityAuthority } from '@/layers/shared/lib';
import { configKeys, TransportProvider } from '@/layers/shared/model';
import { communityNavigationKeys } from '../model/use-community-navigation';
import {
  REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS,
  remoteMembersRefetchInterval,
  useRemoteCommunityMembers,
} from '../model/use-remote-community';

const ref = 'a' as CommunityRef;
const person: RemoteCommunityMember = {
  community: ref,
  memberId: 'person',
  kind: 'human',
  displayName: 'Dana',
  handle: 'dana',
  role: 'owner',
  ownerMemberId: null,
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const agent: RemoteCommunityMember = {
  ...person,
  memberId: 'agent',
  kind: 'agent',
  displayName: 'Scout',
  handle: 'scout',
  role: null,
  ownerMemberId: 'person',
};
const roster = (members: RemoteCommunityMember[]): RemoteCommunityMembersResponse => ({
  community: ref,
  roomId: 'room',
  members,
  stale: false,
});

let client: QueryClient;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const pending = invalidateCommunityAuthority();
  confirmCommunityAuthority(pending.epoch, 'owner-a');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(configKeys.current(), { experiments: spacesExperiment(true) });
  client.setQueryData(communityNavigationKeys.authority(pending.epoch), {
    ownerKey: 'owner-a',
    order: [],
    destinations: [],
  });
});

afterEach(() => {
  cleanup();
  client.clear();
  invalidateCommunityAuthority();
  vi.useRealTimers();
});

/** Let the first read and the authority settling after mount finish; the count it leaves. */
async function settled(read: ReturnType<typeof vi.fn>): Promise<number> {
  await waitFor(() => expect(read).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(1_000);
  return read.mock.calls.length;
}

function mount(answer: RemoteCommunityMembersResponse) {
  const listRemoteCommunityMembers = vi.fn(async () => answer);
  const transport = createMockTransport({ listRemoteCommunityMembers });
  function Probe() {
    useRemoteCommunityMembers(ref, 'room');
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <Probe />
      </TransportProvider>
    </QueryClientProvider>
  );
  return listRemoteCommunityMembers;
}

describe('useRemoteCommunityMembers refresh', () => {
  it('reads a roster with availability again every minute', async () => {
    const read = mount(roster([person, { ...agent, availability: 'available' }]));
    const before = await settled(read);
    await vi.advanceTimersByTimeAsync(REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(before + 1));
    await vi.advanceTimersByTimeAsync(REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(before + 2));
  });

  it('never polls a roster from a space without availability, or people only', async () => {
    const read = mount(roster([person, agent]));
    const before = await settled(read);
    await vi.advanceTimersByTimeAsync(3 * REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS);
    expect(read).toHaveBeenCalledTimes(before);
  });

  it('decides the interval from the rows alone', () => {
    expect(remoteMembersRefetchInterval(undefined)).toBe(false);
    expect(remoteMembersRefetchInterval(roster([person]))).toBe(false);
    expect(remoteMembersRefetchInterval(roster([person, agent]))).toBe(false);
    expect(remoteMembersRefetchInterval(roster([{ ...agent, availability: 'unknown' }]))).toBe(
      REMOTE_MEMBERS_AVAILABILITY_REFRESH_MS
    );
  });
});
