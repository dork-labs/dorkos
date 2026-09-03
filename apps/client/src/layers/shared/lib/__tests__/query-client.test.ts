/**
 * Tests the shared mutation error-toast policy (DOR-402).
 *
 * A mutation's own `onError` does NOT replace the MutationCache one — TanStack
 * awaits the cache handler and then the mutation's — so opting out of the
 * generic toast has to go through `meta.suppressErrorToast`. These tests pin
 * that, because the failure mode is invisible in isolation: a surface that
 * renders its own error still shows the generic toast alongside it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toast } from 'sonner';
import type { Mutation } from '@tanstack/react-query';
import { queryClient } from '../query-client';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

/** Minimal stand-in for the Mutation the cache handler receives; only `meta` is read. */
function mutationWithMeta(
  meta: Record<string, unknown> | undefined
): Mutation<unknown, unknown, unknown> {
  return { meta } as Mutation<unknown, unknown, unknown>;
}

/**
 * Invoke the MutationCache `onError` with TanStack's real 5-argument shape
 * (error, variables, onMutateResult, mutation, context).
 *
 * @param meta - The mutation's `meta`, or undefined when it declared none.
 */
function fireMutationError(meta: Record<string, unknown> | undefined): void {
  const handler = queryClient.getMutationCache().config.onError;
  void handler?.(
    new Error('boom'),
    undefined,
    undefined,
    mutationWithMeta(meta),
    {} as Parameters<NonNullable<typeof handler>>[4]
  );
}

describe('mutation error toast policy', () => {
  beforeEach(() => {
    vi.mocked(toast.error).mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the generic toast for a mutation that declared no meta', () => {
    fireMutationError(undefined);

    expect(toast.error).toHaveBeenCalledWith(
      "That didn't work. Try again.",
      expect.objectContaining({ action: expect.objectContaining({ label: 'Report' }) })
    );
  });

  // DOR-1755: the authored sentence is the headline and the raw error is the
  // description under it. It used to be one line joined by an em dash, so
  // "ENOENT: no such file or directory" led every failure that named itself.
  it('puts the authored label on top and the raw error underneath', () => {
    fireMutationError({ errorLabel: "Couldn't send your message." });

    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't send your message.",
      expect.objectContaining({ description: 'boom' })
    );
    const [headline] = vi.mocked(toast.error).mock.calls[0] as [string, unknown];
    expect(headline).not.toContain('boom');
    expect(headline).not.toContain('\u2014');
  });

  it('stays silent when the mutation opts out via meta.suppressErrorToast', () => {
    fireMutationError({ suppressErrorToast: true });

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('still logs the failure when the toast is suppressed', () => {
    fireMutationError({ suppressErrorToast: true });

    expect(console.error).toHaveBeenCalledWith('[dorkos:mutation-error]', { error: 'boom' });
  });

  it('shows the toast when meta exists but does not opt out', () => {
    fireMutationError({ somethingElse: true });

    expect(toast.error).toHaveBeenCalledWith(
      "That didn't work. Try again.",
      expect.objectContaining({ action: expect.objectContaining({ label: 'Report' }) })
    );
  });
});
