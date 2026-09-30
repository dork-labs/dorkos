import { describe, expect, it } from 'vitest';
import { formatReplacementDate } from '../dates.js';
import { ownerReplacementOptions } from '../options.js';
import { replacementWait } from '../records.js';
import { canTransition, statesBefore } from '../state.js';

describe('owner replacement states', () => {
  it('never reopens a closed request, and only a claimable one completes or expires', () => {
    // Purpose: fails if a closed state gains a way out, or a request can complete or expire
    // before its claim window opens.
    for (const closed of ['completed', 'objected', 'withdrawn', 'superseded', 'expired'] as const)
      for (const to of ['notifying', 'waiting', 'claimable', 'objected', 'expired'] as const)
        expect(canTransition(closed, to)).toBe(false);
    expect(statesBefore('completed')).toEqual(['claimable']);
    expect(statesBefore('expired')).toEqual(['claimable']);
    expect(statesBefore('objected')).toEqual(['notifying', 'waiting', 'claimable']);
    expect(statesBefore('withdrawn')).toEqual(['notifying', 'waiting', 'claimable']);
    expect(statesBefore('waiting')).toEqual(['notifying']);
  });
});

describe('which wait applies', () => {
  const base = {
    notice_state: 'accepted' as const,
    verified_address: true,
    after_objection: false,
    after_withdrawal: false,
    reason: 'owner_unreachable' as const,
  };
  it('is standard only when every condition holds, and long if any one fails', () => {
    // Purpose: fails if any single condition stops forcing the long wait.
    expect(replacementWait(base)).toBe('standard');
    expect(replacementWait({ ...base, notice_state: 'pending' })).toBeNull();
    for (const change of [
      { notice_state: 'failed' as const },
      { verified_address: false },
      { verified_address: null },
      { after_objection: true },
      { after_withdrawal: true },
      { reason: 'owner_left_group' as const },
    ])
      expect(replacementWait({ ...base, ...change }), JSON.stringify(change)).toBe('long');
    expect(replacementWait({ ...base, reason: 'other' })).toBe('standard');
  });
});

describe("the owner's options", () => {
  it('offers transfer only in an active community with a password, and delete only with one', () => {
    // Purpose: fails if the copy could offer the owner something the routes would refuse.
    expect(ownerReplacementOptions({ lifecycle: 'active', hasPassword: true })).toEqual({
      keep: true,
      transfer: true,
      delete: true,
      needsPassword: false,
    });
    for (const lifecycle of ['archived', 'held'])
      expect(ownerReplacementOptions({ lifecycle, hasPassword: true })).toMatchObject({
        transfer: false,
        delete: true,
      });
    expect(ownerReplacementOptions({ lifecycle: 'active', hasPassword: false })).toEqual({
      keep: true,
      transfer: false,
      delete: false,
      needsPassword: true,
    });
  });
});

describe('dates in owner-replacement copy', () => {
  it('spells out the day and says UTC, whatever the local zone', () => {
    // Purpose: fails if a date shifts with the server's time zone or loses its weekday.
    expect(formatReplacementDate(new Date('2026-09-29T23:30:00Z'))).toBe(
      'Tuesday, 29 September 2026 (UTC)'
    );
  });
});
