/**
 * @vitest-environment jsdom
 *
 * Direct unit tests for `useUninstallWithToast`. Mocks only `useUninstallPackage`
 * and `sonner`, so the toast-id plumbing and per-call callback wiring are
 * covered for real. Mirrors `use-install-with-toast.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

/** The query client each test renders under, so a test can see what it invalidated. */
let queryClient: QueryClient;

/** Render the hook inside a query client, which it needs to refetch the claim feed. */
function renderUninstall() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook(() => useUninstallWithToast(), { wrapper });
}

describe('useUninstallWithToast', () => {
  let fakes: UninstallMutationFakes;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient();
    fakes = makeUninstallMock();
    setUninstallPackageMock(fakes);
  });

  describe('mutate (fire-and-forget)', () => {
    it('fires a loading toast with the package name and calls the underlying mutate', () => {
      const { result } = renderUninstall();

      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });

      expect(mockLoading).toHaveBeenCalledWith('Uninstalling Code Reviewer…');
      expect(fakes.mutate).toHaveBeenCalledTimes(1);
      expect(fakes.mutate.mock.calls[0][0]).toEqual({ name: '@dorkos/code-reviewer' });
    });

    it('replaces the loading toast with a success toast using the same toast id', () => {
      const { result } = renderUninstall();

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

    // Purpose (DOR-2322): an uninstall that kept files it could not prove
    // says which, under the success line. Fails if its warnings are dropped.
    it('shows what the uninstall had to say under its success line', () => {
      const { result } = renderUninstall();
      act(() => {
        result.current.mutate({ name: '@dorkos/code-reviewer' });
      });
      const perCall = fakes.mutate.mock.calls[0][1] as { onSuccess: (result: unknown) => void };
      act(() => {
        perCall.onSuccess({
          ok: true,
          warnings: ['It kept them: a.md. Delete any you don’t need.'],
        });
      });
      expect(mockSuccess).toHaveBeenCalledWith('Uninstalled Code Reviewer', {
        id: 'toast-id-abc',
        description: 'It kept them: a.md. Delete any you don’t need.',
      });
    });

    it('replaces the loading toast with an error toast on failure', () => {
      const { result } = renderUninstall();

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
      const { result } = renderUninstall();

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

  // DOR-2608: uninstalling a chat-app package removes its connection, and the
  // server deletes that connection's waiting chats without sending an event,
  // so a successful uninstall refetches the claim feed. A failed one does not.
  describe('claim feed refetch (DOR-2608)', () => {
    const feedKey = { queryKey: ['relay', 'unclaimed-chats'] };

    it('refetches the claim feed after a successful mutate', () => {
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderUninstall();
      act(() => {
        result.current.mutate({ name: 'telegram-adapter' });
      });
      expect(invalidate).not.toHaveBeenCalledWith(feedKey);
      const perCall = fakes.mutate.mock.calls[0][1] as { onSuccess: (result: unknown) => void };
      act(() => {
        perCall.onSuccess({ ok: true });
      });
      expect(invalidate).toHaveBeenCalledWith(feedKey);
    });

    it('refetches the claim feed after a successful mutateAsync, and not after a failed one', async () => {
      const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
      fakes.mutateAsync.mockRejectedValueOnce(new Error('disk locked'));
      fakes.mutateAsync.mockResolvedValueOnce({ ok: true });
      const { result } = renderUninstall();

      await expect(result.current.mutateAsync({ name: 'telegram-adapter' })).rejects.toThrow();
      expect(invalidate).not.toHaveBeenCalledWith(feedKey);

      await act(async () => {
        await result.current.mutateAsync({ name: 'telegram-adapter' });
      });
      expect(invalidate).toHaveBeenCalledWith(feedKey);
    });
  });

  describe('mutateAsync (awaitable)', () => {
    it('re-throws the error after firing an error toast', async () => {
      fakes.mutateAsync.mockRejectedValue(new Error('disk locked'));
      const { result } = renderUninstall();

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

      const { result } = renderUninstall();

      expect(result.current.isPending).toBe(true);
      expect(result.current.variables).toEqual({ name: '@dorkos/x' });
      expect(typeof result.current.mutate).toBe('function');
      expect(typeof result.current.mutateAsync).toBe('function');
    });
  });
});
