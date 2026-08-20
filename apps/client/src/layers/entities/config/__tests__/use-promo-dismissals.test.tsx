/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
import { TransportProvider } from '@/layers/shared/model';
import { usePromoDismissals, resetLegacyPromoImportForTests } from '../model/use-promo-dismissals';

const LEGACY_KEY = 'dorkos-dismissed-promo-ids';

let mockTransport: ReturnType<typeof createMockTransport>;

/** Mounts the hook over a real query client and a mock transport. */
async function renderDismissals(dismissedPromoIds: string[] = []) {
  mockTransport = createMockTransport();
  vi.mocked(mockTransport.getConfig).mockResolvedValue({
    dismissedPromoIds,
  } as unknown as ServerConfig);
  vi.mocked(mockTransport.updateConfig).mockResolvedValue(undefined);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = renderHook(() => usePromoDismissals(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      </QueryClientProvider>
    ),
  });
  // Settle the read before asserting: the hook returns `[]` while loading, so a
  // negative assertion made against the loading state would pass regardless.
  await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  return view;
}

describe('usePromoDismissals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetLegacyPromoImportForTests();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('reads the dismissed ids the server holds', async () => {
    const { result } = await renderDismissals(['remote-access']);
    expect(result.current.dismissedIds).toEqual(['remote-access']);
  });

  it('writes a dismissal to config, not to this browser', async () => {
    // The whole point of the move: dismissing on a laptop has to settle it on a
    // phone. What this catches is a regression to a localStorage write, which
    // would leave `updateConfig` untouched.
    const { result } = await renderDismissals([]);

    act(() => result.current.dismissPromo('schedules'));

    await waitFor(() =>
      expect(mockTransport.updateConfig).toHaveBeenCalledWith({
        ui: { promos: { dismissedIds: ['schedules'] } },
      })
    );
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('hides the card before the server answers', async () => {
    // A round trip is long enough to read as a dead button, so the cache moves
    // first. The write is held open deliberately — that is the window under
    // test, and letting it resolve would settle the question with the refetch
    // instead of with the optimistic update this exists to prove.
    const { result } = await renderDismissals([]);
    vi.mocked(mockTransport.updateConfig).mockReturnValue(new Promise(() => {}));

    act(() => result.current.dismissPromo('schedules'));

    await waitFor(() => expect(result.current.dismissedIds).toContain('schedules'));
  });

  it('puts the card back if the write fails', async () => {
    // Catches an optimistic update with no rollback, which would hide a card
    // the server never agreed to hide — the person's answer silently lost.
    const { result } = await renderDismissals([]);
    vi.mocked(mockTransport.updateConfig).mockRejectedValue(new Error('offline'));

    act(() => result.current.dismissPromo('schedules'));
    await waitFor(() => expect(result.current.dismissedIds).toEqual([]));
  });

  it('holds the dismissal for the session on a transport that cannot persist', async () => {
    // The Obsidian `DirectTransport` shape: `getConfig` answers, `updateConfig`
    // RESOLVES but stores nothing (`embedded-mode-stubs.ts` makes it a no-op).
    // What this catches is the version of this hook that trusted the server
    // list alone: the success invalidation refetches `[]`, the optimistic write
    // is undone, and the card the person just dismissed comes straight back.
    const { result } = await renderDismissals([]);

    act(() => result.current.dismissPromo('schedules'));
    await waitFor(() => expect(mockTransport.updateConfig).toHaveBeenCalled());

    // The refetch has landed and still says nothing is dismissed...
    await waitFor(() => expect(mockTransport.getConfig).toHaveBeenCalledTimes(2));
    expect(
      (await vi.mocked(mockTransport.getConfig).mock.results[1]!.value).dismissedPromoIds
    ).toEqual([]);
    // ...and the card is still gone, because the press is remembered here too.
    expect(result.current.dismissedIds).toContain('schedules');
  });

  it('adds nothing twice', async () => {
    const { result } = await renderDismissals(['schedules']);

    act(() => result.current.dismissPromo('schedules'));

    expect(mockTransport.updateConfig).not.toHaveBeenCalled();
  });

  describe('the one-time import of the retired browser key', () => {
    it('carries an old install’s dismissals into config and clears the key', async () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['remote-access', 'schedules']));

      await renderDismissals([]);

      await waitFor(() =>
        expect(mockTransport.updateConfig).toHaveBeenCalledWith({
          ui: { promos: { dismissedIds: ['remote-access', 'schedules'] } },
        })
      );
      // Cleared, so it can never be imported a second time — which is what
      // would resurrect a card somebody had since un-dismissed.
      await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
    });

    it('merges rather than replaces what the server already holds', async () => {
      // Catches an import that overwrites: a person who dismissed on a phone
      // and then opened an old laptop tab would lose the phone's answer.
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['schedules']));

      await renderDismissals(['remote-access']);

      await waitFor(() =>
        expect(mockTransport.updateConfig).toHaveBeenCalledWith({
          ui: { promos: { dismissedIds: ['remote-access', 'schedules'] } },
        })
      );
    });

    it('keeps the key when the write fails, so nothing is lost', async () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['schedules']));
      const failing = createMockTransport();
      vi.mocked(failing.getConfig).mockResolvedValue({
        dismissedPromoIds: [],
      } as unknown as ServerConfig);
      vi.mocked(failing.updateConfig).mockRejectedValue(new Error('offline'));

      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      renderHook(() => usePromoDismissals(), {
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>
            <TransportProvider transport={failing}>{children}</TransportProvider>
          </QueryClientProvider>
        ),
      });

      await waitFor(() => expect(failing.updateConfig).toHaveBeenCalled());
      expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
    });

    it('writes nothing when the server already has everything the key held', async () => {
      localStorage.setItem(LEGACY_KEY, JSON.stringify(['schedules']));

      await renderDismissals(['schedules']);

      expect(mockTransport.updateConfig).not.toHaveBeenCalled();
      await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
    });

    it('survives a key holding something that is not a list of ids', async () => {
      localStorage.setItem(LEGACY_KEY, '{"not":"an array"}');

      const { result } = await renderDismissals(['schedules']);

      expect(result.current.dismissedIds).toEqual(['schedules']);
      expect(mockTransport.updateConfig).not.toHaveBeenCalled();
    });
  });
});
