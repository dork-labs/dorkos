/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFavicon } from '../use-favicon';

vi.mock('../favicon-utils', () => ({
  hashToHslColor: vi.fn(() => 'hsl(180, 70%, 55%)'),
  generateCircleFavicon: vi.fn(() => 'data:image/png;base64,solid'),
  generatePulseFrames: vi.fn(() =>
    Promise.resolve(['data:frame0', 'data:frame1', 'data:frame2', 'data:frame3']),
  ),
  setFavicon: vi.fn(),
}));

import { generateCircleFavicon, setFavicon } from '../favicon-utils';

describe('useFavicon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates and sets favicon when cwd is provided', () => {
    renderHook(() => useFavicon({ cwd: '/test', isStreaming: false }));
    expect(generateCircleFavicon).toHaveBeenCalledWith('hsl(180, 70%, 55%)');
    expect(setFavicon).toHaveBeenCalledWith('data:image/png;base64,solid');
  });

  it('does nothing when cwd is null', () => {
    renderHook(() => useFavicon({ cwd: null, isStreaming: false }));
    expect(generateCircleFavicon).not.toHaveBeenCalled();
  });

  it('regenerates favicon when cwd changes', () => {
    const { rerender } = renderHook(
      ({ cwd }) => useFavicon({ cwd, isStreaming: false }),
      { initialProps: { cwd: '/project-a' as string | null } },
    );
    const initialCalls = vi.mocked(setFavicon).mock.calls.length;

    rerender({ cwd: '/project-b' });
    expect(vi.mocked(setFavicon).mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('cycles through pulse frames when streaming', async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ isStreaming }) => useFavicon({ cwd: '/test', isStreaming }),
      { initialProps: { isStreaming: false } },
    );

    // Let the pulse frames promise resolve
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    vi.mocked(setFavicon).mockClear();

    // Start streaming — should cycle through frames
    rerender({ isStreaming: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400); // 4 frames at 100ms each
    });

    const calls = vi.mocked(setFavicon).mock.calls;
    // Filter to only frame data URLs (skip any solid restores from effect cleanup)
    const frameCalls = calls.filter(([url]) => url.startsWith('data:frame'));
    expect(frameCalls.length).toBeGreaterThanOrEqual(4);
    expect(frameCalls[0][0]).toBe('data:frame0');
    expect(frameCalls[1][0]).toBe('data:frame1');
    expect(frameCalls[2][0]).toBe('data:frame2');
    expect(frameCalls[3][0]).toBe('data:frame3');
    vi.useRealTimers();
  });

  it('restores solid favicon when streaming stops', async () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(
      ({ isStreaming }) => useFavicon({ cwd: '/test', isStreaming }),
      { initialProps: { isStreaming: true } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    vi.mocked(setFavicon).mockClear();
    rerender({ isStreaming: false });

    // Should restore solid favicon
    expect(vi.mocked(setFavicon)).toHaveBeenCalledWith('data:image/png;base64,solid');
    vi.useRealTimers();
  });
});
