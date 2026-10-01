import { describe, expect, it } from 'vitest';
import {
  CommunityAdminErasureJournalLineSchema,
  CommunityAdminErasureJournalPageSchema,
} from '../community-admin-wire.js';

const ID = '5f1c3c9e-9d7a-4b8e-9f00-1a2b3c4d5e6f';
const FINISHED_AT = '2026-09-30T12:34:56.789Z';
const member = {
  event: 'community.member_erased',
  communityId: ID,
  memberId: ID,
  finishedAt: FINISHED_AT,
};
const account = { event: 'community.account_erased', userId: 'user_1', finishedAt: FINISHED_AT };

// Purpose (DOR-2621): fails if a journal line can leave out when its erasure finished, can carry
// something other than an ISO-8601 time there, or stops refusing fields the server never sends.
describe('CommunityAdminErasureJournalLineSchema', () => {
  it('accepts each kind of line with its finish time, unchanged', () => {
    for (const line of [member, account])
      expect(CommunityAdminErasureJournalLineSchema.parse(line)).toEqual(line);
  });

  it('requires finishedAt on every kind of line', () => {
    for (const { finishedAt: _omitted, ...line } of [member, account])
      expect(CommunityAdminErasureJournalLineSchema.safeParse(line).success, line.event).toBe(
        false
      );
  });

  it('refuses a finishedAt that is not an ISO-8601 time', () => {
    for (const finishedAt of ['', 'yesterday', '2026-09-30', 1_727_700_000_000, null])
      expect(
        CommunityAdminErasureJournalLineSchema.safeParse({ ...member, finishedAt }).success,
        String(finishedAt)
      ).toBe(false);
  });

  it('still refuses a field the server never sends', () => {
    expect(
      CommunityAdminErasureJournalLineSchema.safeParse({ ...account, handle: 'someone' }).success
    ).toBe(false);
  });

  it('parses a page of lines', () => {
    expect(
      CommunityAdminErasureJournalPageSchema.parse({
        lines: [member, account],
        nextCursor: 'cursor',
        hasMore: false,
      }).lines
    ).toEqual([member, account]);
  });
});
