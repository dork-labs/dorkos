import { describe, it, expect, beforeEach } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { useHistoryWindowStore, EMPTY_HISTORY_WINDOW } from '../history-window-store';

/** What sits before a long conversation's opening window (DOR-2889). */

const msg = (id: string): HistoryMessage => ({ id, role: 'user', content: id });
const state = (sessionId: string) =>
  useHistoryWindowStore.getState().sessions[sessionId] ?? EMPTY_HISTORY_WINDOW;

beforeEach(() => {
  useHistoryWindowStore.setState({ sessions: {}, seeks: {} });
});

describe('useHistoryWindowStore', () => {
  it('records where a snapshot window starts and how much is before it', () => {
    useHistoryWindowStore.getState().noteSnapshot('s1', 'm200', 200);
    expect(state('s1')).toEqual({
      windowStartId: 'm200',
      earlier: [],
      remaining: 200,
      generation: 1,
    });
  });

  it('puts each older page in front, oldest first, and skips messages it already has', () => {
    const store = useHistoryWindowStore.getState();
    store.noteSnapshot('s1', 'm4', 4);
    store.prependPage('s1', 1, [msg('m2'), msg('m3')], 2);
    store.prependPage('s1', 1, [msg('m0'), msg('m1'), msg('m2')], 0);

    expect(state('s1').earlier.map((m) => m.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
    expect(state('s1').remaining).toBe(0);
  });

  it('drops pages read against an older window when a new snapshot lands', () => {
    const store = useHistoryWindowStore.getState();
    store.noteSnapshot('s1', 'm4', 4);
    store.prependPage('s1', 1, [msg('m3')], 3);
    store.noteSnapshot('s1', 'm9', 9);

    expect(state('s1')).toEqual({ windowStartId: 'm9', earlier: [], remaining: 9, generation: 2 });
  });

  it('keeps the pages already read when a reconnect lands on the same window', () => {
    const store = useHistoryWindowStore.getState();
    store.noteSnapshot('s1', 'm300', 300);
    store.prependPage('s1', 1, [msg('m200'), msg('m299')], 200);
    store.noteSnapshot('s1', 'm300', 300);

    expect(state('s1').earlier.map((m) => m.id)).toEqual(['m200', 'm299']);
    expect(state('s1').remaining).toBe(200);
    expect(state('s1').generation).toBe(1);
  });

  it('refuses a page asked for before the pages started over', () => {
    // The page left while the window started at m300; a snapshot moved it to
    // m400 and back. The late page no longer joins up with what is loaded.
    const store = useHistoryWindowStore.getState();
    store.noteSnapshot('s1', 'm300', 300);
    store.noteSnapshot('s1', 'm400', 400);
    store.noteSnapshot('s1', 'm300', 300);
    store.prependPage('s1', 1, [msg('m200')], 200);

    expect(state('s1').earlier).toEqual([]);
    expect(state('s1').remaining).toBe(300);
  });

  it('refuses a page before any snapshot', () => {
    useHistoryWindowStore.getState().prependPage('s1', 0, [msg('m1')], 0);
    expect(useHistoryWindowStore.getState().sessions).toEqual({});
  });

  it('keeps sessions apart', () => {
    const store = useHistoryWindowStore.getState();
    store.noteSnapshot('s1', 'a', 1);
    store.noteSnapshot('s2', 'b', 2);
    store.prependPage('s1', 1, [msg('x')], 0);

    expect(state('s2').earlier).toEqual([]);
  });

  it('holds a seek per session until it ends', () => {
    const store = useHistoryWindowStore.getState();
    store.seek('s1', 'm3');
    expect(useHistoryWindowStore.getState().seeks).toEqual({ s1: 'm3' });
    store.endSeek('s1');
    expect(useHistoryWindowStore.getState().seeks).toEqual({});
  });
});
