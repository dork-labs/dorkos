/**
 * @vitest-environment jsdom
 *
 * `usePrepareWithToast` (DOR-2320): one toast, loading then the server's own
 * sentence; a package that could not be prepared is a warning, a failed
 * request an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PrepareResult } from '@dorkos/shared/marketplace-schemas';
import { usePreparePackage } from '@/layers/entities/marketplace';

import { usePrepareWithToast } from '../model/use-prepare-with-toast';

vi.mock('@/layers/entities/marketplace', () => ({
  usePreparePackage: vi.fn(),
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

type Callbacks = { onSuccess?: (r: PrepareResult) => void; onError?: (e: Error) => void };

/** Make the base mutation call back with `settle` as soon as it is called. */
function answer(settle: (cb: Callbacks) => void) {
  const mutate = vi.fn((_args: unknown, cb: Callbacks) => settle(cb));
  vi.mocked(usePreparePackage).mockReturnValue({ mutate } as unknown as ReturnType<
    typeof usePreparePackage
  >);
  return mutate;
}

beforeEach(() => vi.clearAllMocks());

describe('usePrepareWithToast', () => {
  // Purpose: a prepared package gets a success toast with the server's
  // sentence, replacing the loading toast that named the package and place.
  it('replaces the loading toast with the success sentence', () => {
    const mutate = answer((cb) => cb.onSuccess?.({ outcome: 'rebuilt', message: 'Done.' }));
    const { result } = renderHook(() => usePrepareWithToast());

    act(() =>
      result.current.mutate({ name: 'flow', options: { installRoot: '/x' }, where: 'Alpha' })
    );

    expect(mockLoading).toHaveBeenCalledWith('Preparing Flow on Alpha…');
    expect(mutate.mock.calls[0][0]).toEqual({ name: 'flow', options: { installRoot: '/x' } });
    expect(mockSuccess).toHaveBeenCalledWith('Done.', { id: 'toast-1' });
  });

  // Purpose: "could not prepare" is not a failure of DorkOS: it is a warning
  // carrying what to do, never a success.
  it.each(['mismatch', 'fetch-failed', 'no-source'] as const)('warns on %s', (outcome) => {
    answer((cb) => cb.onSuccess?.({ outcome, message: 'Why not.' }));
    const { result } = renderHook(() => usePrepareWithToast());

    act(() => result.current.mutate({ name: 'flow' }));

    expect(mockWarning).toHaveBeenCalledWith('Why not.', { id: 'toast-1' });
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  // Purpose: a failed request is an error that names the package.
  it('reports a failed request as an error', () => {
    answer((cb) => cb.onError?.(new Error('server down')));
    const { result } = renderHook(() => usePrepareWithToast());

    act(() => result.current.mutate({ name: 'flow' }));

    expect(mockError).toHaveBeenCalledWith("Couldn't prepare Flow: server down", { id: 'toast-1' });
  });
});
