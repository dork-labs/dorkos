import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_INTERACTION_RECORDS, interactionKey, useInteractionStore } from '../index';

describe('interactionKey', () => {
  it('keys every kind in one space', () => {
    expect(interactionKey('session', 'abc')).toBe('session:abc');
    expect(interactionKey('room', 'r1')).toBe('room:r1');
    expect(interactionKey('agent', '/repos/dorkos')).toBe('agent:/repos/dorkos');
  });

  it('cannot collide across kinds for the same id', () => {
    expect(interactionKey('session', 'x')).not.toBe(interactionKey('room', 'x'));
  });
});

describe('useInteractionStore', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it('records when a thing was opened, as ISO-8601', () => {
    useInteractionStore.getState().recordOpened('session', 's1', 1_700_000_000_000);
    expect(useInteractionStore.getState().opened['session:s1']).toBe('2023-11-14T22:13:20.000Z');
  });

  it('stores a value the model can parse — never epoch milliseconds', () => {
    // The whole point of the shared type. `Date.parse(String(1700000000000))` is
    // NaN, which the sidebar reads as "never interacted with" and silently
    // collapses Today to alphabetical order.
    useInteractionStore.getState().recordOpened('session', 's1', 1_700_000_000_000);
    const stored = useInteractionStore.getState().opened['session:s1'] ?? '';
    expect(Number.isNaN(Date.parse(stored))).toBe(false);
    expect(Date.parse(stored)).toBe(1_700_000_000_000);
  });

  it('overwrites an earlier open with the later one', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('room', 'r1', 1_000);
    recordOpened('room', 'r1', 2_000);
    expect(Date.parse(useInteractionStore.getState().opened['room:r1'] ?? '')).toBe(2_000);
  });

  it('keeps kinds apart for the same id', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 'x', 1_000);
    recordOpened('agent', 'x', 2_000);
    expect(Object.keys(useInteractionStore.getState().opened).sort()).toEqual([
      'agent:x',
      'session:x',
    ]);
  });

  it('defaults to the current instant when no time is given', () => {
    const before = Date.now();
    useInteractionStore.getState().recordOpened('session', 's2');
    const recorded = Date.parse(useInteractionStore.getState().opened['session:s2'] ?? '');
    expect(recorded).toBeGreaterThanOrEqual(before);
  });

  it('does not mutate the previous record map', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 'a', 1);
    const first = useInteractionStore.getState().opened;
    recordOpened('session', 'b', 2);
    expect(useInteractionStore.getState().opened).not.toBe(first);
    expect(Object.keys(first)).toEqual(['session:a']);
  });

  it('persists to storage', () => {
    useInteractionStore.getState().recordOpened('session', 'persisted', 42);
    expect(window.localStorage.getItem('dorkos:interactions-v1')).toContain('persisted');
  });
});

describe('how often, beside when', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it('counts every open, for every kind — not agents alone', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 's1', 1_000);
    recordOpened('session', 's1', 2_000);
    recordOpened('room', 'r1', 3_000);
    recordOpened('agent', '/repos/a', 4_000);

    expect(useInteractionStore.getState().counts).toEqual({
      'session:s1': 2,
      'room:r1': 1,
      'agent:/repos/a': 1,
    });
  });

  it('leaves the timestamp map exactly as the sidebar has always read it', () => {
    // The regression this whole extension is measured against: Today's order
    // key is `opened`, and it must be byte-identical to what it was before
    // counts existed. A count leaking into it would parse to NaN and collapse
    // Today to alphabetical order with nothing thrown.
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 's1', 1_700_000_000_000);
    recordOpened('session', 's1', 1_700_000_060_000);

    expect(useInteractionStore.getState().opened).toEqual({
      'session:s1': '2023-11-14T22:14:20.000Z',
    });
  });

  it('persists the counts, so how often survives a reload', () => {
    useInteractionStore.getState().recordOpened('agent', '/repos/a', 42);
    const raw = window.localStorage.getItem('dorkos:interactions-v1') ?? '';
    expect(JSON.parse(raw).state.counts).toEqual({ 'agent:/repos/a': 1 });
  });

  it('starts a store that has never counted at zero, rather than undefined', () => {
    // What a browser holding a pre-counts payload rehydrates into. `persist`
    // merges the stored object over the initial state, so the absent field
    // keeps its `{}` — an agent with a timestamp and no count reads as
    // "opened once, long ago" instead of throwing on a property of undefined.
    expect(useInteractionStore.getState().counts).toEqual({});
  });
});

describe('mergeUsage', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it('adds history the store has never seen', () => {
    useInteractionStore
      .getState()
      .mergeUsage([{ key: 'agent:/repos/a', lastUsedAt: 5_000, useCount: 9 }]);

    expect(useInteractionStore.getState().opened['agent:/repos/a']).toBe(
      new Date(5_000).toISOString()
    );
    expect(useInteractionStore.getState().counts['agent:/repos/a']).toBe(9);
  });

  it('takes the larger of each field, so running it twice changes nothing', () => {
    const merge = () =>
      useInteractionStore
        .getState()
        .mergeUsage([{ key: 'agent:/repos/a', lastUsedAt: 5_000, useCount: 9 }]);
    merge();
    const afterFirst = useInteractionStore.getState();
    merge();

    // The claim, and its control: the second merge is a no-op on the VALUES,
    // and a sum would have made this 18.
    expect(useInteractionStore.getState().counts['agent:/repos/a']).toBe(9);
    expect(useInteractionStore.getState().opened).toEqual(afterFirst.opened);
  });

  it('never moves a record backwards', () => {
    useInteractionStore.getState().recordOpened('agent', '/repos/a', 9_000);
    useInteractionStore
      .getState()
      .mergeUsage([{ key: 'agent:/repos/a', lastUsedAt: 5_000, useCount: 0 }]);

    expect(Date.parse(useInteractionStore.getState().opened['agent:/repos/a'] ?? '')).toBe(9_000);
    expect(useInteractionStore.getState().counts['agent:/repos/a']).toBe(1);
  });

  it('is a no-op for an empty list, down to the state identity', () => {
    const before = useInteractionStore.getState().opened;
    useInteractionStore.getState().mergeUsage([]);
    expect(useInteractionStore.getState().opened).toBe(before);
  });
});

describe('growth is bounded', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it(`keeps at most ${MAX_INTERACTION_RECORDS} records`, () => {
    const { recordOpened } = useInteractionStore.getState();
    for (let index = 0; index < MAX_INTERACTION_RECORDS + 50; index += 1) {
      recordOpened('session', `s${index}`, 1_000 + index);
    }
    expect(Object.keys(useInteractionStore.getState().opened)).toHaveLength(
      MAX_INTERACTION_RECORDS
    );
  });

  it('evicts the oldest, never the most recent', () => {
    const { recordOpened } = useInteractionStore.getState();
    for (let index = 0; index < MAX_INTERACTION_RECORDS + 10; index += 1) {
      recordOpened('session', `s${index}`, 1_000 + index);
    }
    const kept = useInteractionStore.getState().opened;
    // The ten oldest are gone; the newest survives.
    expect(kept['session:s0']).toBeUndefined();
    expect(kept['session:s9']).toBeUndefined();
    expect(kept['session:s10']).toBeDefined();
    expect(kept[`session:s${MAX_INTERACTION_RECORDS + 9}`]).toBeDefined();
  });

  it('evicts a record from BOTH maps, never leaving a count behind', () => {
    // A count whose timestamp was evicted would rank a row the store no longer
    // claims to know — and it could never be evicted again, because eviction
    // reads timestamps. The two maps are one record split in two.
    const { recordOpened } = useInteractionStore.getState();
    for (let index = 0; index < MAX_INTERACTION_RECORDS + 10; index += 1) {
      recordOpened('session', `s${index}`, 1_000 + index);
    }
    const { opened, counts } = useInteractionStore.getState();
    expect(Object.keys(counts).sort()).toEqual(Object.keys(opened).sort());
    expect(counts['session:s0']).toBeUndefined();
  });
});

describe('a full or unavailable localStorage', () => {
  beforeEach(() => {
    useInteractionStore.getState().reset();
  });

  it('does not take the click down when the quota is exhausted', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    try {
      expect(() => useInteractionStore.getState().recordOpened('room', 'r9', 5_000)).not.toThrow();
      // And the record is still correct in memory for this session.
      expect(Date.parse(useInteractionStore.getState().opened['room:r9'] ?? '')).toBe(5_000);
    } finally {
      setItem.mockRestore();
    }
  });

  it('does not take the read down when storage is unavailable', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      expect(() => useInteractionStore.persist.rehydrate()).not.toThrow();
    } finally {
      getItem.mockRestore();
    }
  });
});
