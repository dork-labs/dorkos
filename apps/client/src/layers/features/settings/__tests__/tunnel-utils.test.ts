import { describe, it, expect } from 'vitest';
import { latencyColor } from '../lib/tunnel-utils';

// `friendlyErrorMessage` moved to `@/layers/entities/tunnel` (DOR-1743), so the
// Control Center row can say the same sentence the dialog does; its cases moved
// with it.

describe('latencyColor', () => {
  // Theme tokens from the cockpit's dot vocabulary, not raw palette values —
  // the thresholds are unchanged, only the spelling of each colour.
  it('says nothing about an unknown latency', () => {
    expect(latencyColor(null)).toBe('bg-muted-foreground/40');
  });

  it('returns success for latency under 200ms', () => {
    expect(latencyColor(0)).toBe('bg-status-success');
    expect(latencyColor(100)).toBe('bg-status-success');
    expect(latencyColor(199)).toBe('bg-status-success');
  });

  it('returns warning for latency between 200ms and 499ms', () => {
    expect(latencyColor(200)).toBe('bg-status-warning-dot');
    expect(latencyColor(350)).toBe('bg-status-warning-dot');
    expect(latencyColor(499)).toBe('bg-status-warning-dot');
  });

  it('returns error for latency at or above 500ms', () => {
    expect(latencyColor(500)).toBe('bg-status-error');
    expect(latencyColor(1000)).toBe('bg-status-error');
  });

  it('spends no raw palette value at all', () => {
    // The migration this file used to pin the wrong side of.
    for (const ms of [null, 0, 250, 900]) {
      expect(latencyColor(ms)).not.toMatch(/-(red|green|amber|gray|emerald)-\d/);
    }
  });
});
