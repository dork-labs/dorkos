/**
 * Laying out only the changed tail gives exactly what a full layout gives
 * (DOR-2912). Checked over many generated transcripts: authors switching, day
 * boundaries, long silences, missing timestamps and unread cursors.
 */
import { describe, it, expect } from 'vitest';
import { buildTimelineRows, relayTimelineRows } from '../group-timeline';
import type { TimelineItem } from '../group-timeline';

/** A small deterministic random source, so a failure reproduces. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function transcript(rand: () => number, length: number): TimelineItem[] {
  let time = Date.parse('2026-09-01T08:00:00Z');
  return Array.from({ length }, (_, i) => {
    // Mostly a minute apart, sometimes a long silence, sometimes overnight.
    const step = rand();
    time += step < 0.8 ? 60_000 : step < 0.95 ? 6 * 60_000 : 20 * 60 * 60_000;
    return {
      id: `m${i}`,
      authorId: rand() < 0.6 ? 'agent' : rand() < 0.5 ? 'person' : 'other',
      timestamp: rand() < 0.03 ? '' : new Date(time).toISOString(),
    };
  });
}

describe('relayTimelineRows', () => {
  it('matches a full layout, whatever changed after the unchanged prefix', () => {
    const rand = random(2912);
    const now = Date.parse('2026-09-10T12:00:00Z');
    for (let trial = 0; trial < 300; trial++) {
      const before = transcript(rand, 2 + Math.floor(rand() * 60));
      const cursorAt = Math.floor(rand() * (before.length + 3));
      const options = {
        now,
        lastSeenId: cursorAt < before.length ? before[cursorAt]!.id : null,
        unreadFromStart: rand() < 0.1,
      };
      const previous = buildTimelineRows(before, options);
      // Keep a prefix, then change the rest: a new last message, more messages,
      // a different author, or fewer messages.
      const from = Math.floor(rand() * before.length);
      const tail = transcript(rand, Math.floor(rand() * 8)).map((item, i) => ({
        ...item,
        id: `t${trial}-${i}`,
        timestamp: item.timestamp && before[from - 1]?.timestamp ? item.timestamp : '',
      }));
      const after = [...before.slice(0, from), ...tail];
      const { rows, kept } = relayTimelineRows(after, options, previous, from);
      expect(rows).toEqual(buildTimelineRows(after, options));
      // What it kept are the very same row objects.
      for (let r = 0; r < kept; r++) expect(rows[r]).toBe(previous[r]);
    }
  });

  it('keeps all but the last group while only the last message changes', () => {
    const items = transcript(random(7), 40);
    const options = { now: Date.parse('2026-09-10T12:00:00Z') };
    const previous = buildTimelineRows(items, options);
    const changed = [...items.slice(0, -1), { ...items.at(-1)!, id: 'live' }];
    const { kept } = relayTimelineRows(changed, options, previous, items.length - 1);
    expect(kept).toBeGreaterThan(previous.length / 2);
  });

  it('stays exact across a chain of relays, with surviving tail ids and the cursor in the tail', () => {
    const rand = random(1729);
    const now = Date.parse('2026-09-10T12:00:00Z');
    for (let trial = 0; trial < 150; trial++) {
      let items = transcript(rand, 5 + Math.floor(rand() * 40));
      const cursor = items[Math.floor(rand() * items.length)]!.id;
      const options = { now, lastSeenId: cursor, unreadFromStart: false };
      let previous = buildTimelineRows(items, options);
      for (let step = 0; step < 4; step++) {
        // The streaming case: the same ids from `from` on, as new objects, and
        // now and then one more message or one fewer.
        const from = Math.max(0, items.length - 1 - Math.floor(rand() * 3));
        const tail = items.slice(from).map((item) => ({ ...item }));
        if (rand() < 0.3) tail.push({ ...transcript(rand, 1)[0]!, id: `x${trial}-${step}` });
        if (rand() < 0.2) tail.pop();
        const next = [...items.slice(0, from), ...tail];
        const snapshot = structuredClone(previous);
        const { rows } = relayTimelineRows(next, options, previous, from);
        expect(rows).toEqual(buildTimelineRows(next, options));
        // The previous layout was not touched.
        expect(previous).toEqual(snapshot);
        items = next;
        previous = rows;
      }
    }
  });

  it('lays out afresh when told more items are unchanged than there are', () => {
    const items = transcript(random(3), 10);
    const options = { now: Date.parse('2026-09-10T12:00:00Z') };
    const previous = buildTimelineRows(items, options);
    const shorter = items.slice(0, 4);
    const { rows } = relayTimelineRows(shorter, options, previous, 10);
    expect(rows).toEqual(buildTimelineRows(shorter, options));
  });
});
