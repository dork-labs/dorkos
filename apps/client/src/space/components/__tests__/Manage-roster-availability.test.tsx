// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manage } from '../Manage.js';
import { formatOfflineSince, RosterDetail } from '../members/RosterDetail.js';
import type { Channel, Member } from '../../types.js';
import { mockFetch } from '../../owner-replacement/__tests__/harness.js';

// A channel's roster shows whether each agent is there (DOR-2877): "Available", or "Offline
// since" its last report. An agent no app has reported for shows no status, never "Offline".
const NOW = new Date('2026-10-15T15:00:00.000Z');
const ME: Member = {
  memberId: 'm-1',
  kind: 'human',
  displayName: 'Sam',
  handle: 'sam',
  role: 'member',
  ownerMemberId: null,
  joinedAt: '2026-09-01T00:00:00.000Z',
};
const CHANNEL: Channel = {
  id: 'ch-1',
  name: 'general',
  description: null,
  visibility: 'public',
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  joined: true,
  unreadCount: 0,
};

function agent(handle: string, availability: Partial<Member>): Member {
  return {
    memberId: `a-${handle}`,
    kind: 'agent',
    displayName: handle,
    handle,
    role: null,
    ownerMemberId: 'm-1',
    ownerDisplayName: 'Sam',
    joinedAt: '2026-09-02T00:00:00.000Z',
    ...availability,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RosterDetail', () => {
  it('says Available, or Offline since the last report', () => {
    // Purpose: fails if either status goes missing or "since" stops naming the last report.
    const lastSeenAt = '2026-10-15T14:00:00.000Z';
    render(
      <RosterDetail
        member={agent('scout', { runsOn: 'computer', lastSeenAt, availability: 'offline' })}
        now={NOW}
      />
    );
    expect(
      screen.getByText(`@scout · agent · Offline since ${formatOfflineSince(lastSeenAt, NOW)}`)
    ).toBeTruthy();
    cleanup();
    render(
      <RosterDetail
        member={agent('atlas', { runsOn: 'computer', lastSeenAt, availability: 'available' })}
        now={NOW}
      />
    );
    expect(screen.getByText('@atlas · agent · Available')).toBeTruthy();
  });

  it('shows no status for an agent no app reported, or for a space that sends none', () => {
    // Purpose: fails if an older app's agent (never reported) or an older space (no fields) is
    // shown as offline.
    render(
      <RosterDetail
        member={agent('bolt', { runsOn: null, lastSeenAt: null, availability: 'unknown' })}
        now={NOW}
      />
    );
    expect(screen.getByText('@bolt · agent')).toBeTruthy();
    cleanup();
    render(<RosterDetail member={agent('echo', {})} now={NOW} />);
    expect(screen.getByText('@echo · agent')).toBeTruthy();
  });

  it('gives the date rather than a time for a report before today', () => {
    // Purpose: fails if an old absence reads as a time of day, as if it were today.
    expect(formatOfflineSince('2026-09-28T12:00:00.000Z', NOW)).not.toMatch(/:/u);
  });
});

describe('Manage: the channel roster', () => {
  it('asks for availability and shows it beside each agent', async () => {
    // Purpose: fails if the page stops asking for availability (the space then sends none) or
    // stops showing it in the members tab.
    const recent = new Date(Date.now() - 30_000).toISOString();
    const calls = mockFetch({
      'GET /api/v1/me/grants': { status: 200, body: { grants: [] } },
      'GET /api/v1/agents': { status: 200, body: { agents: [] } },
      'GET /api/v1/channels/ch-1/members': {
        status: 200,
        body: {
          members: [
            ME,
            agent('atlas', { runsOn: 'computer', lastSeenAt: recent, availability: 'available' }),
            agent('bolt', { runsOn: null, lastSeenAt: null, availability: 'unknown' }),
          ],
        },
      },
    });
    render(
      <Manage
        communityId="c-1"
        communityName="Acme Ops"
        communityAddress="https://community.test/c/c-1"
        me={ME}
        channels={[CHANNEL]}
        selectedChannel={CHANNEL}
        onChanged={() => {}}
        onCurrentMemberChanged={async () => ME}
        onLeft={() => {}}
        onSignedOut={() => {}}
        initialSection="members"
      />
    );
    await waitFor(() => expect(screen.getByText('@atlas · agent · Available')).toBeTruthy());
    expect(screen.getByText('@bolt · agent')).toBeTruthy();
    expect(screen.queryByText(/Offline/u)).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/members?include=availability'))).toBe(true);
  });
});
