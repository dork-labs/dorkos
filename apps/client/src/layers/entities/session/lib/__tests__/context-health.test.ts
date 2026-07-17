import { describe, it, expect } from 'vitest';
import type { ContextUsage } from '@dorkos/shared/types';
import {
  CONTEXT_WARNING_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
  contextSeverity,
  deriveContextPercent,
  resolveDisplayContextPercent,
} from '../context-health';

describe('context-health thresholds', () => {
  it('pins the amber and red thresholds at 80 and 95', () => {
    // Purpose: the whole point of this module is one threshold set; a silent
    // edit to either constant would move every context surface at once and must
    // be a deliberate, visible change.
    expect(CONTEXT_WARNING_PERCENT).toBe(80);
    expect(CONTEXT_CRITICAL_PERCENT).toBe(95);
  });
});

describe('deriveContextPercent', () => {
  it('computes tokens / window as a whole percent', () => {
    // Purpose: the single formula must yield the expected utilization (90k of a
    // 180k window is half full).
    expect(deriveContextPercent(90_000, 180_000)).toBe(50);
  });

  it('returns null when tokens are missing', () => {
    // Purpose: no token reading -> honest "unknown", never a fabricated 0%.
    expect(deriveContextPercent(null, 180_000)).toBeNull();
    expect(deriveContextPercent(undefined, 180_000)).toBeNull();
  });

  it('returns null when the window is missing, zero, or negative', () => {
    // Purpose: guard the divide-by-zero and a non-positive (unknown) catalog
    // window so a model with no resolvable window reads unknown, not 0%.
    expect(deriveContextPercent(90_000, null)).toBeNull();
    expect(deriveContextPercent(90_000, undefined)).toBeNull();
    expect(deriveContextPercent(90_000, 0)).toBeNull();
    expect(deriveContextPercent(90_000, -1)).toBeNull();
  });

  it('caps at 100 when tokens exceed the window', () => {
    // Purpose: an over-window reading must clamp to 100, never report >100%.
    expect(deriveContextPercent(250_000, 200_000)).toBe(100);
  });
});

describe('contextSeverity', () => {
  it('maps the exact band boundaries', () => {
    // Purpose: the amber/red boundaries are inclusive at 80 and 95 — a
    // one-percent slip either way changes what "near full" and "at the ceiling"
    // mean across every surface.
    expect(contextSeverity(79)).toBe('ok');
    expect(contextSeverity(80)).toBe('warning');
    expect(contextSeverity(94)).toBe('warning');
    expect(contextSeverity(95)).toBe('critical');
  });
});

describe('resolveDisplayContextPercent', () => {
  const usage: ContextUsage = {
    totalTokens: 42_000,
    maxTokens: 200_000,
    percentage: 21,
    model: 'claude-opus-4-6',
    categories: [],
  };

  it('prefers the SDK breakdown percentage over the coarse estimate', () => {
    // Purpose: when a rich breakdown is present it is the authoritative reading,
    // so it must win over the client's coarser catalog estimate.
    expect(resolveDisplayContextPercent(45, usage)).toBe(21);
  });

  it('rounds the SDK percentage to a whole percent', () => {
    // Purpose: the badge displays whole percents; a fractional SDK reading must
    // round exactly as the migrated sites did (no behavior change).
    expect(resolveDisplayContextPercent(90, { ...usage, percentage: 82.4 })).toBe(82);
  });

  it('falls back to the estimate when no breakdown is present', () => {
    // Purpose: without a rich breakdown the coarse estimate (including null) is
    // passed through unchanged.
    expect(resolveDisplayContextPercent(45, null)).toBe(45);
    expect(resolveDisplayContextPercent(45, undefined)).toBe(45);
    expect(resolveDisplayContextPercent(null, undefined)).toBeNull();
  });
});
