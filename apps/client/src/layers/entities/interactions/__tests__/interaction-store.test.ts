import { beforeEach, describe, expect, it } from 'vitest';
import { interactionKey, useInteractionStore } from '../index';

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

  it('records when a thing was opened', () => {
    useInteractionStore.getState().recordOpened('session', 's1', 1_700_000_000_000);
    expect(useInteractionStore.getState().records['session:s1']).toEqual({
      userLastOpenedAt: 1_700_000_000_000,
    });
  });

  it('overwrites an earlier open with the later one', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('room', 'r1', 1_000);
    recordOpened('room', 'r1', 2_000);
    expect(useInteractionStore.getState().records['room:r1']?.userLastOpenedAt).toBe(2_000);
  });

  it('keeps kinds apart for the same id', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 'x', 1_000);
    recordOpened('agent', 'x', 2_000);
    expect(useInteractionStore.getState().records).toEqual({
      'session:x': { userLastOpenedAt: 1_000 },
      'agent:x': { userLastOpenedAt: 2_000 },
    });
  });

  it('defaults to the current instant when no time is given', () => {
    const before = Date.now();
    useInteractionStore.getState().recordOpened('session', 's2');
    const recorded = useInteractionStore.getState().records['session:s2']?.userLastOpenedAt ?? 0;
    expect(recorded).toBeGreaterThanOrEqual(before);
  });

  it('does not mutate the previous record map', () => {
    const { recordOpened } = useInteractionStore.getState();
    recordOpened('session', 'a', 1);
    const first = useInteractionStore.getState().records;
    recordOpened('session', 'b', 2);
    expect(useInteractionStore.getState().records).not.toBe(first);
    expect(first).toEqual({ 'session:a': { userLastOpenedAt: 1 } });
  });

  it('survives a rehydrate — the records are written to storage', () => {
    useInteractionStore.getState().recordOpened('session', 'persisted', 42);
    const raw = window.localStorage.getItem('dorkos:interactions-v1');
    expect(raw).toContain('persisted');
  });
});
