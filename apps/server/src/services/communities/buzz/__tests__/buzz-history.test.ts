/**
 * @vitest-environment node
 *
 * The history walk on its own, against the inputs a real relay can produce and a
 * fixture cannot easily arrange end-to-end: ties inside one second, both `limit`
 * semantics, and the two conditions the walk refuses rather than answering
 * short.
 *
 * The conformance suite proves the walk is correct through the adapter. This
 * file proves it is correct at the boundaries, where a silent gap would look
 * exactly like a quiet room.
 */
import { describe, expect, it, vi } from 'vitest';
import { BEGINNING } from '../buzz-cursor.js';
import { DEFAULT_MAX_STEPS, ascending, positionOf, walkHistoryAfter } from '../buzz-history.js';
import { eventId, type NostrEvent, type NostrFilter } from '../buzz-protocol.js';

/** Which end of a range a relay's `limit` keeps. */
type LimitSemantics = 'newest' | 'oldest';

/**
 * One event at a second, with a forced id suffix so a tie's order is arranged
 * rather than hoped for.
 *
 * @param createdAt - The second it lands in.
 * @param nonce - What makes it distinct inside that second.
 */
function event(createdAt: number, nonce: string): NostrEvent {
  const unsigned = {
    pubkey: 'a'.repeat(64),
    created_at: createdAt,
    kind: 9,
    tags: [['h', 'channel']],
    content: nonce,
  };
  return { ...unsigned, id: eventId(unsigned), sig: 'b'.repeat(128) };
}

/**
 * A relay that holds these events and answers filters like one.
 *
 * @param store - Everything the relay holds.
 * @param semantics - Which end its `limit` keeps.
 */
function relay(store: NostrEvent[], semantics: LimitSemantics) {
  return vi.fn((filter: NostrFilter): Promise<NostrEvent[]> => {
    const matching = ascending(
      store.filter(
        (candidate) =>
          (filter.since === undefined || candidate.created_at >= filter.since) &&
          (filter.until === undefined || candidate.created_at <= filter.until)
      )
    );
    const limit = filter.limit ?? matching.length;
    if (matching.length <= limit) return Promise.resolve(matching);
    return Promise.resolve(
      semantics === 'newest' ? matching.slice(-limit) : matching.slice(0, limit)
    );
  });
}

describe('walkHistoryAfter', () => {
  for (const semantics of ['newest', 'oldest'] as const) {
    it(`returns every event after a position, in order, when limit keeps the ${semantics}`, async () => {
      // Deliberately lumpy: two events share second 100 and two share 102, so a
      // page boundary lands inside a tie and a walk that narrowed by timestamp
      // alone would cut one in half.
      const store = [
        event(100, 'a'),
        event(100, 'b'),
        event(101, 'd'),
        event(102, 'e'),
        event(102, 'f'),
        event(103, 'g'),
      ];
      const fetch = relay(store, semantics);

      const all = await walkHistoryAfter({ fetch, base: {}, after: BEGINNING, rawLimit: 2 });
      expect(
        all.map((e) => e.content),
        'a page size of two over six events must still return all six, in the total order'
      ).toEqual(ascending(store).map((e) => e.content));

      // And a resume from the middle of a tie returns the rest of that tie —
      // the case a `created_at`-only cursor cannot express at all.
      const tie = ascending(store).filter((e) => e.created_at === 100);
      const resumed = await walkHistoryAfter({
        fetch,
        base: {},
        after: positionOf(tie[0]!),
        rawLimit: 2,
      });
      expect(
        resumed.map((e) => e.content),
        'resuming from inside a tie must not skip the rest of that second'
      ).toEqual(
        ascending(store)
          .slice(1)
          .map((e) => e.content)
      );
    });
  }

  it('asks for the whole of a second before stepping below it', async () => {
    const store = [event(100, 'a'), event(101, 'b'), event(102, 'c')];
    const fetch = relay(store, 'newest');
    await walkHistoryAfter({ fetch, base: {}, after: BEGINNING, rawLimit: 1 });

    // The narrowing read is the fix for an inclusive `until`: without it the
    // walk re-asks the same window forever. Pinning the shape here keeps that
    // from being quietly optimized back out.
    const pinned = fetch.mock.calls
      .map(([filter]) => filter)
      .filter((filter) => filter.since !== undefined && filter.since === filter.until);
    expect(
      pinned.length,
      'each narrowing step confirms it holds the whole of the second it is about to step below'
    ).toBeGreaterThan(0);
    for (const filter of pinned) {
      expect(filter.limit, 'and asks for one row more than a page, so "too big" is a fact').toBe(2);
    }
  });

  it('refuses rather than answering short when one second is bigger than a read', async () => {
    // Three events in one second with a page size of two: the window cannot be
    // narrowed past that second without splitting it, and a short answer would
    // be indistinguishable from exhaustion.
    const store = [event(100, 'a'), event(100, 'b'), event(100, 'c'), event(101, 'd')];
    await expect(
      walkHistoryAfter({ fetch: relay(store, 'newest'), base: {}, after: BEGINNING, rawLimit: 2 })
    ).rejects.toThrow(/holds more than 2 events/);
  });

  it('refuses rather than answering short when the history is deeper than its budget', async () => {
    const store = Array.from({ length: DEFAULT_MAX_STEPS + 5 }, (_, index) =>
      event(100 + index, `e${index}`)
    );
    await expect(
      walkHistoryAfter({ fetch: relay(store, 'newest'), base: {}, after: BEGINNING, rawLimit: 1 })
    ).rejects.toThrow(/deeper than/);
  });

  it('stops after one read when the relay favours the oldest rows', async () => {
    // The cheap path, pinned so a regression that walked anyway would show up as
    // a round-trip count rather than as a slow test nobody notices.
    const store = [event(100, 'a'), event(101, 'b'), event(102, 'c')];
    const fetch = relay(store, 'oldest');
    const walked = await walkHistoryAfter({ fetch, base: {}, after: BEGINNING, rawLimit: 2 });
    expect(walked).toHaveLength(3);
    expect(
      fetch.mock.calls.length,
      'one saturated page, its probe, its tie read, and the read that exhausts the rest'
    ).toBeLessThanOrEqual(5);
  });
});
