import { describe, it, expect } from 'vitest';
import {
  ATTENTION_GROUP_DISPLAY,
  ATTENTION_GROUP_ORDER,
  ONBOARDING_GRACE_MS,
  compareAgentAttention,
  isPastOnboardingGrace,
  resolveAgentAttention,
  sortAgentsByAttention,
  type AgentAttentionRow,
} from '../lib/agent-attention';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A quiet agent: seen yesterday, no schedule, no chats, long since registered. */
function agent(overrides: Partial<AgentAttentionRow> = {}): AgentAttentionRow {
  return {
    name: 'agent',
    healthStatus: 'inactive',
    lastSeenAt: '2026-07-24T12:00:00.000Z',
    taskCount: 0,
    chatState: 'inactive',
    isPastOnboardingGrace: true,
    ...overrides,
  };
}

const group = (row: AgentAttentionRow) => resolveAgentAttention(row).group;
const names = (rows: AgentAttentionRow[]) => rows.map((r) => r.name);

// ---------------------------------------------------------------------------
// isPastOnboardingGrace
// ---------------------------------------------------------------------------

describe('isPastOnboardingGrace', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('is false for an agent registered moments ago', () => {
    expect(isPastOnboardingGrace('2026-07-25T11:59:00.000Z', now)).toBe(false);
  });

  it('is false right up to the grace boundary and true at it', () => {
    const justInside = new Date(now - ONBOARDING_GRACE_MS + 1000).toISOString();
    const exactly = new Date(now - ONBOARDING_GRACE_MS).toISOString();
    expect(isPastOnboardingGrace(justInside, now)).toBe(false);
    expect(isPastOnboardingGrace(exactly, now)).toBe(true);
  });

  it('is true for an agent registered months ago', () => {
    expect(isPastOnboardingGrace('2026-01-01T00:00:00.000Z', now)).toBe(true);
  });

  it('treats an unparseable registration date as old rather than new', () => {
    // It cannot prove the agent is fresh, and the rule it gates only fires
    // alongside 24h+ of silence.
    expect(isPastOnboardingGrace('not-a-date', now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveAgentAttention
// ---------------------------------------------------------------------------

describe('resolveAgentAttention', () => {
  it('puts an unreachable agent in "needs you"', () => {
    expect(group(agent({ healthStatus: 'unreachable' }))).toBe('needs-you');
  });

  it('puts an unreachable agent in "needs you" even while chats are live', () => {
    expect(group(agent({ healthStatus: 'unreachable', chatState: 'active' }))).toBe('needs-you');
  });

  it('puts an unreachable agent in "needs you" even when it looks brand new', () => {
    expect(group(agent({ healthStatus: 'unreachable', lastSeenAt: null }))).toBe('needs-you');
  });

  it('puts an agent whose chat is blocked in "needs you"', () => {
    expect(group(agent({ healthStatus: 'inactive', chatState: 'needs-attention' }))).toBe(
      'needs-you'
    );
  });

  it('puts a stale agent with scheduled tasks in "needs you"', () => {
    expect(group(agent({ healthStatus: 'stale', taskCount: 4 }))).toBe('needs-you');
  });

  it('ranks unreachable above a blocked chat, and both above a silent schedule', () => {
    const gone = resolveAgentAttention(agent({ healthStatus: 'unreachable' }));
    const blocked = resolveAgentAttention(agent({ chatState: 'needs-attention' }));
    const silent = resolveAgentAttention(agent({ healthStatus: 'stale', taskCount: 9 }));
    expect([gone.group, blocked.group, silent.group]).toEqual([
      'needs-you',
      'needs-you',
      'needs-you',
    ]);
    expect(gone.severity).toBeGreaterThan(blocked.severity);
    expect(blocked.severity).toBeGreaterThan(silent.severity);
  });

  it('leaves a stale agent with no scheduled tasks quiet', () => {
    expect(group(agent({ healthStatus: 'stale', taskCount: 0 }))).toBe('quiet');
  });

  it('leaves a just-registered agent quiet even with scheduled tasks attached', () => {
    // A DorkBot created seconds ago in onboarding is stale with a null
    // last-seen, and its first scheduled run may not have come due. Flagging it
    // would make a fresh install look broken.
    expect(
      group(
        agent({
          healthStatus: 'stale',
          lastSeenAt: null,
          taskCount: 2,
          isPastOnboardingGrace: false,
        })
      )
    ).toBe('quiet');
  });

  it('flags a long-registered agent that has NEVER reported while carrying schedules', () => {
    // Registration age, not "has been seen before", is the discriminator: an
    // agent registered months ago that never reports while schedules keep coming
    // due is exactly the quietly-failing case, and a last-seen check would hide
    // it in Quiet forever.
    expect(
      group(
        agent({
          healthStatus: 'stale',
          lastSeenAt: null,
          taskCount: 3,
          isPastOnboardingGrace: true,
        })
      )
    ).toBe('needs-you');
  });

  it('puts an agent with live chats in "working"', () => {
    expect(group(agent({ healthStatus: 'inactive', chatState: 'active' }))).toBe('working');
  });

  it('puts an agent seen within the hour in "working"', () => {
    expect(group(agent({ healthStatus: 'active' }))).toBe('working');
  });

  it('ranks an agent with live chats above one merely seen recently', () => {
    const inChat = resolveAgentAttention(agent({ healthStatus: 'active', chatState: 'active' }));
    const seenOnly = resolveAgentAttention(agent({ healthStatus: 'active', chatState: 'idle' }));
    expect(inChat.group).toBe('working');
    expect(inChat.severity).toBeGreaterThan(seenOnly.severity);
  });

  it('leaves an idle agent with nothing scheduled and nothing live quiet', () => {
    expect(group(agent({ healthStatus: 'inactive' }))).toBe('quiet');
  });

  it('gives a merely idle or dormant chat history no pull of its own', () => {
    for (const chatState of ['idle', 'inactive', 'fresh'] as const) {
      expect(group(agent({ healthStatus: 'inactive', chatState }))).toBe('quiet');
    }
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

  it('covers every health status without a schedule or a live chat', () => {
    expect(group(agent({ healthStatus: 'active', lastSeenAt: null }))).toBe('working');
    expect(group(agent({ healthStatus: 'inactive', lastSeenAt: null }))).toBe('quiet');
    expect(group(agent({ healthStatus: 'stale', lastSeenAt: null }))).toBe('quiet');
    expect(group(agent({ healthStatus: 'unreachable', lastSeenAt: null }))).toBe('needs-you');
  });
});

// ---------------------------------------------------------------------------
// Fleet-wide behaviour — the property a per-page session count could not have
// ---------------------------------------------------------------------------

describe('attention across a whole fleet', () => {
  it('reaches "working" for more than one agent at a time', () => {
    // The regression this pins: chat state used to come from a session list
    // scoped to the selected working directory, so at most ONE row in the fleet
    // could ever be in a chat. Working has to be populable fleet-wide.
    const rows = [
      agent({ name: 'a', healthStatus: 'inactive', chatState: 'active' }),
      agent({ name: 'b', healthStatus: 'inactive', chatState: 'active' }),
      agent({ name: 'c', healthStatus: 'inactive', chatState: 'inactive' }),
    ];
    expect(rows.map(group)).toEqual(['working', 'working', 'quiet']);
  });

  it('never lets a chat signal outrank a genuine heartbeat by accident', () => {
    // Both are Working; the live chat leads. What must NOT happen is a stale
    // agent with an old chat history outranking one that checked in this hour.
    const chattyButSilent = agent({
      name: 'chatty',
      healthStatus: 'stale',
      chatState: 'inactive',
    });
    const heartbeat = agent({ name: 'beating', healthStatus: 'active', chatState: 'inactive' });
    expect(names(sortAgentsByAttention([chattyButSilent, heartbeat]))).toEqual([
      'beating',
      'chatty',
    ]);
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
      agent({ name: 'w2', healthStatus: 'inactive', chatState: 'active' }),
      agent({ name: 'n3', chatState: 'needs-attention' }),
    ];
    const groups = sortAgentsByAttention(rows).map(group);
    expect(groups).toEqual([
      'needs-you',
      'needs-you',
      'needs-you',
      'working',
      'working',
      'quiet',
      'quiet',
    ]);
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
