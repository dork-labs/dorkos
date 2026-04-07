/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useInstallWithToast`. The hook is also exercised
 * transitively by `InstallConfirmationDialog.test.tsx` and
 * `install-flow.integration.test.tsx`, but those suites mock around the
 * wrapper. These tests mock only `useInstallPackage` and `sonner`, so the
 * toast-id plumbing, per-call callback wiring, and re-render behavior are
 * all covered for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInstallPackage } from '@/layers/entities/marketplace';

import { useInstallWithToast } from '../model/use-install-with-toast';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useInstallPackage: vi.fn(),
}));

const mockLoading = vi.fn(() => 'toast-id-abc');
const mockSuccess = vi.fn();
const mockError = vi.fn();
const mockDismiss = vi.fn();

vi.mock('sonner', () => ({
  toast: {
    loading: (...args: unknown[]) => mockLoading(...(args as Parameters<typeof mockLoading>)),
    success: (...args: unknown[]) => mockSuccess(...(args as Parameters<typeof mockSuccess>)),
    error: (...args: unknown[]) => mockError(...(args as Parameters<typeof mockError>)),
    dismiss: (...args: unknown[]) => mockDismiss(...(args as Parameters<typeof mockDismiss>)),
  },
}));

// ---------------------------------------------------------------------------
// Mutation handle factory
// ---------------------------------------------------------------------------

interface InstallMutationFakes {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function makeInstallMock(): InstallMutationFakes {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  };
}

function setInstallPackageMock(fakes: InstallMutationFakes) {
  vi.mocked(useInstallPackage).mockReturnValue({
    mutate: fakes.mutate,
    mutateAsync: fakes.mutateAsync,
    reset: fakes.reset,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    variables: undefined,
  } as unknown as ReturnType<typeof useInstallPackage>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useInstallWithToast', () => {
  let fakes: InstallMutationFakes;

  beforeEach(() => {
    vi.clearAllMocks();
    fakes = makeInstallMock();
    setInstallPackageMock(fakes);
  });

  describe('mutate (fire-and-forget)', () => {
    it('fires a loading toast with the package name and calls the underlying mutate', () => {
      const { result } = renderHook(() => useInstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      expect(mockLoading).toHaveBeenCalledTimes(1);
      expect(mockLoading).toHaveBeenCalledWith('Installing @dorkos/code-reviewer…');
      expect(fakes.mutate).toHaveBeenCalledTimes(1);
      expect(fakes.mutate.mock.calls[0][0]).toEqual({ name: '@dorkos/code-reviewer' });
    });

    it('replaces the loading toast with a success toast using the same toast id', () => {
      const { result } = renderHook(() => useInstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      // Per-call callbacks were registered as the 2nd mutate argument.
      const perCall = fakes.mutate.mock.calls[0][1] as {
        onSuccess: (result: unknown) => void;
        onError: (error: unknown) => void;
      };

      // Fire the success callback as TanStack Query would.
      act(() => {
        perCall.onSuccess({ success: true });
      });

      expect(mockSuccess).toHaveBeenCalledTimes(1);
      expect(mockSuccess).toHaveBeenCalledWith('Installed @dorkos/code-reviewer', {
        id: 'toast-id-abc',
      });
      // Error toast never fires.
      expect(mockError).not.toHaveBeenCalled();
    });

    it('replaces the loading toast with an error toast on failure', () => {
      const { result } = renderHook(() => useInstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onSuccess: (result: unknown) => void;
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError(new Error('network down'));
      });

      expect(mockError).toHaveBeenCalledTimes(1);
      expect(mockError).toHaveBeenCalledWith('Install failed: network down', {
        id: 'toast-id-abc',
      });
      expect(mockSuccess).not.toHaveBeenCalled();
    });

    it('shows a generic error message when the thrown value is not an Error', () => {
      const { result } = renderHook(() => useInstallWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError('something bad');
      });

      expect(mockError).toHaveBeenCalledWith('Install failed: unknown error', {
        id: 'toast-id-abc',
      });
    });
  });

  describe('mutateAsync (awaitable)', () => {
    it('resolves with the install result and fires a success toast', async () => {
      fakes.mutateAsync.mockResolvedValue({ success: true, packagePath: '/tmp/x' });
      const { result } = renderHook(() => useInstallWithToast());

      let returned: unknown;
      await act(async () => {
        returned = await result.current.mutateAsync({ name: '@dorkos/code-reviewer' });
      });

      expect(mockLoading).toHaveBeenCalledWith('Installing @dorkos/code-reviewer…');
      expect(mockSuccess).toHaveBeenCalledWith('Installed @dorkos/code-reviewer', {
        id: 'toast-id-abc',
      });
      expect(returned).toEqual({ success: true, packagePath: '/tmp/x' });
    });

    it('re-throws the error after firing an error toast', async () => {
      fakes.mutateAsync.mockRejectedValue(new Error('permission denied'));
      const { result } = renderHook(() => useInstallWithToast());

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.mutateAsync({ name: '@dorkos/code-reviewer' });
        } catch (err) {
          caught = err;
        }
      });

      expect(mockError).toHaveBeenCalledWith('Install failed: permission denied', {
        id: 'toast-id-abc',
      });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('permission denied');
    });
  });

  describe('re-render safety', () => {
    it('does not fire any toasts on a bare render (no mutation in flight)', () => {
      renderHook(() => useInstallWithToast());

      expect(mockLoading).not.toHaveBeenCalled();
      expect(mockSuccess).not.toHaveBeenCalled();
      expect(mockError).not.toHaveBeenCalled();
    });

    it('does not replay the success toast across multiple re-renders', async () => {
      fakes.mutateAsync.mockResolvedValue({ success: true });
      const { result, rerender } = renderHook(() => useInstallWithToast());

      await act(async () => {
        await result.current.mutateAsync({ name: '@dorkos/code-reviewer' });
      });

      expect(mockSuccess).toHaveBeenCalledTimes(1);

      // Force several re-renders — the success toast must NOT fire again.
      rerender();
      rerender();
      rerender();

      expect(mockSuccess).toHaveBeenCalledTimes(1);
    });
  });

  describe('return shape', () => {
    it('passes through the mutation state from useInstallPackage', () => {
      vi.mocked(useInstallPackage).mockReturnValue({
        mutate: vi.fn(),
        mutateAsync: vi.fn(),
        reset: vi.fn(),
        isPending: true,
        isSuccess: false,
        isError: false,
        error: null,
        data: undefined,
        variables: { name: '@dorkos/x' },
      } as unknown as ReturnType<typeof useInstallPackage>);

      const { result } = renderHook(() => useInstallWithToast());

      expect(result.current.isPending).toBe(true);
      expect(result.current.isSuccess).toBe(false);
      expect(result.current.variables).toEqual({ name: '@dorkos/x' });
      // The wrapper replaces `mutate` and `mutateAsync` but everything else
      // passes through — consumers can still read the mutation state.
      expect(typeof result.current.mutate).toBe('function');
      expect(typeof result.current.mutateAsync).toBe('function');
      expect(typeof result.current.reset).toBe('function');
    });

    it('fires the loading toast before mutateAsync settles', async () => {
      fakes.mutateAsync.mockResolvedValue({ success: true });
      const { result } = renderHook(() => useInstallWithToast());

      await act(async () => {
        // Kick off the mutation but don't await until after the sync check.
        const p = result.current.mutateAsync({ name: '@dorkos/code-reviewer' });

        // Loading toast fired synchronously before the promise resolved.
        expect(mockLoading).toHaveBeenCalledTimes(1);
        expect(mockSuccess).not.toHaveBeenCalled();

        // Settle the mutation.
        await p;
      });

      // After settlement, success fires exactly once.
      expect(mockSuccess).toHaveBeenCalledTimes(1);
    });
  });
});
