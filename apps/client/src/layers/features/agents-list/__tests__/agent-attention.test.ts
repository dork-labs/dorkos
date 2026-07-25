import { describe, it, expect } from 'vitest';
import {
  ATTENTION_GROUP_DISPLAY,
  ATTENTION_GROUP_ORDER,
  compareAgentAttention,
  resolveAgentAttention,
  sortAgentsByAttention,
  type AgentAttentionRow,
} from '../lib/agent-attention';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A quiet agent: seen yesterday, no schedule, no sessions. */
function agent(overrides: Partial<AgentAttentionRow> = {}): AgentAttentionRow {
  return {
    name: 'agent',
    healthStatus: 'inactive',
    lastSeenAt: '2026-07-24T12:00:00.000Z',
    taskCount: 0,
    sessionCount: 0,
    ...overrides,
  };
}

const group = (row: AgentAttentionRow) => resolveAgentAttention(row).group;
const names = (rows: AgentAttentionRow[]) => rows.map((r) => r.name);

// ---------------------------------------------------------------------------
// resolveAgentAttention
// ---------------------------------------------------------------------------

describe('resolveAgentAttention', () => {
  it('puts an unreachable agent in "needs you"', () => {
    expect(group(agent({ healthStatus: 'unreachable' }))).toBe('needs-you');
  });

  it('puts an unreachable agent in "needs you" even while sessions are open', () => {
    expect(group(agent({ healthStatus: 'unreachable', sessionCount: 3 }))).toBe('needs-you');
  });

  it('puts an unreachable agent in "needs you" even when it looks brand new', () => {
    expect(group(agent({ healthStatus: 'unreachable', lastSeenAt: null }))).toBe('needs-you');
  });

  it('puts a stale agent with scheduled tasks in "needs you"', () => {
    expect(group(agent({ healthStatus: 'stale', taskCount: 4 }))).toBe('needs-you');
  });

  it('ranks unreachable above stale-with-a-schedule', () => {
    const unreachable = resolveAgentAttention(agent({ healthStatus: 'unreachable' }));
    const silent = resolveAgentAttention(agent({ healthStatus: 'stale', taskCount: 9 }));
    expect(unreachable.group).toBe(silent.group);
    expect(unreachable.severity).toBeGreaterThan(silent.severity);
  });

  it('leaves a stale agent with no scheduled tasks quiet', () => {
    expect(group(agent({ healthStatus: 'stale', taskCount: 0 }))).toBe('quiet');
  });

  it('leaves a never-active agent quiet even with scheduled tasks attached', () => {
    // A DorkBot created seconds ago in onboarding is stale with a null
    // last-seen. Flagging it would make a fresh install look broken.
    expect(group(agent({ healthStatus: 'stale', lastSeenAt: null, taskCount: 2 }))).toBe('quiet');
  });

  it('puts an agent with open sessions in "working"', () => {
    expect(group(agent({ healthStatus: 'inactive', sessionCount: 1 }))).toBe('working');
  });

  it('puts an agent seen within the hour in "working"', () => {
    expect(group(agent({ healthStatus: 'active' }))).toBe('working');
  });

  it('ranks an agent with open sessions above one merely seen recently', () => {
    const inSession = resolveAgentAttention(agent({ healthStatus: 'active', sessionCount: 1 }));
    const seenOnly = resolveAgentAttention(agent({ healthStatus: 'active', sessionCount: 0 }));
    expect(inSession.group).toBe('working');
    expect(inSession.severity).toBeGreaterThan(seenOnly.severity);
  });

  it('leaves an idle agent with nothing scheduled and nothing open quiet', () => {
    expect(group(agent({ healthStatus: 'inactive' }))).toBe('quiet');
  });

  it('does not promote an agent for having scheduled tasks alone', () => {
    expect(group(agent({ healthStatus: 'inactive', taskCount: 12 }))).toBe('quiet');
    expect(group(agent({ healthStatus: 'active', taskCount: 12 }))).toBe('working');
  });

  it('gives a zero task count no influence at all', () => {
    for (const healthStatus of ['active', 'inactive', 'stale', 'unreachable'] as const) {
      const withZero = resolveAgentAttention(agent({ healthStatus, taskCount: 0 }));
      const withNone = resolveAgentAttention(agent({ healthStatus }));
      expect(withZero).toEqual(withNone);
    }
  });

  it('ranks a system agent by the same rules as any other', () => {
    // No carve-out: DorkBot's folder going missing breaks as much as any other.
    const dorkbot = agent({ name: 'dorkbot', healthStatus: 'unreachable' });
    const other = agent({ name: 'scout', healthStatus: 'unreachable' });
    expect(resolveAgentAttention(dorkbot)).toEqual(resolveAgentAttention(other));
  });

  it('covers every health status without a schedule or a session', () => {
    expect(group(agent({ healthStatus: 'active', lastSeenAt: null }))).toBe('working');
    expect(group(agent({ healthStatus: 'inactive', lastSeenAt: null }))).toBe('quiet');
    expect(group(agent({ healthStatus: 'stale', lastSeenAt: null }))).toBe('quiet');
    expect(group(agent({ healthStatus: 'unreachable', lastSeenAt: null }))).toBe('needs-you');
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('sortAgentsByAttention', () => {
  it('orders needs you, then working, then quiet', () => {
    const rows = [
      agent({ name: 'quiet-one', healthStatus: 'inactive' }),
      agent({ name: 'working-one', healthStatus: 'active' }),
      agent({ name: 'broken-one', healthStatus: 'unreachable' }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['broken-one', 'working-one', 'quiet-one']);
  });

  it('orders by severity within a group', () => {
    const rows = [
      agent({ name: 'silent-schedule', healthStatus: 'stale', taskCount: 3 }),
      agent({ name: 'gone', healthStatus: 'unreachable' }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['gone', 'silent-schedule']);
  });

  it('puts the most recently active agent first inside one severity', () => {
    const rows = [
      agent({ name: 'older', healthStatus: 'active', lastSeenAt: '2026-07-25T09:00:00.000Z' }),
      agent({ name: 'newer', healthStatus: 'active', lastSeenAt: '2026-07-25T10:00:00.000Z' }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['newer', 'older']);
  });

  it('breaks a full tie on display name so the order never twitches', () => {
    const tie = { healthStatus: 'active' as const, lastSeenAt: '2026-07-25T10:00:00.000Z' };
    const rows = [agent({ name: 'zeta', ...tie }), agent({ name: 'alpha', ...tie })];
    expect(names(sortAgentsByAttention(rows))).toEqual(['alpha', 'zeta']);
  });

  it('breaks a tie on the display name shown, not the raw slug', () => {
    const tie = { healthStatus: 'active' as const, lastSeenAt: '2026-07-25T10:00:00.000Z' };
    const rows = [
      agent({ name: 'aaa-slug', displayName: 'Zebra', ...tie }),
      agent({ name: 'zzz-slug', displayName: 'Antelope', ...tie }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['zzz-slug', 'aaa-slug']);
  });

  it('sorts a never-seen agent last among its peers', () => {
    const rows = [
      agent({ name: 'never', healthStatus: 'stale', lastSeenAt: null }),
      agent({ name: 'yesterday', healthStatus: 'inactive' }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['yesterday', 'never']);
  });

  it('treats an unparseable timestamp as never seen rather than throwing', () => {
    const rows = [
      agent({ name: 'garbled', healthStatus: 'inactive', lastSeenAt: 'not-a-date' }),
      agent({ name: 'real', healthStatus: 'inactive' }),
    ];
    expect(names(sortAgentsByAttention(rows))).toEqual(['real', 'garbled']);
  });

  it('reverses the whole comparison when the direction is descending', () => {
    const rows = [
      agent({ name: 'gone', healthStatus: 'unreachable' }),
      agent({ name: 'working', healthStatus: 'active' }),
      agent({ name: 'idle', healthStatus: 'inactive' }),
    ];
    expect(names(sortAgentsByAttention(rows, 'desc'))).toEqual(['idle', 'working', 'gone']);
  });

  it('returns a new array and leaves the input untouched', () => {
    const rows = [
      agent({ name: 'quiet-one', healthStatus: 'inactive' }),
      agent({ name: 'broken-one', healthStatus: 'unreachable' }),
    ];
    const sorted = sortAgentsByAttention(rows);
    expect(sorted).not.toBe(rows);
    expect(names(rows)).toEqual(['quiet-one', 'broken-one']);
  });

  it('handles an empty fleet', () => {
    expect(sortAgentsByAttention([])).toEqual([]);
  });

  it('keeps every group contiguous, which the table relies on for headers', () => {
    const rows = [
      agent({ name: 'q1', healthStatus: 'inactive' }),
      agent({ name: 'n1', healthStatus: 'unreachable' }),
      agent({ name: 'w1', healthStatus: 'active' }),
      agent({ name: 'q2', healthStatus: 'stale' }),
      agent({ name: 'n2', healthStatus: 'stale', taskCount: 1 }),
      agent({ name: 'w2', healthStatus: 'inactive', sessionCount: 2 }),
    ];
    const groups = sortAgentsByAttention(rows).map(group);
    expect(groups).toEqual(['needs-you', 'needs-you', 'working', 'working', 'quiet', 'quiet']);
    // Each group appears as one uninterrupted run, which is what lets the table
    // emit a header wherever the key changes.
    const runs = groups.filter((value, index) => value !== groups[index - 1]);
    expect(runs).toEqual([...new Set(groups)]);
  });
});

describe('compareAgentAttention', () => {
  it('reports two identical rows as equal', () => {
    expect(compareAgentAttention(agent(), agent())).toBe(0);
  });

  it('is antisymmetric', () => {
    const a = agent({ name: 'a', healthStatus: 'unreachable' });
    const b = agent({ name: 'b', healthStatus: 'active' });
    expect(compareAgentAttention(a, b)).toBeLessThan(0);
    expect(compareAgentAttention(b, a)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Presentation contract
// ---------------------------------------------------------------------------

describe('attention group metadata', () => {
  it('has display copy for every group in the render order', () => {
    for (const key of ATTENTION_GROUP_ORDER) {
      expect(ATTENTION_GROUP_DISPLAY[key].label).toBeTruthy();
      expect(ATTENTION_GROUP_DISPLAY[key].toneClass).toBeTruthy();
    }
  });

  it('reads in plain words, not internal state names', () => {
    expect(ATTENTION_GROUP_DISPLAY['needs-you'].label).toBe('Needs you');
    expect(ATTENTION_GROUP_DISPLAY.working.label).toBe('Working');
    expect(ATTENTION_GROUP_DISPLAY.quiet.label).toBe('Quiet');
  });
});
