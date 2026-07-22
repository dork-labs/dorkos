import { describe, it, expect } from 'vitest';
import type { AttentionState } from '@/layers/entities/session';
import { agentCardStatusLabel } from '../lib/agent-card-status';

// One entry per AttentionState. Kept as `satisfies Record<AttentionState, ...>`
// so the next widening of the union fails this test's compile until covered.
const CASES = {
  fresh: 'New, say hello',
  active: 'Working now',
  'needs-attention': 'Needs your OK',
  idle: 'idle',
  inactive: 'inactive',
} satisfies Record<AttentionState, string>;

describe('agentCardStatusLabel', () => {
  it('maps fresh to a greeting prompt', () => {
    expect(agentCardStatusLabel('fresh', null)).toBe(CASES.fresh);
  });

  it('maps active to "Working now"', () => {
    expect(agentCardStatusLabel('active', '2026-07-22T00:00:00.000Z')).toBe(CASES.active);
  });

  it('maps needs-attention to "Needs your OK"', () => {
    expect(agentCardStatusLabel('needs-attention', null)).toBe(CASES['needs-attention']);
  });

  it('phrases idle with its last-activity time', () => {
    const label = agentCardStatusLabel('idle', '2026-01-05T00:00:00.000Z');
    expect(label.startsWith('Idle since ')).toBe(true);
    expect(label).not.toBe('Idle');
  });

  it('phrases inactive as resting with its last-activity time', () => {
    const label = agentCardStatusLabel('inactive', '2026-01-05T00:00:00.000Z');
    expect(label.startsWith('Resting since ')).toBe(true);
  });

  it('falls back to the bare word when there is no activity timestamp', () => {
    expect(agentCardStatusLabel('idle', null)).toBe('Idle');
    expect(agentCardStatusLabel('inactive', null)).toBe('Resting');
  });

  it('never uses the sidebar-only "Stale"/"Never" vocabulary', () => {
    for (const state of Object.keys(CASES) as AttentionState[]) {
      const label = agentCardStatusLabel(state, '2026-01-05T00:00:00.000Z');
      expect(label).not.toMatch(/stale|never/i);
    }
  });
});
