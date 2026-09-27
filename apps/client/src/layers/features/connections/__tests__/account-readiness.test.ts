import { describe, expect, it } from 'vitest';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { accountAttention, usableAccounts } from '../lib/account-readiness';

const READY: ConnectorConnectionSummary = {
  connectionId: 'connection-1' as never,
  providerInstanceId: 'composio-1' as never,
  toolkit: 'gmail',
  label: 'work',
  identityHint: null,
  lifecycle: 'connected',
  authenticationStatus: 'active',
  reconciliationStatus: 'ready',
  authoritySync: { status: 'ready' },
  mode: 'byo',
  custody: 'managed',
  payer: 'operator_byo',
  agentCount: 0,
  subscriptionCount: 0,
  usage: { status: 'available', logicalOperationCount: 0, attemptCount: 0 },
  warnings: [],
  everyAgent: null,
};

describe('account readiness', () => {
  it('offers a connected, signed-in, reviewed account of the app', () => {
    expect(usableAccounts([READY], 'gmail')).toEqual([READY]);
    expect(usableAccounts([READY], 'slack')).toEqual([]);
  });

  it('never offers a disconnected account, even one still signed in', () => {
    expect(usableAccounts([{ ...READY, lifecycle: 'disconnected' }], 'gmail')).toEqual([]);
  });

  it('names the one fix a paused, signed-out or unreviewed account needs', () => {
    expect(accountAttention({ ...READY, lifecycle: 'paused' })).toEqual({ kind: 'paused' });
    expect(accountAttention({ ...READY, authenticationStatus: 'revoked' })).toEqual({
      kind: 'signed_out',
    });
    expect(
      accountAttention({ ...READY, reconciliationStatus: 'migration_needs_reconcile' })
    ).toEqual({ kind: 'needs_review' });
  });

  it("ignores the account-wide sync state, which spans every agent's access", () => {
    expect(accountAttention({ ...READY, authoritySync: { status: 'pending' } })).toBeNull();
    expect(
      accountAttention({ ...READY, authoritySync: { status: 'failed', reason: 'x' } })
    ).toBeNull();
  });
});
