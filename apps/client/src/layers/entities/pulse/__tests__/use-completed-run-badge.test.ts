/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCompletedRunBadge } from '../model/use-completed-run-badge';

// Mock useRuns
let mockRuns: Array<{ id: string; status: string }> | undefined;
vi.mock('../model/use-runs', () => ({
  useRuns: () => ({ data: mockRuns }),
}));

describe('useCompletedRunBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockRuns = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns zero unviewed count initially', () => {
    mockRuns = [];
    const { result } = renderHook(() => useCompletedRunBadge());
    expect(result.current.unviewedCount).toBe(0);
  });

  it('detects transition from running to completed', () => {
    // Start with a running run
    mockRuns = [{ id: 'run-1', status: 'running' }];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    expect(result.current.unviewedCount).toBe(0);

    // Transition to completed
    mockRuns = [{ id: 'run-1', status: 'completed' }];
    rerender();

    expect(result.current.unviewedCount).toBe(1);
  });

  it('detects transition from running to failed', () => {
    mockRuns = [{ id: 'run-1', status: 'running' }];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    mockRuns = [{ id: 'run-1', status: 'failed' }];
    rerender();

    expect(result.current.unviewedCount).toBe(1);
  });

  it('does not count runs that were already completed on first render', () => {
    mockRuns = [{ id: 'run-1', status: 'completed' }];
    const { result } = renderHook(() => useCompletedRunBadge());

    expect(result.current.unviewedCount).toBe(0);
  });

  it('clears badge and writes to localStorage', () => {
    mockRuns = [{ id: 'run-1', status: 'running' }];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    mockRuns = [{ id: 'run-1', status: 'completed' }];
    rerender();
    expect(result.current.unviewedCount).toBe(1);

    act(() => {
      result.current.clearBadge();
    });

    expect(result.current.unviewedCount).toBe(0);
    expect(localStorage.getItem('dorkos-pulse-last-viewed')).toBeTruthy();
  });

  it('accumulates multiple completions', () => {
    mockRuns = [
      { id: 'run-1', status: 'running' },
      { id: 'run-2', status: 'running' },
    ];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    mockRuns = [
      { id: 'run-1', status: 'completed' },
      { id: 'run-2', status: 'completed' },
    ];
    rerender();

    expect(result.current.unviewedCount).toBe(2);
  });

  it('returns zero when disabled', () => {
    // When disabled, useRuns is called with enabled=false — mock returns undefined
    const origMock = vi.fn(() => ({ data: undefined }));
    vi.doMock('../model/use-runs', () => ({ useRuns: origMock }));

    // Since vi.mock is hoisted, we test the behavior with undefined data
    mockRuns = undefined;
    const { result } = renderHook(() => useCompletedRunBadge(false));

    expect(result.current.unviewedCount).toBe(0);
  });
});
