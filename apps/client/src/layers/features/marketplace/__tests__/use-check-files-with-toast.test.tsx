/**
 * @vitest-environment jsdom
 *
 * `useCheckFilesWithToast` (DOR-2320): one toast, loading then the server's own
 * sentence; a package whose files could not be checked is a warning, a failed
 * request an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CheckFilesResult } from '@dorkos/shared/marketplace-schemas';
import { useCheckPackageFiles } from '@/layers/entities/marketplace';

import { useCheckFilesWithToast } from '../model/use-check-files-with-toast';

vi.mock('@/layers/entities/marketplace', () => ({
  useCheckPackageFiles: vi.fn(),
}));

const mockLoading = vi.fn(() => 'toast-1');
const mockSuccess = vi.fn();
const mockWarning = vi.fn();
const mockError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    loading: (...args: unknown[]) => mockLoading(...(args as Parameters<typeof mockLoading>)),
    success: (...args: unknown[]) => mockSuccess(...(args as Parameters<typeof mockSuccess>)),
    warning: (...args: unknown[]) => mockWarning(...(args as Parameters<typeof mockWarning>)),
    error: (...args: unknown[]) => mockError(...(args as Parameters<typeof mockError>)),
  },
}));

type Callbacks = { onSuccess?: (r: CheckFilesResult) => void; onError?: (e: Error) => void };

/** Make the base mutation call back with `settle` as soon as it is called. */
function answer(settle: (cb: Callbacks) => void) {
  const mutate = vi.fn((_args: unknown, cb: Callbacks) => settle(cb));
  vi.mocked(useCheckPackageFiles).mockReturnValue({ mutate } as unknown as ReturnType<
    typeof useCheckPackageFiles
  >);
  return mutate;
}

beforeEach(() => vi.clearAllMocks());

describe('useCheckFilesWithToast', () => {
  // Purpose: a checked package gets a success toast with the server's
  // sentence, replacing the loading toast that named the package and place.
  it('replaces the loading toast with the success sentence', () => {
    const mutate = answer((cb) => cb.onSuccess?.({ outcome: 'rebuilt', message: 'Done.' }));
    const { result } = renderHook(() => useCheckFilesWithToast());

    act(() =>
      result.current.mutate({ name: 'flow', options: { installRoot: '/x' }, where: 'Alpha' })
    );

    expect(mockLoading).toHaveBeenCalledWith('Checking the files of Flow on Alpha…');
    expect(mutate.mock.calls[0][0]).toEqual({ name: 'flow', options: { installRoot: '/x' } });
    expect(mockSuccess).toHaveBeenCalledWith('Done.', { id: 'toast-1' });
  });

  // Purpose: "could not check" is not a failure of DorkOS: it is a warning
  // carrying what to do, never a success.
  it.each(['mismatch', 'fetch-failed', 'no-source'] as const)('warns on %s', (outcome) => {
    answer((cb) => cb.onSuccess?.({ outcome, message: 'Why not.' }));
    const { result } = renderHook(() => useCheckFilesWithToast());

    act(() => result.current.mutate({ name: 'flow' }));

    expect(mockWarning).toHaveBeenCalledWith('Why not.', { id: 'toast-1' });
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  // Purpose: a failed request is an error that names the package.
  it('reports a failed request as an error', () => {
    answer((cb) => cb.onError?.(new Error('server down')));
    const { result } = renderHook(() => useCheckFilesWithToast());

    act(() => result.current.mutate({ name: 'flow' }));

    expect(mockError).toHaveBeenCalledWith("Couldn't check the files of Flow: server down", {
      id: 'toast-1',
    });
  });
});
