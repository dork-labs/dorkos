import { describe, expect, it } from 'vitest';
import { activeCooldown, hostRowSentence, type HostReplacement } from '../copy.js';

// Each host row in words (specs/community-owner-replacement, "Host page"): every state, the
// standard wait, and each reason for the longer one.
const DAY = 24 * 60 * 60_000;

function row(overrides: Partial<HostReplacement> = {}): HostReplacement {
  return {
    replacementId: '22222222-2222-4222-8222-222222222222',
    communityId: '11111111-1111-4111-8111-111111111111',
    state: 'waiting',
    reason: 'owner_unreachable',
    reference: null,
    claimantNamed: false,
    requestedAt: '2026-09-20T10:00:00.000Z',
    requestedBy: { kind: 'person', label: 'Host Operator' },
    notice: { state: 'accepted', resolvedAt: '2026-09-20T10:05:00.000Z', verifiedAddress: true },
    wait: 'standard',
    claimableAfter: '2026-10-04T10:05:00.000Z',
    claimExpiresAt: null,
    claimReissuedAt: null,
    endedAt: null,
    withdrawnBecause: null,
    cooldownUntil: null,
    ...overrides,
  };
}
const until = 'The owner has until Sunday, 4 October 2026 (UTC).';

describe('hostRowSentence', () => {
  it.each<[string, Partial<HostReplacement>, string]>([
    [
      'notifying',
      {
        state: 'notifying',
        notice: { state: 'pending', resolvedAt: null, verifiedAddress: null },
        wait: null,
        claimableAfter: null,
      },
      'Sending the notice to the owner.',
    ],
    [
      'waiting, standard',
      {},
      `The owner’s mail server accepted the notice on Sunday, 20 September 2026 (UTC). ${until}`,
    ],
    [
      'waiting, failed mail',
      {
        wait: 'long',
        notice: { state: 'failed', resolvedAt: '2026-09-23T10:00:00.000Z', verifiedAddress: null },
      },
      `${until} The notice couldn’t be delivered by email.`,
    ],
    [
      'waiting, unconfirmed address',
      {
        wait: 'long',
        notice: {
          state: 'accepted',
          resolvedAt: '2026-09-20T10:05:00.000Z',
          verifiedAddress: false,
        },
      },
      `${until} The owner’s email address was never confirmed.`,
    ],
    [
      'waiting, owner left',
      { wait: 'long', reason: 'owner_left_group' },
      `${until} Requests saying the owner has left always have the longer wait.`,
    ],
    [
      'claimable',
      { state: 'claimable', claimExpiresAt: '2026-10-18T10:05:00.000Z' },
      'The new owner can accept until Sunday, 18 October 2026 (UTC).',
    ],
    [
      'completed',
      { state: 'completed', endedAt: '2026-10-05T09:00:00.000Z' },
      'The new owner accepted on Monday, 5 October 2026 (UTC).',
    ],
    [
      'objected',
      {
        state: 'objected',
        endedAt: '2026-09-22T09:00:00.000Z',
        cooldownUntil: '2026-12-21T09:00:00.000Z',
      },
      'The owner kept ownership on Tuesday, 22 September 2026 (UTC). You can ask again after Monday, 21 December 2026 (UTC).',
    ],
    [
      'withdrawn by the host',
      { state: 'withdrawn', endedAt: '2026-09-22T09:00:00.000Z', withdrawnBecause: 'cancelled' },
      'Withdrawn on Tuesday, 22 September 2026 (UTC) by you.',
    ],
    [
      'withdrawn by suspension',
      { state: 'withdrawn', endedAt: '2026-09-22T09:00:00.000Z', withdrawnBecause: 'suspended' },
      'Withdrawn on Tuesday, 22 September 2026 (UTC) because the community was suspended.',
    ],
    [
      'withdrawn by deletion',
      { state: 'withdrawn', endedAt: '2026-09-22T09:00:00.000Z', withdrawnBecause: 'deletion' },
      'Withdrawn on Tuesday, 22 September 2026 (UTC) because the community is being deleted.',
    ],
    [
      'superseded',
      { state: 'superseded', endedAt: '2026-09-22T09:00:00.000Z' },
      'Ended on Tuesday, 22 September 2026 (UTC) because the owner handed the community to someone or asked to delete it.',
    ],
    [
      'expired',
      { state: 'expired', endedAt: '2026-10-18T10:05:00.000Z' },
      'The new owner didn’t accept in time. Ended on Sunday, 18 October 2026 (UTC).',
    ],
  ])('%s', (_label, overrides, sentence) => {
    // Purpose: fails if any state or wait reason is said with another state's words.
    const current = row(overrides);
    expect(hostRowSentence(current, [current])).toBe(sentence);
  });

  it('gives the longer-wait reason from an earlier objection', () => {
    // Purpose: fails if a request after an objection is not explained as such.
    const earlier = row({
      replacementId: '33333333-3333-4333-8333-333333333333',
      state: 'objected',
      requestedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-05T00:00:00.000Z',
      cooldownUntil: '2026-04-05T00:00:00.000Z',
    });
    const current = row({ wait: 'long' });
    expect(hostRowSentence(current, [current, earlier])).toBe(
      `${until} The owner kept ownership before, so this request has the longer wait.`
    );
  });

  it('gives the longer-wait reason from a withdrawal less than 30 days before', () => {
    // Purpose: fails if a recent withdrawal is not named, or an old one is.
    const withdrawn = (daysBefore: number) =>
      row({
        replacementId: '44444444-4444-4444-8444-444444444444',
        state: 'withdrawn',
        withdrawnBecause: 'cancelled',
        endedAt: new Date(Date.parse('2026-09-20T10:00:00.000Z') - daysBefore * DAY).toISOString(),
      });
    const current = row({ wait: 'long', reason: 'other' });
    expect(hostRowSentence(current, [current, withdrawn(29)])).toBe(
      `${until} An earlier request was withdrawn less than 30 days ago, so this one has the longer wait.`
    );
    expect(hostRowSentence(current, [current, withdrawn(31)])).toBe(until);
  });
});

describe('activeCooldown', () => {
  it('lasts until the host may ask again after the latest objection', () => {
    // Purpose: fails if an ended cooling-off still blocks the host, or an open one does not.
    const objected = row({
      state: 'objected',
      endedAt: '2026-09-22T09:00:00.000Z',
      cooldownUntil: '2026-12-21T09:00:00.000Z',
    });
    expect(activeCooldown([objected], Date.parse('2026-12-21T08:59:00.000Z'))).toEqual({
      keptOn: '2026-09-22T09:00:00.000Z',
      askAgainAfter: '2026-12-21T09:00:00.000Z',
    });
    expect(activeCooldown([objected], Date.parse('2026-12-21T09:00:00.000Z'))).toBeNull();
    expect(
      activeCooldown([row({ state: 'expired', endedAt: '2026-09-22T09:00:00.000Z' })], 0)
    ).toBeNull();
  });
});
