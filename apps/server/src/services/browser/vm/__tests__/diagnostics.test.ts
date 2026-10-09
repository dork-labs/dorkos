import { parseBrowserBinding } from '@dorkos/browser/server-owner';
import { describe, it, expect } from 'vitest';
import { createOriginalVMDiagnostics, validateOriginalGuestDiagnostic } from '../diagnostics.mjs';
const binding = parseBrowserBinding({
  browserId: 'B'.repeat(22),
  browserGeneration: 0,
  tabId: 'T'.repeat(22),
  navigationGeneration: 0,
  viewportVersion: 0,
  epoch: 0,
  inputGeneration: 0,
});
const row = {
  event: 'diagnostic-observed' as const,
  tabId: binding.tabId,
  category: 'console' as const,
  severity: 'info' as const,
};
describe('bounded host observational diagnostics', () => {
  it('refuses website payload fields and missing category scalars', () => {
    expect(() => validateOriginalGuestDiagnostic({ ...row, message: 'private' })).toThrow(
      'VM_DIAGNOSTIC_SCHEMA'
    );
    expect(() =>
      validateOriginalGuestDiagnostic({ event: row.event, tabId: row.tabId, category: 'network' })
    ).toThrow('VM_DIAGNOSTIC_SCHEMA');
  });
  it('bounds retained entries and clears payload charges before new epoch', () => {
    const owner = createOriginalVMDiagnostics().open();
    try {
      for (let i = 0; i < 257; i++) owner.observe(row);
      const before = owner.summary(binding);
      expect(before.entries).toHaveLength(256);
      expect(before.counts.dropped).toBe(1);
      expect(before.lastAccountedSequence).toBe(257);
      owner.clear();
      owner.observe(row);
      const after = owner.summary({ ...binding, epoch: 1 });
      expect(after.entries).toHaveLength(1);
      expect(after.entries[0].sequence).toBe(258);
      expect(after.counts.dropped).toBe(0);
    } finally {
      owner.retire();
    }
  });
  it('original budget owner capacity recovers only after payload severing', () => {
    const budget = createOriginalVMDiagnostics(),
      owners = Array.from({ length: 17 }, () => budget.open());
    try {
      expect(owners[16].summary(binding).terminal).toBe('ownerCapacity');
      owners[0].retire();
      const next = budget.open();
      try {
        next.observe(row);
        expect(next.summary(binding).entries).toHaveLength(1);
      } finally {
        next.retire();
      }
    } finally {
      for (const owner of owners) owner.retire();
    }
  });
});
it('accounts exact guest loss deltas across epoch clearing without double charging', () => {
  const owner = createOriginalVMDiagnostics().open();
  try {
    const loss = {
      event: 'diagnostic-loss' as const,
      tabId: binding.tabId,
      dropped: 2,
      correlationDropped: 3,
    };
    owner.observe(loss);
    expect(owner.summary(binding).counts).toEqual({
      dropped: 2,
      truncated: 0,
      correlationDropped: 3,
      unmatchedCallbacks: 0,
    });
    owner.clear();
    owner.observe(loss);
    expect(owner.summary(binding).counts.dropped).toBe(0);
    owner.observe({ ...loss, dropped: 3, correlationDropped: 5 });
    expect(owner.summary(binding).counts.correlationDropped).toBe(2);
    expect(() => owner.observe(loss)).toThrow('VM_DIAGNOSTIC_COUNTER_REGRESSION');
  } finally {
    owner.retire();
  }
});
