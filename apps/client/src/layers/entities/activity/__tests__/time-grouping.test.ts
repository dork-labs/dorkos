import { describe, it, expect } from 'vitest';
import { groupByTime, getTimeGroupLabel } from '../model/time-grouping';
import type { ActivityItem } from '@dorkos/shared/activity-schemas';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeItem(occurredAt: string, id = occurredAt): ActivityItem {
  return {
    id,
    occurredAt,
    actorType: 'system',
    actorId: null,
    actorLabel: 'System',
    category: 'system',
    eventType: 'system.started',
    resourceType: null,
    resourceId: null,
    resourceLabel: null,
    summary: 'DorkOS started',
    linkPath: null,
    metadata: null,
  };
}

/**
 * Build a Date relative to a reference by applying a day and hour offset.
 * All arithmetic is done in local time to stay timezone-agnostic.
 */
function localDate(reference: Date, dayOffset: number, hours = 10): Date {
  const d = new Date(reference);
  d.setHours(hours, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

// Reference "now": a Wednesday at 14:00 local time.
// We use Wednesday so that: today=Wed, yesterday=Tue, Mon/Tue=This week, >=2 weeks ago=Earlier.
const NOW = (() => {
  // Find the most recent Wednesday (or today if Wednesday)
  const d = new Date();
  d.setHours(14, 0, 0, 0);
  // Advance to next Wednesday in the fixed year 2026 for determinism
  d.setFullYear(2026, 2, 25); // March 25, 2026 is a Wednesday
  return d;
})();

// ── getTimeGroupLabel ──────────────────────────────────────────────────────

describe('getTimeGroupLabel', () => {
  it('returns "Today" for a timestamp from earlier today (same local day)', () => {
    const date = localDate(NOW, 0, 9); // today at 09:00 local
    expect(getTimeGroupLabel(date, NOW)).toBe('Today');
  });

  it('returns "Today" for the exact start of today (local midnight)', () => {
    const startOfToday = new Date(NOW);
    startOfToday.setHours(0, 0, 0, 0);
    expect(getTimeGroupLabel(startOfToday, NOW)).toBe('Today');
  });

  it('returns "Yesterday" for a timestamp from yesterday (local day -1)', () => {
    const date = localDate(NOW, -1, 10); // yesterday at 10:00 local
    expect(getTimeGroupLabel(date, NOW)).toBe('Yesterday');
  });

  it('returns "This week" for a timestamp earlier in the week', () => {
    // NOW is Wednesday; go back 2 days to Monday (still same week, not yesterday)
    const date = localDate(NOW, -2, 10); // Monday at 10:00 local
    expect(getTimeGroupLabel(date, NOW)).toBe('This week');
  });

  it('returns "Earlier" for a timestamp from last week', () => {
    const date = localDate(NOW, -10, 10); // 10 days ago
    expect(getTimeGroupLabel(date, NOW)).toBe('Earlier');
  });

  it('returns "Earlier" for a timestamp from months ago', () => {
    const date = new Date(NOW);
    date.setFullYear(date.getFullYear() - 1);
    expect(getTimeGroupLabel(date, NOW)).toBe('Earlier');
  });
});

// ── groupByTime ────────────────────────────────────────────────────────────

describe('groupByTime', () => {
  it('returns an empty array for an empty input', () => {
    expect(groupByTime([], NOW)).toEqual([]);
  });

  it('groups all items into "Today" when they all occurred today', () => {
    const items = [
      makeItem(localDate(NOW, 0, 13).toISOString(), 'a'),
      makeItem(localDate(NOW, 0, 10).toISOString(), 'b'),
      makeItem(localDate(NOW, 0, 8).toISOString(), 'c'),
    ];

    const groups = groupByTime(items, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Today');
    expect(groups[0].items).toHaveLength(3);
  });

  it('groups items into Today, Yesterday, and Earlier buckets', () => {
    const items = [
      makeItem(localDate(NOW, 0, 12).toISOString(), 'today'),
      makeItem(localDate(NOW, -1, 9).toISOString(), 'yesterday'),
      makeItem(localDate(NOW, -10, 8).toISOString(), 'earlier'),
    ];

    const groups = groupByTime(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
  });

  it('preserves insertion order within each group', () => {
    const items = [
      makeItem(localDate(NOW, 0, 13).toISOString(), 'a'),
      makeItem(localDate(NOW, 0, 12).toISOString(), 'b'),
      makeItem(localDate(NOW, 0, 11).toISOString(), 'c'),
    ];

    const groups = groupByTime(items, NOW);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('omits empty groups from the output', () => {
    const items = [
      makeItem(localDate(NOW, 0, 12).toISOString(), 'today'),
      makeItem(localDate(NOW, -10, 8).toISOString(), 'earlier'),
    ];

    const groups = groupByTime(items, NOW);
    // Yesterday and This week should be absent
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Earlier']);
  });

  it('outputs groups in canonical Today → Earlier order regardless of item order', () => {
    // Items given in ascending order (oldest first)
    const items = [
      makeItem(localDate(NOW, -10, 8).toISOString(), 'earlier'),
      makeItem(localDate(NOW, -1, 9).toISOString(), 'yesterday'),
      makeItem(localDate(NOW, 0, 12).toISOString(), 'today'),
    ];

    const groups = groupByTime(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier']);
  });

  it('places items into all four groups correctly', () => {
    const items = [
      makeItem(localDate(NOW, 0, 12).toISOString(), 'today'),
      makeItem(localDate(NOW, -1, 10).toISOString(), 'yesterday'),
      makeItem(localDate(NOW, -2, 10).toISOString(), 'this-week'),
      makeItem(localDate(NOW, -10, 8).toISOString(), 'earlier'),
    ];

    const groups = groupByTime(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'This week', 'Earlier']);
    expect(groups[0].items[0].id).toBe('today');
    expect(groups[1].items[0].id).toBe('yesterday');
    expect(groups[2].items[0].id).toBe('this-week');
    expect(groups[3].items[0].id).toBe('earlier');
  });

  it('handles a single item correctly', () => {
    const items = [makeItem(localDate(NOW, -1, 10).toISOString(), 'lone')];
    const groups = groupByTime(items, NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Yesterday');
    expect(groups[0].items[0].id).toBe('lone');
  });
});
