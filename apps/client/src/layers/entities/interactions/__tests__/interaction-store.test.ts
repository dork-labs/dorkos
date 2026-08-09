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
