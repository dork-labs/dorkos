/**
 * The credits offer's first word comes from the account's own figures, never
 * from a plan name or price (catalog blindness).
 */
import { describe, expect, it } from 'vitest';
import type { CloudPlanResponse } from '@dorkos/shared/cloud-schemas';
import { creditsVerb } from '../lib/credits-verb';

function plan(granted: string, remaining: string, added: string): CloudPlanResponse {
  return {
    available: true,
    entitlements: {} as never,
    balance: {
      allowance: {
        grantedMicro: granted,
        remainingMicro: remaining,
        resetsAt: '2026-11-01T00:00:00Z',
      },
      purchased: { remainingMicro: added },
    } as never,
  };
}

describe('creditsVerb', () => {
  it('says "Use" signed out, where nothing is known about the account', () => {
    expect(creditsVerb(false, plan('5', '0', '0'))).toBe('Use');
    expect(creditsVerb(false, undefined)).toBe('Use');
  });

  it('says "Try" for included credits never spent with nothing added', () => {
    expect(creditsVerb(true, plan('5000000', '5000000', '0'))).toBe('Try');
  });

  it('says "Buy" when nothing is left and nothing was added', () => {
    expect(creditsVerb(true, plan('5000000', '0', '0'))).toBe('Buy');
    expect(creditsVerb(true, plan('0', '0', '0'))).toBe('Buy');
  });

  it('says "Use" for an account that has spent from its credits or added some', () => {
    expect(creditsVerb(true, plan('5000000', '3000000', '0'))).toBe('Use');
    expect(creditsVerb(true, plan('5000000', '0', '2000000'))).toBe('Use');
  });

  it('waits, saying nothing, while a signed-in plan is still loading', () => {
    expect(creditsVerb(true, undefined)).toBeNull();
  });

  it('says "Use" for any answer it cannot read', () => {
    expect(creditsVerb(true, { available: false })).toBe('Use');
    expect(creditsVerb(true, plan('5.0', '5.0', '0'))).toBe('Use');
  });
});
