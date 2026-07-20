/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useUpdateWithToast`. Mocks only `useUpdatePackage` and
 * `sonner`. Covers the success-message branch (applied reinstall vs already
 * up to date) and the error branch. Mirrors `use-install-with-toast.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUpdatePackage } from '@/layers/entities/marketplace';
import type { UpdateResult } from '@dorkos/shared/marketplace-schemas';

import { useUpdateWithToast } from '../model/use-update-with-toast';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/entities/marketplace', () => ({
  useUpdatePackage: vi.fn(),
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

interface UpdateMutationFakes {
  mutate: ReturnType<typeof vi.fn>;
  mutateAsync: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

function makeUpdateMock(): UpdateMutationFakes {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), reset: vi.fn() };
}

function setUpdatePackageMock(fakes: UpdateMutationFakes) {
  vi.mocked(useUpdatePackage).mockReturnValue({
    mutate: fakes.mutate,
    mutateAsync: fakes.mutateAsync,
    reset: fakes.reset,
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    variables: undefined,
  } as unknown as ReturnType<typeof useUpdatePackage>);
}

/** An UpdateResult with one applied reinstall at the given version. */
function appliedResult(version: string): UpdateResult {
  return {
    checks: [],
    applied: [
      {
        ok: true,
        packageName: '@dorkos/code-reviewer',
        version,
        type: 'agent',
        installPath: '/tmp/x',
        manifest: { name: '@dorkos/code-reviewer', version, type: 'agent' },
        warnings: [],
      },
    ],
  };
}

/** An UpdateResult where nothing needed updating. */
const NO_UPDATE_RESULT: UpdateResult = { checks: [], applied: [] };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useUpdateWithToast', () => {
  let fakes: UpdateMutationFakes;

  beforeEach(() => {
    vi.clearAllMocks();
    fakes = makeUpdateMock();
    setUpdatePackageMock(fakes);
  });

  describe('mutate (fire-and-forget)', () => {
    it('fires a loading toast and calls the underlying mutate', () => {
      const { result } = renderHook(() => useUpdateWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer', options: { apply: true } });
      });

      expect(mockLoading).toHaveBeenCalledWith('Updating Code Reviewer…');
      expect(fakes.mutate).toHaveBeenCalledTimes(1);
    });

    it('reports the new version when a reinstall was applied', () => {
      const { result } = renderHook(() => useUpdateWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer', options: { apply: true } });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onSuccess: (result: UpdateResult) => void;
      };

      act(() => {
        perCall.onSuccess(appliedResult('2.1.0'));
      });

      expect(mockSuccess).toHaveBeenCalledWith('Updated Code Reviewer to v2.1.0', {
        id: 'toast-id-abc',
      });
    });

    it('says "already up to date" when nothing was applied', () => {
      const { result } = renderHook(() => useUpdateWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer', options: { apply: true } });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onSuccess: (result: UpdateResult) => void;
      };

      act(() => {
        perCall.onSuccess(NO_UPDATE_RESULT);
      });

      expect(mockSuccess).toHaveBeenCalledWith('Code Reviewer is already up to date', {
        id: 'toast-id-abc',
      });
    });

    it('replaces the loading toast with an error toast on failure', () => {
      const { result } = renderHook(() => useUpdateWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer', options: { apply: true } });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError(new Error('registry unreachable'));
      });

      expect(mockError).toHaveBeenCalledWith('Update failed: registry unreachable', {
        id: 'toast-id-abc',
      });
      expect(mockSuccess).not.toHaveBeenCalled();
    });

    it('shows a generic error message when the thrown value is not an Error', () => {
      const { result } = renderHook(() => useUpdateWithToast());

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer', options: { apply: true } });
      });

      const perCall = fakes.mutate.mock.calls[0][1] as {
        onError: (error: unknown) => void;
      };

      act(() => {
        perCall.onError('boom');
      });

      expect(mockError).toHaveBeenCalledWith('Update failed: unknown error', {
        id: 'toast-id-abc',
      });
    });
  });

  describe('mutateAsync (awaitable)', () => {
    it('resolves with the result and fires the version success toast', async () => {
      fakes.mutateAsync.mockResolvedValue(appliedResult('3.0.0'));
      const { result } = renderHook(() => useUpdateWithToast());

      let returned: UpdateResult | undefined;
      await act(async () => {
        returned = await result.current.mutateAsync({
          name: '@dorkos/code-reviewer',
          options: { apply: true },
        });
      });

      expect(mockSuccess).toHaveBeenCalledWith('Updated Code Reviewer to v3.0.0', {
        id: 'toast-id-abc',
      });
      expect(returned?.applied[0]?.version).toBe('3.0.0');
    });

    it('re-throws the error after firing an error toast', async () => {
      fakes.mutateAsync.mockRejectedValue(new Error('conflict'));
      const { result } = renderHook(() => useUpdateWithToast());

      let caught: unknown;
      await act(async () => {
        try {
          await result.current.mutateAsync({
            name: '@dorkos/code-reviewer',
            options: { apply: true },
          });
        } catch (err) {
          caught = err;
        }
      });

      expect(mockError).toHaveBeenCalledWith('Update failed: conflict', { id: 'toast-id-abc' });
      expect((caught as Error).message).toBe('conflict');
    });
  });
});
