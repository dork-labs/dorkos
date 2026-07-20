/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useUninstallWithToast`. Mocks only `useUninstallPackage`
 * and `sonner`, so the toast-id plumbing and per-call callback wiring are
 * covered for real. Mirrors `use-install-with-toast.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUninstallPackage } from '@/layers/entities/marketplace';

import { useUninstallWithToast } from '../model/use-uninstall-with-toast';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useUninstallPackage: vi.fn(),
}));

const mockLoading = vi.fn(() => 'toast-id-abc');
const mockSuccess = vi.fn();
const mockError = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    loading: (...args: unknown[]) => mockLoading(...(args as Parameters<typeof mockLoading>)),
    success: (...args: unknown[]) => mockSuccess(...(args as Parameters<typeof mockSuccess>)),
    error: (...args: unknown[]) => mockError(...(args as Parameters<typeof mockError>)),
  },
}));

// ---------------------------------------------------------------------------
// Mutation handle factory
// ---------------------------------------------------------------------------

interface UninstallMutationFakes {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function makeUninstallMock(): UninstallMutationFakes {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn() };
}

function setUninstallPackageMock(fakes: UninstallMutationFakes) {
  vi.mocked(useUninstallPackage).mockReturnValue({
    mutate: fakes.mutate,
    mutateAsync: fakes.mutateAsync,
    reset: fakes.reset,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    variables: undefined,
  } as unknown as ReturnType<typeof useUninstallPackage>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useUninstallWithToast', () => {
  let fakes: UninstallMutationFakes;

  beforeEach(() => {
    vi.clearAllMocks();
    fakes = makeUninstallMock();
    setUninstallPackageMock(fakes);
  });

  describe('mutate (fire-and-forget)', () => {
    it('fires a loading toast with the package name and calls the underlying mutate', () => {
      const { result } = renderHook(() => useUninstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      expect(mockLoading).toHaveBeenCalledWith('Uninstalling Code Reviewer…');
      expect(fakes.mutate).toHaveBeenCalledTimes(1);
      expect(fakes.mutate.mock.calls[0][0]).toEqual({ name: '@dorkos/code-reviewer' });
    });

    it('replaces the loading toast with a success toast using the same toast id', () => {
      const { result } = renderHook(() => useUninstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onSuccess: (result: unknown) => void;
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onSuccess({ ok: true });
      });

      expect(mockSuccess).toHaveBeenCalledWith('Uninstalled Code Reviewer', {
        id: 'toast-id-abc',
      });
      expect(mockError).not.toHaveBeenCalled();
    });

    it('replaces the loading toast with an error toast on failure', () => {
      const { result } = renderHook(() => useUninstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError(new Error('permission denied'));
      });

      expect(mockError).toHaveBeenCalledWith('Uninstall failed: permission denied', {
        id: 'toast-id-abc',
      });
      expect(mockSuccess).not.toHaveBeenCalled();
    });

    it('shows a generic error message when the thrown value is not an Error', () => {
      const { result } = renderHook(() => useUninstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError('boom');
      });

      expect(mockError).toHaveBeenCalledWith('Uninstall failed: unknown error', {
        id: 'toast-id-abc',
      });
    });
  });

  describe('mutateAsync (awaitable)', () => {
    it('re-throws the error after firing an error toast', async () => {
      fakes.mutateAsync.mockRejectedValue(new Error('disk locked'));
      const { result } = renderHook(() => useUninstallWithToast());

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.mutateAsync({ name: '@dorkos/code-reviewer' });
        } catch (err) {
          caught = err;
        }
      });

      expect(mockError).toHaveBeenCalledWith('Uninstall failed: disk locked', {
        id: 'toast-id-abc',
      });
      expect((caught as Error).message).toBe('disk locked');
    });
  });

  describe('return shape', () => {
    it('passes through the mutation state from useUninstallPackage', () => {
      vi.mocked(useUninstallPackage).mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        reset: vi.fn(),
        isPending: true,
        variables: { name: '@dorkos/x' },
      } as unknown as ReturnType<typeof useUninstallPackage>);

      const { result } = renderHook(() => useUninstallWithToast());

      expect(result.current.isPending).toBe(true);
      expect(result.current.variables).toEqual({ name: '@dorkos/x' });
      expect(typeof result.current.mutate).toBe('function');
      expect(typeof result.current.mutateAsync).toBe('function');
    });
  });
});
