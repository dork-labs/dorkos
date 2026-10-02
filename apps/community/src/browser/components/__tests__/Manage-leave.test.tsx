// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manage } from '../Manage.js';
import type { Member } from '../../types.js';
import { mockFetch } from '../../owner-replacement/__tests__/harness.js';

// Leaving is the member's own right, so the account tab offers it in a held community as well
// as an active one (DOR-2588). An archived community and an owner still never see it here.
const NAME = 'Acme Ops';

function person(role: Member['role']): Member {
  return {
    memberId: 'm-1',
    kind: 'human',
    displayName: 'Sam',
    handle: 'sam',
    role,
    ownerMemberId: null,
    joinedAt: '2026-09-01T00:00:00.000Z',
  };
}

function show(role: Member['role'], state: { readOnly: boolean; held: boolean }) {
  const calls = mockFetch({
    'GET /api/v1/me/grants': { status: 200, body: { grants: [] } },
    'POST /api/v1/me/leave': { status: 204 },
  });
  const onLeft = vi.fn();
  render(
    <Manage
      communityId="c-1"
      communityName={NAME}
      communityAddress="https://community.test/c/c-1"
      me={person(role)}
      channels={[]}
      selectedChannel={null}
      onChanged={() => {}}
      onCurrentMemberChanged={async () => person(role)}
      onLeft={onLeft}
      onSignedOut={() => {}}
      initialSection="account"
      {...state}
    />
  );
  return { calls, onLeft };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Manage: leaving a community', () => {
  it('lets a member leave a community on hold', async () => {
    // Purpose: fails if the leave section is hidden again for every read-only community, which
    // left a member of a held community with no way to leave it.
    const { calls, onLeft } = show('member', { readOnly: true, held: true });
    expect(screen.getByRole('heading', { name: 'Leave community' })).toBeTruthy();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.change(screen.getByLabelText(`Enter ${NAME}`), { target: { value: NAME } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Leave community' }));
    await waitFor(() => expect(onLeft).toHaveBeenCalled());
    expect(calls.find((call) => call.url.endsWith('/api/v1/me/leave'))?.body).toEqual({
      password: 'pw',
      communityName: NAME,
    });
  });

  it('offers no leave in an archived community, where the server refuses it', () => {
    // Purpose: fails if the section shows for every read-only state, not just a hold.
    show('member', { readOnly: true, held: false });
    expect(screen.queryByRole('heading', { name: 'Leave community' })).toBeNull();
  });

  it('offers an owner no leave or transfer while held, since a hold allows no transfer', () => {
    // Purpose: fails if the owner sees a transfer form a held community can only refuse.
    show('owner', { readOnly: true, held: true });
    expect(screen.queryByRole('heading', { name: 'Leave community' })).toBeNull();
  });
});
