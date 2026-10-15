// @vitest-environment jsdom
/**
 * Whether a space channel's agent is there, on the roster (DOR-2878): "Available" or "Offline
 * since …" when the space reports it, and nothing at all otherwise, never "Offline".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type {
  RemoteCommunityMember,
  RemoteCommunityMembersResponse,
} from '@dorkos/shared/community-views';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { remoteAgentAvailabilityLabel } from '../lib/remote-agent-availability';
import { RemoteCommunityRoster } from '../ui/RemoteCommunityRoster';

afterEach(cleanup);

const ref = 'ref' as CommunityRef;

const person: RemoteCommunityMember = {
  community: ref,
  memberId: 'person-1',
  kind: 'human',
  displayName: 'Dana',
  handle: 'dana',
  role: 'owner',
  ownerMemberId: null,
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const agent: RemoteCommunityMember = {
  community: ref,
  memberId: 'agent-1',
  kind: 'agent',
  displayName: 'Scout',
  handle: 'scout',
  role: null,
  ownerMemberId: 'person-1',
  joinedAt: '2026-10-01T00:00:00.000Z',
};
const now = new Date(2026, 9, 15, 18, 0);
const earlierToday = new Date(2026, 9, 15, 15, 4).toISOString();
const lastWeek = new Date(2026, 9, 8, 9, 0).toISOString();

function renderRoster(members: RemoteCommunityMember[]) {
  const roster: RemoteCommunityMembersResponse = {
    community: ref,
    roomId: 'room',
    members,
    stale: false,
  };
  render(
    <RemoteCommunityRoster
      roster={roster}
      failed={false}
      canMention
      onMention={() => undefined}
      community="ref"
      roomId="room"
      online
      canEnroll={false}
      agentsKey="k"
      accessFingerprint="f"
    />
  );
}

describe('remoteAgentAvailabilityLabel', () => {
  it('says Available, with the last report on hover', () => {
    const label = remoteAgentAvailabilityLabel(
      { ...agent, availability: 'available', lastSeenAt: earlierToday },
      now
    );
    expect(label?.text).toBe('Available');
    expect(label?.title).toBe(new Date(earlierToday).toLocaleString());
  });

  it('says Offline since the time today, or the date before today', () => {
    const today = remoteAgentAvailabilityLabel(
      { ...agent, availability: 'offline', lastSeenAt: earlierToday },
      now
    );
    expect(today?.text).toBe(
      `Offline since ${new Date(earlierToday).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    );
    const before = remoteAgentAvailabilityLabel(
      { ...agent, availability: 'offline', lastSeenAt: lastWeek },
      now
    );
    expect(before?.text).toBe(
      `Offline since ${new Date(lastWeek).toLocaleDateString([], { month: 'short', day: 'numeric' })}`
    );
  });

  it('says nothing for an unknown agent, an old space, or a person', () => {
    expect(remoteAgentAvailabilityLabel({ ...agent, availability: 'unknown' }, now)).toBeNull();
    expect(remoteAgentAvailabilityLabel(agent, now)).toBeNull();
    expect(
      remoteAgentAvailabilityLabel({ ...agent, availability: 'offline', lastSeenAt: null }, now)
    ).toBeNull();
    expect(remoteAgentAvailabilityLabel({ ...person, availability: 'available' }, now)).toBeNull();
  });
});

describe('RemoteCommunityRoster availability', () => {
  it('shows Available on a reported agent and nothing on the person', () => {
    renderRoster([person, { ...agent, availability: 'available', lastSeenAt: earlierToday }]);
    expect(screen.getByText(/· Available/)).toBeInTheDocument();
    expect(screen.getAllByText(/Available|Offline/)).toHaveLength(1);
  });

  it('shows an offline agent with when it was last there', () => {
    renderRoster([{ ...agent, availability: 'offline', lastSeenAt: lastWeek }]);
    expect(screen.getByText(/· Offline since/)).toBeInTheDocument();
  });

  it('shows no status at all for a roster from a space without availability', () => {
    renderRoster([person, agent, { ...agent, memberId: 'agent-2', availability: 'unknown' }]);
    expect(screen.queryByText(/Available|Offline/)).not.toBeInTheDocument();
  });
});
