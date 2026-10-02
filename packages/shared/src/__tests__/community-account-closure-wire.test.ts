import { describe, expect, it } from 'vitest';
import {
  CommunityAdminAccountClosureRequestSchema,
  CommunityAdminAccountClosureSchema,
  CommunityAdminAccountIdSchema,
  CommunityAdminAccountLookupRequestSchema,
  CommunityAdminHostApiKeyScopeSchema,
} from '../community-admin-wire.js';
import { CommunityWireErrorCodeSchema } from '../community-wire.js';

const ID = '5f1c3c9e-9d7a-4b8e-9f00-1a2b3c4d5e6f';
const AT = '2026-10-01T12:00:00.000Z';

// Purpose (DOR-2557): fails if the host's account closure contract accepts a request the server
// must refuse, drops a field the server sends, or loses its scope or named error.
describe('the account closure contract', () => {
  it('has its own scope and its own error code', () => {
    expect(CommunityAdminHostApiKeyScopeSchema.options).toContain('accounts:close');
    expect(CommunityWireErrorCodeSchema.options).toContain('ACCOUNT_OWNS_COMMUNITY');
  });

  it('needs a reference for other, and only a case-number-shaped one', () => {
    const base = { idempotencyKey: 'k', reason: 'under_minimum_age', reference: null };
    expect(CommunityAdminAccountClosureRequestSchema.safeParse(base).success).toBe(true);
    for (const change of [
      { reason: 'other' },
      { reason: 'spam' },
      { reference: 'https://example.test' },
      { reference: '' },
      { reference: 'x'.repeat(81) },
      { idempotencyKey: '' },
      { extra: true },
    ])
      expect(
        CommunityAdminAccountClosureRequestSchema.safeParse({ ...base, ...change }).success,
        JSON.stringify(change)
      ).toBe(false);
    expect(
      CommunityAdminAccountClosureRequestSchema.safeParse({
        ...base,
        reason: 'other',
        reference: 'TICKET-42',
      }).success
    ).toBe(true);
  });

  it('takes only opaque account ids and bounded identities', () => {
    for (const id of ['abc_DEF-123', 'x'.repeat(128)])
      expect(CommunityAdminAccountIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of ['', 'a/b', 'a b', 'a@b.test', 'x'.repeat(129)])
      expect(CommunityAdminAccountIdSchema.safeParse(id).success, id).toBe(false);
    expect(
      CommunityAdminAccountLookupRequestSchema.safeParse({ issuer: 'i', subject: 'x'.repeat(256) })
        .success
    ).toBe(false);
  });

  it('parses a closure as the server sends it, and nothing more', () => {
    const closure = {
      closureId: ID,
      accountId: 'acct_1',
      state: 'closed',
      reason: 'legal_order',
      reference: 'Order 7',
      personRequested: false,
      actor: { kind: 'api_key', id: ID },
      closedAt: AT,
      eraseAfter: AT,
      waitingOn: 'legal_hold',
      cancelledAt: null,
      erasedAt: null,
    };
    expect(CommunityAdminAccountClosureSchema.parse(closure)).toEqual(closure);
    expect(
      CommunityAdminAccountClosureSchema.safeParse({ ...closure, email: 'a@b.test' }).success
    ).toBe(false);
  });
});
