import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { CallerPrincipal } from '../../../../lib/caller-principal.js';
import { eventFanOut } from '../../event-fan-out.js';
import {
  broadcastApprovalPending,
  broadcastApprovalResolved,
  broadcastStandingPermissionsChanged,
} from '../approval-events.js';

/** One broadcast: the name, the payload, and the audience it named. */
type Broadcast = [string, unknown, ((principal: CallerPrincipal) => boolean) | undefined];

let sent: Broadcast[] = [];

const APPROVAL: PendingApproval = {
  approvalId: '01J000000000000000000000',
  capabilityId: 'marketplace.uninstall',
  capabilityTitle: 'Uninstall a marketplace package',
  tier: 'destructive',
  summary: 'Would uninstall the flow plugin from this project',
  hasAgentPath: true,
  requestedAt: '2026-08-20T00:00:00.000Z',
  expiresAt: '2026-08-20T00:05:00.000Z',
};

beforeEach(() => {
  sent = [];
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation((name, data, audience) => {
    sent.push([name, data, audience as Broadcast[2]]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approval_pending is addressed (research §6 item 11)', () => {
  it('goes to the operator and not to an agent', () => {
    broadcastApprovalPending(APPROVAL);

    const [name, , audience] = sent[0];
    expect(name).toBe('approval_pending');
    expect(
      typeof audience,
      'approval_pending must name an audience, not go to every connection'
    ).toBe('function');
  });

  it('withholds the card from an agent principal and shows it to the operator', () => {
    broadcastApprovalPending(APPROVAL);
    const audience = sent[0][2];
    expect(typeof audience).toBe('function');

    expect(audience!({ kind: 'operator' })).toBe(true);
    expect(audience!({ kind: 'agent' })).toBe(false);
    expect(audience!({ kind: 'bridged', platform: 'telegram', platformUserId: '7' })).toBe(false);
  });

  it('still carries the card the pending endpoint returns, unchanged', () => {
    broadcastApprovalPending(APPROVAL);
    expect(sent[0][1]).toEqual(APPROVAL);
  });
});

describe('the two events beside it stay unaddressed on purpose', () => {
  it('sends a resolution to every connection: an id and an outcome describe nothing', () => {
    broadcastApprovalResolved(APPROVAL.approvalId, 'granted');
    expect(sent[0][0]).toBe('approval_resolved');
    expect(sent[0][2]).toBeUndefined();
  });

  it('sends a permission-list change to every connection: it says only THAT one moved', () => {
    broadcastStandingPermissionsChanged('created', 'grant-1');
    expect(sent[0][0]).toBe('approval_grant_changed');
    expect(sent[0][2]).toBeUndefined();
  });
});
