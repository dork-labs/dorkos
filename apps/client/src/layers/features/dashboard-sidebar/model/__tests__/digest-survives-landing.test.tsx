// @vitest-environment jsdom
/**
 * Opening the app on a chat — a reload, a deep link, a notification — still
 * shows "While you were away…" (BC-22, amended by `your-activity-first`).
 *
 * The chat page records every chat it shows (`useRecordChatOpened`), and the
 * digest dissolves the moment the newest open record moves. Both run on the
 * same first paint, so this test mounts them together, on a page load that
 * began at `/session?session=landed`, and asserts the digest is still there.
 *
 * @module features/dashboard-sidebar/model/__tests__/digest-survives-landing
 */
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { Session } from '@dorkos/shared/types';
import { createMockTransport } from '@dorkos/test-utils';

const welcomeBack = {
  enabled: true,
  absenceThresholdMinutes: 240,
  maxPosts: 3,
  offersEnabled: false,
  setEnabled: vi.fn(),
  setOffersEnabled: vi.fn(),
  isAvailable: true,
  isPending: false,
};

vi.mock('@/layers/entities/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/config')>()),
  useWelcomeBack: () => welcomeBack,
  useUpdateSidebarPrefs: () => ({ update: vi.fn(), updateAsync: vi.fn(), isPending: false }),
}));

const NOW = Date.now();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();
const session = (id: string, updatedAt: string): Session =>
  ({ id, title: id, createdAt: hoursAgo(48), updatedAt }) as Session;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
  vi.resetModules();
});

/** Load every module fresh, as a page load that began on `url`. */
async function loadAt(url: string) {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  const { useRecordChatOpened } = await import('@/layers/entities/session');
  const { useInteractionStore, useInteractionTimestamps } =
    await import('@/layers/entities/interactions');
  const { TransportProvider } = await import('@/layers/shared/model');
  const { useDigestFacts } = await import('../use-digest-facts');
  // Last here fourteen hours ago; two chats finished while you were away.
  useInteractionStore.setState({
    opened: { 'session:yesterday': hoursAgo(14) },
    counts: { 'session:yesterday': 1 },
  });
  const transport = createMockTransport();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <TransportProvider transport={transport}>{children}</TransportProvider>
  );
  /** The chat page and the sidebar's digest, mounted in one paint. */
  function useLandingAndDigest(shown: string) {
    useRecordChatOpened(shown);
    return useDigestFacts({
      now: NOW,
      sessions: [session('a', hoursAgo(2)), session('b', hoursAgo(3))],
      workingSessionIds: [],
      sessionStatuses: {},
      interactions: useInteractionTimestamps(),
      storedLastShownDate: '2000-01-01',
      settled: true,
    });
  }
  return { useLandingAndDigest, wrapper, transport };
}

describe('the digest survives landing on a chat (BC-22)', () => {
  it('still shows when the app opens on /session?session=landed', async () => {
    const { useLandingAndDigest, wrapper, transport } = await loadAt('/session?session=landed');
    const { result } = renderHook(() => useLandingAndDigest('landed'), { wrapper });

    expect(transport.markSessionOpened).toHaveBeenCalledWith('landed');
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);
  });

  it('dissolves once you open another chat, as it always has', async () => {
    const { useLandingAndDigest, wrapper } = await loadAt('/session?session=landed');
    const { result, rerender } = renderHook(({ id }) => useLandingAndDigest(id), {
      wrapper,
      initialProps: { id: 'landed' },
    });
    expect(result.current.digest.finishedWhileAwayCount).toBe(2);

    rerender({ id: 'another' });
    expect(result.current.digest.finishedWhileAwayCount).toBe(0);
  });
});
