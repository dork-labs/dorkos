/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readTerminalTabs, writeTerminalTabs } from '../lib/terminal-id-store';

const CWD = '/repo';

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('terminal-id-store', () => {
  it('round-trips the ordered id list and active index', () => {
    writeTerminalTabs('sess', CWD, { ids: ['a', 'b', 'c'], activeIndex: 2 });
    expect(readTerminalTabs('sess', CWD)).toEqual({ ids: ['a', 'b', 'c'], activeIndex: 2 });
  });

  it('preserves list order (not sorted or de-duped by the store)', () => {
    writeTerminalTabs(null, CWD, { ids: ['z', 'a', 'm'], activeIndex: 0 });
    expect(readTerminalTabs(null, CWD).ids).toEqual(['z', 'a', 'm']);
  });

  it('scopes tabs per (session, cwd)', () => {
    writeTerminalTabs('s1', CWD, { ids: ['a'], activeIndex: 0 });
    writeTerminalTabs('s2', CWD, { ids: ['b', 'c'], activeIndex: 1 });
    expect(readTerminalTabs('s1', CWD).ids).toEqual(['a']);
    expect(readTerminalTabs('s2', CWD).ids).toEqual(['b', 'c']);
    // A null session id is a distinct, stable key from any string id.
    expect(readTerminalTabs(null, CWD).ids).toEqual([]);
  });

  it('clamps an out-of-range active index into the list on read', () => {
    writeTerminalTabs(null, CWD, { ids: ['a', 'b'], activeIndex: 9 });
    expect(readTerminalTabs(null, CWD).activeIndex).toBe(1);
  });

  it('returns the empty state when the active index is negative', () => {
    writeTerminalTabs(null, CWD, { ids: ['a', 'b'], activeIndex: -1 });
    expect(readTerminalTabs(null, CWD).activeIndex).toBe(0);
  });

  it('models exit-clears-one / prune-dead as a rewrite that drops an id and keeps the rest', () => {
    // The panel removes a single dead/exited id by rewriting the whole list.
    writeTerminalTabs(null, CWD, { ids: ['a', 'b', 'c'], activeIndex: 2 });
    const { ids } = readTerminalTabs(null, CWD);
    const pruned = ids.filter((id) => id !== 'b');
    writeTerminalTabs(null, CWD, { ids: pruned, activeIndex: pruned.length - 1 });
    expect(readTerminalTabs(null, CWD)).toEqual({ ids: ['a', 'c'], activeIndex: 1 });
  });

  it('returns the empty state when nothing is stored', () => {
    expect(readTerminalTabs('sess', CWD)).toEqual({ ids: [], activeIndex: 0 });
  });

  it('tolerates a corrupt stored value, degrading to the empty state', () => {
    sessionStorage.setItem(`dork.terminal.tabs:sess:${CWD}`, '{not json');
    expect(readTerminalTabs('sess', CWD)).toEqual({ ids: [], activeIndex: 0 });
  });

  it('filters out non-string ids from a malformed stored list', () => {
    sessionStorage.setItem(
      `dork.terminal.tabs::${CWD}`,
      JSON.stringify({ ids: ['a', 42, null, 'b'], activeIndex: 1 })
    );
    expect(readTerminalTabs(null, CWD).ids).toEqual(['a', 'b']);
  });

  it('tolerates sessionStorage throwing on read and on write', () => {
    const getSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readTerminalTabs(null, CWD)).toEqual({ ids: [], activeIndex: 0 });
    getSpy.mockRestore();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    // Must not throw — failure-tolerant, re-attach just won't be available.
    expect(() => writeTerminalTabs(null, CWD, { ids: ['a'], activeIndex: 0 })).not.toThrow();
  });
});
