/**
 * What the owner reads in DorkOS about a request to replace them (DOR-2543): every sentence of
 * the banner offers only what this owner can do, and only an open request is a warning.
 */
import { describe, expect, it } from 'vitest';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionOwnerNotice,
} from '@dorkos/shared/community-connections';
import {
  communityPageUrl,
  openOwnerNotice,
  ownerNoticeBanner,
  type OpenOwnerNotice,
} from '../lib/owner-notice';

const UTC = { locale: 'en-US', timeZone: 'UTC' };

const open: OpenOwnerNotice = {
  state: 'open',
  replacementId: 'replacement-1',
  requestState: 'waiting',
  requestedAt: '2026-09-20T10:00:00.000Z',
  claimableAfter: '2026-10-04T10:00:00.000Z',
  claimReissuedAt: null,
  options: { keep: true, transfer: true, delete: true, needsPassword: false },
};
const completed: CommunityConnectionOwnerNotice = {
  state: 'completed',
  replacementId: 'replacement-1',
  newOwnerDisplayName: 'Riley',
  completedAt: '2026-10-05T09:00:00.000Z',
};

describe('what the owner reads', () => {
  it('names the date and offers every option this owner has', () => {
    expect(ownerNoticeBanner(open, 'active', UTC)).toEqual([
      'Someone asked to become this space’s owner',
      'That can happen on or after Sunday, October 4, 2026, unless you keep ownership.',
      'Open the space to keep ownership.',
      'You can also hand it over, or delete it.',
    ]);
  });

  // Purpose: copy never offers what this owner cannot do. Fails if a held or archived community
  // offered a hand-over, or an owner without a password were told they could delete.
  it('offers only deleting when the community cannot be handed over', () => {
    const lines = ownerNoticeBanner(
      { ...open, options: { keep: true, transfer: false, delete: true, needsPassword: false } },
      'archived',
      UTC
    );
    expect(lines.slice(2)).toEqual([
      'Open the space to keep ownership.',
      'You can also delete it.',
    ]);
  });

  it('tells an owner without a password what adding one would allow', () => {
    const noPassword = {
      ...open,
      options: { keep: true as const, transfer: false, delete: false, needsPassword: true },
    };
    expect(ownerNoticeBanner(noPassword, 'active', UTC).slice(2)).toEqual([
      'Open the space to keep ownership.',
      'To hand it over or delete it, add a password to your account.',
    ]);
    expect(ownerNoticeBanner(noPassword, 'archived', UTC).slice(2)).toEqual([
      'Open the space to keep ownership.',
      'To delete it, add a password to your account.',
    ]);
  });

  it('says when the date is not set yet, when it has passed, and when the link was resent', () => {
    expect(ownerNoticeBanner({ ...open, claimableAfter: null }, 'active', UTC)[1]).toBe(
      'That can happen in 7 days or more, unless you keep ownership.'
    );
    expect(ownerNoticeBanner({ ...open, requestState: 'claimable' }, 'active', UTC)[1]).toBe(
      'That can happen at any time now, unless you keep ownership.'
    );
    expect(
      ownerNoticeBanner({ ...open, claimReissuedAt: '2026-09-25T08:00:00.000Z' }, 'active', UTC).at(
        -1
      )
    ).toBe('The new owner’s link was sent again on Friday, September 25, 2026.');
  });

  it('opens the community at its own address on its own host', () => {
    expect(communityPageUrl({ pinnedOrigin: 'https://c.example', remoteCommunityId: 'a b' })).toBe(
      'https://c.example/c/a%20b'
    );
  });

  // Purpose: a completed request is news for the Inbox, not a standing warning: no banner, no dot.
  it('treats only an open request as a warning', () => {
    const completedOn = (ownerNotice?: CommunityConnectionOwnerNotice) =>
      openOwnerNotice({ ownerNotice } as CommunityConnectionDescriptor);
    expect(completedOn(open)).toBe(open);
    expect(completedOn(completed)).toBeNull();
    expect(completedOn(undefined)).toBeNull();
  });
});
