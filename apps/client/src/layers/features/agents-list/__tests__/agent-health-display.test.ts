import { describe, it, expect } from 'vitest';
import { isNeverActive, agentStatusDisplay } from '../lib/agent-health-display';

describe('isNeverActive', () => {
  it('is true for a stale agent that has never been seen', () => {
    expect(isNeverActive('stale', null)).toBe(true);
  });

  it('is false for a dormant agent that has a last-seen timestamp', () => {
    expect(isNeverActive('stale', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('is false for an active/inactive agent even with a null last-seen', () => {
    expect(isNeverActive('active', null)).toBe(false);
    expect(isNeverActive('inactive', null)).toBe(false);
  });

  it('is false for an unreachable agent — a real problem wins over "new"', () => {
    expect(isNeverActive('unreachable', null)).toBe(false);
  });
});

describe('agentStatusDisplay', () => {
  it('presents a never-active agent as "New"', () => {
    expect(agentStatusDisplay('stale', null).label).toBe('New');
  });

  it('presents a dormant agent as "Stale"', () => {
    expect(agentStatusDisplay('stale', '2026-01-01T00:00:00.000Z').label).toBe('Stale');
  });

  it('passes through the health-derived label for active agents', () => {
    expect(agentStatusDisplay('active', '2026-07-20T00:00:00.000Z').label).toBe('Active');
  });
});
