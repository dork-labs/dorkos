/**
 * The picker's pure display rules (spec `claude-account-ui` §6.6): when it may
 * open, which rows can be picked, and the kept-out line's wording.
 */
import { describe, it, expect } from 'vitest';
import type { ContinueOptionAccount } from '@dorkos/shared/account-usage';
import { createMockAccountUsage } from '@dorkos/test-utils';
import { canOpenPicker, isSelectable, keptOutLine } from '../lib/continue-picker';

function row(extra: Partial<ContinueOptionAccount> = {}): ContinueOptionAccount {
  return {
    id: 'acct-2',
    label: 'Acct 2',
    color: '#1d8a4a',
    usage: createMockAccountUsage(),
    eligible: true,
    reason: 'Has usage left.',
    runtime: 'claude-code',
    ...extra,
  };
}

describe('canOpenPicker', () => {
  const claudeOnly = { accounts: [row()], recommendedId: 'acct-2' };
  const withCodex = {
    accounts: [row(), row({ id: 'default', label: null, runtime: 'codex' })],
    recommendedId: 'acct-2',
  };

  it('is closed with the gate off and no other runtime offered', () => {
    expect(canOpenPicker(false, claudeOnly, 'claude-code')).toBe(false);
    expect(canOpenPicker(false, undefined, 'claude-code')).toBe(false);
  });

  it('is open with the gate on', () => {
    expect(canOpenPicker(true, claudeOnly, 'claude-code')).toBe(true);
  });

  it('is open with the gate off when a row carries another runtime', () => {
    expect(canOpenPicker(false, withCodex, 'claude-code')).toBe(true);
  });
});

describe('isSelectable (Q2)', () => {
  it('disables only an account that is out', () => {
    expect(isSelectable(row())).toBe(true);
    expect(isSelectable(row({ eligible: false, reason: 'kept in reserve (50%)' }))).toBe(true);
    expect(
      isSelectable(row({ eligible: false, usage: createMockAccountUsage({ state: 'limited' }) }))
    ).toBe(false);
  });
});

describe('keptOutLine', () => {
  it('says nothing when nothing is left out', () => {
    expect(keptOutLine([])).toBeNull();
  });

  it('names one, two and three accounts', () => {
    expect(keptOutLine(['Client'])).toBe("Client is kept out, so it isn't listed.");
    expect(keptOutLine(['Client', 'Acct 5'])).toBe(
      "Client and Acct 5 are kept out, so they aren't listed."
    );
    expect(keptOutLine(['A', 'B', 'C'])).toBe("A, B and C are kept out, so they aren't listed.");
  });
});
