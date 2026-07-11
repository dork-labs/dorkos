/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const revertDiffBaseline = vi.fn();
const advanceDiffBaseline = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({ revertDiffBaseline, advanceDiffBaseline }),
}));

import { useImageDiffReview } from '../model/use-image-diff-review';

const ARGS = { cwd: '/work', sourcePath: 'assets/logo.png', sessionId: 'sess-1' };

describe('useImageDiffReview', () => {
  beforeEach(() => {
    revertDiffBaseline.mockReset().mockResolvedValue(undefined);
    advanceDiffBaseline.mockReset().mockResolvedValue(undefined);
  });

  it('restore reverts the baseline server-side and reloads the layers', async () => {
    const { result } = renderHook(() => useImageDiffReview(ARGS));
    const before = result.current.version;

    await act(async () => {
      await result.current.restore();
    });

    expect(revertDiffBaseline).toHaveBeenCalledWith('/work', 'assets/logo.png', 'sess-1');
    // A successful restore bumps the cache-busting version so the <img>s refetch.
    expect(result.current.version).toBe(before + 1);
    expect(result.current.writeFailed).toBe(false);
  });

  it('a failed restore is never silent (writeFailed raised, layers not bumped)', async () => {
    revertDiffBaseline.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useImageDiffReview(ARGS));
    const before = result.current.version;

    await act(async () => {
      await result.current.restore();
    });

    expect(result.current.writeFailed).toBe(true);
    expect(result.current.version).toBe(before);
  });

  it('markReviewed advances the baseline and refreshes', async () => {
    const { result } = renderHook(() => useImageDiffReview(ARGS));

    await act(async () => {
      await result.current.markReviewed();
    });

    expect(advanceDiffBaseline).toHaveBeenCalledWith('/work', 'assets/logo.png', 'sess-1');
  });

  it('a failed markReviewed is never silent', async () => {
    advanceDiffBaseline.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useImageDiffReview(ARGS));

    await act(async () => {
      await result.current.markReviewed();
    });

    expect(result.current.writeFailed).toBe(true);
  });

  it('refresh clears the failure notice and reloads the layers', async () => {
    revertDiffBaseline.mockRejectedValue(new Error('flaky'));
    const { result } = renderHook(() => useImageDiffReview(ARGS));

    await act(async () => {
      await result.current.restore();
    });
    expect(result.current.writeFailed).toBe(true);

    act(() => result.current.refresh());
    expect(result.current.writeFailed).toBe(false);
  });

  it('does nothing without a session (no writes attempted)', async () => {
    const { result } = renderHook(() => useImageDiffReview({ ...ARGS, sessionId: null }));

    await act(async () => {
      await result.current.restore();
      await result.current.markReviewed();
    });

    expect(revertDiffBaseline).not.toHaveBeenCalled();
    expect(advanceDiffBaseline).not.toHaveBeenCalled();
  });
});
