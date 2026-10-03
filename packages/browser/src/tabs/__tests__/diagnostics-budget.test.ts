import { it, expect } from 'vitest';
import { createDiagnosticsBudget, DIAGNOSTICS_LIMITS } from '../diagnostics-budget.js';
it('charges all retained owners and atomic joint reservations across browser records', () => {
  const b = createDiagnosticsBudget(),
    owners = Array.from({ length: 16 }, () => b.reserve()!);
  expect(b.reserve()).toBe(null);
  for (const owner of owners)
    for (let i = 0; i < 256; i++)
      expect(b.commit(owner, { entryBytes: 100, correlationBytes: 100 })).toBe(true);
  expect(b.snapshot()).toMatchObject({ owners: 16, entries: 4096, correlations: 4096 });
  expect(b.commit(owners[0], { entryBytes: 100, correlationBytes: 100 })).toBe(false);
  b.discard(owners[0]);
  expect(b.reserve()).not.toBe(null);
  expect(createDiagnosticsBudget().snapshot().owners).toBe(0);
});
it('releases stored scalar charges exactly once and refuses excess entry or scalar widths', () => {
  const b = createDiagnosticsBudget(),
    o = b.reserve()!;
  expect(b.commit(o, { entryBytes: 1025, correlationBytes: 1 })).toBe(false);
  expect(b.snapshot().correlations).toBe(0);
  expect(b.commit(o, { entryBytes: 1, correlationBytes: 1025 })).toBe(false);
  expect(b.commit(o, { entryBytes: 50, correlationBytes: 100 })).toBe(true);
  b.releaseCorrelation(o, 100);
  expect(b.snapshot()).toMatchObject({ entries: 1, correlations: 0 });
  b.discard(o);
  b.discard(o);
  expect(b.snapshot()).toEqual({
    owners: 0,
    entries: 0,
    bytes: 0,
    correlations: 0,
    correlationBytes: 0,
  });
  expect(DIAGNOSTICS_LIMITS.summaryBytes).toBe(256 * 1024 + 4096);
});
