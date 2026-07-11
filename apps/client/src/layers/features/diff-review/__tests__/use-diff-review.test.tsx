/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const readDiffBaseline = vi.fn();
const writeFile = vi.fn();
const advanceDiffBaseline = vi.fn();

vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({ readDiffBaseline, writeFile, advanceDiffBaseline }),
}));

import { useDiffReview } from '../model/use-diff-review';

const ARGS = { cwd: '/work', sourcePath: 'src/App.tsx', sessionId: 'sess-1' };
const BASELINE = {
  baseline: 'const a = 1;\n',
  baselineHash: 'bhash',
  current: 'const a = 2;\n',
  currentHash: 'chash',
  capturedFrom: 'pre-tool' as const,
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDiffReview', () => {
  beforeEach(() => {
    readDiffBaseline.mockReset().mockResolvedValue(BASELINE);
    writeFile.mockReset().mockResolvedValue({ ok: true, hash: 'newhash' });
    advanceDiffBaseline.mockReset().mockResolvedValue(undefined);
  });

  it('loads the baseline for the file', async () => {
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(readDiffBaseline).toHaveBeenCalledWith('/work', 'src/App.tsx', 'sess-1', 'session');
    expect(result.current.data?.current).toBe('const a = 2;\n');
  });

  it('rejects a hunk by writing the reverted content with the current disk hash', async () => {
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.rejectHunk('const a = 1;\n');
    });

    expect(writeFile).toHaveBeenCalledWith('/work', 'src/App.tsx', 'const a = 1;\n', {
      expectedHash: 'chash',
    });
    expect(result.current.conflict).toBe(false);
  });

  it('surfaces a conflict on a 409 and never blind-clobbers', async () => {
    writeFile.mockResolvedValue({
      ok: false,
      conflict: { currentHash: 'other', currentContent: 'changed\n' },
    });
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.rejectHunk('const a = 1;\n');
    });

    // Exactly one conditional write — the conflict is not forced through.
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith('/work', 'src/App.tsx', 'const a = 1;\n', {
      expectedHash: 'chash',
    });
    await waitFor(() => expect(result.current.conflict).toBe(true));
  });

  it('reject-all writes the full baseline back to disk', async () => {
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.rejectAll();
    });

    expect(writeFile).toHaveBeenCalledWith('/work', 'src/App.tsx', 'const a = 1;\n', {
      expectedHash: 'chash',
    });
  });

  it('mark-reviewed advances the baseline for the session base', async () => {
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.markReviewed();
    });

    expect(advanceDiffBaseline).toHaveBeenCalledWith('/work', 'src/App.tsx', 'sess-1');
  });

  it('surfaces a visible failure when a reject write throws (never a silent no-op)', async () => {
    writeFile.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.rejectHunk('const a = 1;\n');
    });

    expect(outcome).toBe('error');
    await waitFor(() => expect(result.current.writeFailed).toBe(true));
    // The doc resyncs with disk after the failed write.
    expect(readDiffBaseline.mock.calls.length).toBeGreaterThan(1);
  });

  it('surfaces a visible failure when reject-all throws', async () => {
    writeFile.mockRejectedValue(new Error('EACCES'));
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.rejectAll();
    });

    expect(outcome).toBe('error');
    await waitFor(() => expect(result.current.writeFailed).toBe(true));
  });

  it('surfaces a visible failure when mark-reviewed cannot advance the baseline', async () => {
    advanceDiffBaseline.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.markReviewed();
    });

    await waitFor(() => expect(result.current.writeFailed).toBe(true));
  });

  it('a later successful write clears the failure notice', async () => {
    writeFile.mockRejectedValueOnce(new Error('flaky'));
    writeFile.mockResolvedValue({ ok: true, hash: 'newhash' });
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    await act(async () => {
      await result.current.rejectHunk('const a = 1;\n');
    });
    await waitFor(() => expect(result.current.writeFailed).toBe(true));

    await act(async () => {
      await result.current.rejectHunk('const a = 1;\n');
    });
    await waitFor(() => expect(result.current.writeFailed).toBe(false));
  });

  it('does not advance the baseline in git-HEAD compare mode', async () => {
    const { result } = renderHook(() => useDiffReview(ARGS), { wrapper });
    await waitFor(() => expect(result.current.data).toBeDefined());

    act(() => result.current.setMode('head'));
    await waitFor(() =>
      expect(readDiffBaseline).toHaveBeenLastCalledWith('/work', 'src/App.tsx', 'sess-1', 'head')
    );

    await act(async () => {
      await result.current.markReviewed();
    });
    expect(advanceDiffBaseline).not.toHaveBeenCalled();
  });
});
