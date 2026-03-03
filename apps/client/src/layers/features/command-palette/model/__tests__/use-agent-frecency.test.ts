/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentFrecency } from '../use-agent-frecency';

describe('useAgentFrecency', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('starts with empty entries', () => {
    const { result } = renderHook(() => useAgentFrecency());
    expect(result.current.entries).toEqual([]);
  });

  it('recordUsage creates a new entry', () => {
    const { result } = renderHook(() => useAgentFrecency());
    act(() => result.current.recordUsage('agent-1'));
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].agentId).toBe('agent-1');
    expect(result.current.entries[0].useCount).toBe(1);
  });

  it('recordUsage increments count for existing entry', () => {
    const { result } = renderHook(() => useAgentFrecency());
    act(() => result.current.recordUsage('agent-1'));
    act(() => result.current.recordUsage('agent-1'));
    expect(result.current.entries[0].useCount).toBe(2);
  });

  it('recordUsage updates lastUsed timestamp', () => {
    const { result } = renderHook(() => useAgentFrecency());
    const before = new Date().toISOString();
    act(() => result.current.recordUsage('agent-1'));
    const after = new Date().toISOString();
    const lastUsed = result.current.entries[0].lastUsed;
    expect(lastUsed >= before).toBe(true);
    expect(lastUsed <= after).toBe(true);
  });

  it('getSortedAgentIds returns agents in frecency order', () => {
    const { result } = renderHook(() => useAgentFrecency());
    // Use agent-2 more frequently
    act(() => result.current.recordUsage('agent-1'));
    act(() => result.current.recordUsage('agent-2'));
    act(() => result.current.recordUsage('agent-2'));
    act(() => result.current.recordUsage('agent-2'));
    const sorted = result.current.getSortedAgentIds(['agent-1', 'agent-2', 'agent-3']);
    expect(sorted[0]).toBe('agent-2');
    expect(sorted[1]).toBe('agent-1');
    // agent-3 (untracked) goes last, alphabetical
    expect(sorted[2]).toBe('agent-3');
  });

  it('getSortedAgentIds places untracked agents alphabetically at the end', () => {
    const { result } = renderHook(() => useAgentFrecency());
    act(() => result.current.recordUsage('agent-b'));
    const sorted = result.current.getSortedAgentIds(['agent-z', 'agent-a', 'agent-b']);
    expect(sorted[0]).toBe('agent-b'); // tracked, highest score
    // untracked agents sorted alphabetically
    expect(sorted[1]).toBe('agent-a');
    expect(sorted[2]).toBe('agent-z');
  });

  it('prunes entries older than 30 days', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem(
      'dorkos-agent-frecency',
      JSON.stringify([{ agentId: 'old-agent', lastUsed: oldDate, useCount: 5 }]),
    );
    const { result } = renderHook(() => useAgentFrecency());
    // Old entry should be pruned on next write
    act(() => result.current.recordUsage('new-agent'));
    const ids = result.current.entries.map((e) => e.agentId);
    expect(ids).not.toContain('old-agent');
    expect(ids).toContain('new-agent');
  });

  it('gracefully handles corrupted localStorage', () => {
    localStorage.setItem('dorkos-agent-frecency', 'not-json');
    const { result } = renderHook(() => useAgentFrecency());
    expect(result.current.entries).toEqual([]);
  });

  it('gracefully handles non-array JSON in localStorage', () => {
    localStorage.setItem('dorkos-agent-frecency', JSON.stringify({ foo: 'bar' }));
    const { result } = renderHook(() => useAgentFrecency());
    expect(result.current.entries).toEqual([]);
  });

  it('limits to 50 entries', () => {
    const { result } = renderHook(() => useAgentFrecency());
    for (let i = 0; i < 55; i++) {
      act(() => result.current.recordUsage(`agent-${i}`));
    }
    const raw = localStorage.getItem('dorkos-agent-frecency');
    const parsed = JSON.parse(raw!);
    expect(parsed.length).toBeLessThanOrEqual(50);
  });

  it('persists entries to localStorage', () => {
    const { result } = renderHook(() => useAgentFrecency());
    act(() => result.current.recordUsage('agent-persist'));
    const raw = localStorage.getItem('dorkos-agent-frecency');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed[0].agentId).toBe('agent-persist');
  });

  it('getSortedAgentIds returns empty array for empty input', () => {
    const { result } = renderHook(() => useAgentFrecency());
    act(() => result.current.recordUsage('agent-1'));
    expect(result.current.getSortedAgentIds([])).toEqual([]);
  });

  it('multiple hook instances share state via external store', () => {
    const hook1 = renderHook(() => useAgentFrecency());
    const hook2 = renderHook(() => useAgentFrecency());

    act(() => hook1.result.current.recordUsage('shared-agent'));

    // Both hook instances should see the new entry via the shared external store
    expect(hook2.result.current.entries.some((e) => e.agentId === 'shared-agent')).toBe(true);
  });
});
