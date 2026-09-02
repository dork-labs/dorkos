/**
 * @vitest-environment jsdom
 */
/**
 * The runtime-sign-in banner: when it fires, when it goes away, and the one
 * signal it must never be keyed on.
 *
 * The predicate is tested twice on purpose. Directly, because the rule it
 * encodes ("the newest row per runtime, and `outcome` decides") is the whole
 * risk in this feature. And through `useAppBanners` with a real transport mock,
 * because a predicate that is right about rows proves nothing about the WIRING
 * — a descriptor asking for the wrong lens, or ranked at the wrong priority,
 * leaves every pure test green while the app draws nothing.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

import { deadSigninRuntimes } from '../lib/dead-runtime-signins';
import { useAppBanners } from '../model/use-app-banners';
import { RuntimeSigninBanner } from '../ui/RuntimeSigninBanner';
import { BANNER_PRIORITY, type BannerDescriptor } from '../model/banner-descriptor';

// Two seams stand in, and nothing else does. The banner deep-links to Settings
// → Runtimes, which needs TanStack Router context; and the Inbox hook subscribes
// to the global `/api/events` stream, which needs the app-level
// `EventStreamProvider` — a whole SSE stack for a subscription no test here
// fires. The QUERY that feeds the descriptor is the real one, over a real
// transport.
const { openSettings } = vi.hoisted(() => ({ openSettings: vi.fn() }));
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return {
    ...actual,
    useSettingsDeepLink: () => ({ open: openSettings }),
    useEventSubscription: () => undefined,
  };
});

// motion reads matchMedia (reduced-motion) which jsdom does not implement.
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  openSettings.mockClear();
});

/** One `signin.required` row, as the server writes it. */
function signinRow(
  runtime: string,
  at: string,
  extra: Partial<NotificationDTO> = {}
): NotificationDTO {
  return {
    id: `n-${runtime}-${at}`,
    kind: 'signin.required',
    tier: 'blocking',
    subject: { type: 'system', id: runtime },
    title: `Your ${runtime} sign-in stopped working`,
    createdAt: at,
    ...extra,
  };
}

/**
 * The recovery row, exactly as `emitters/runtime-signin.ts` writes it: a second
 * row carrying `outcome: 'cleared'`, and already read.
 */
function recoveryRow(runtime: string, at: string): NotificationDTO {
  return signinRow(runtime, at, {
    title: `Your ${runtime} sign-in is working again`,
    resolvedAt: at,
    outcome: 'cleared',
    readAt: at,
  });
}

describe('deadSigninRuntimes', () => {
  it('is empty when nothing has failed', () => {
    expect(deadSigninRuntimes([])).toEqual([]);
  });

  it('names a runtime whose newest row is a raise', () => {
    expect(deadSigninRuntimes([signinRow('claude-code', '2026-09-01T10:00:00.000Z')])).toEqual([
      'claude-code',
    ]);
  });

  it('drops a runtime once its recovery row lands — the row that is ALREADY READ', () => {
    // The exact regression this rule exists for. Keyed on unread, the recovery
    // row would be invisible and the banner would stand forever.
    const rows = [
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
    ];
    expect(deadSigninRuntimes(rows)).toEqual([]);
  });

  it('drops a runtime the server closed at boot after a restart', () => {
    // The other half of DOR-1680, and the reason this banner is not permanent.
    // The episode store is in memory, so a server killed mid-episode can never
    // see the recovery edge; boot writes a resolution row instead
    // (`emitters/runtime-signin.ts`), saying a restart cleared it rather than
    // claiming an all-clear. Its title differs from the recovery row's — the
    // predicate must key on `outcome`, which both carry, and never on words.
    const bootClosed = signinRow('claude-code', '2026-09-01T11:00:00.000Z', {
      title: 'DorkOS restarted while your Claude sign-in was broken',
      resolvedAt: '2026-09-01T11:00:00.000Z',
      outcome: 'cleared',
      readAt: '2026-09-01T11:00:00.000Z',
    });
    const rows = [bootClosed, signinRow('claude-code', '2026-09-01T10:00:00.000Z')];
    expect(deadSigninRuntimes(rows)).toEqual([]);
  });

  it('keeps a runtime whose raise row was read while it was still dead', () => {
    // The mirror case: opening the Inbox marks the raise row read. That is not
    // a recovery, and the banner must not take it for one.
    const rows = [
      signinRow('claude-code', '2026-09-01T10:00:00.000Z', { readAt: '2026-09-01T10:01:00.000Z' }),
    ];
    expect(deadSigninRuntimes(rows)).toEqual(['claude-code']);
  });

  it('names a runtime again on a second episode after a recovery', () => {
    const rows = [
      signinRow('claude-code', '2026-09-02T09:00:00.000Z'),
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
    ];
    expect(deadSigninRuntimes(rows)).toEqual(['claude-code']);
  });

  it('reads the newest row by timestamp, not by arrival order', () => {
    // A refetch can interleave a page with rows that arrived live. Taking the
    // first row per runtime would resurrect a sign-in that is fixed.
    const rows = [
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
    ];
    expect(deadSigninRuntimes(rows)).toEqual([]);
  });

  it('tracks each runtime on its own', () => {
    const rows = [
      recoveryRow('codex', '2026-09-01T10:05:00.000Z'),
      signinRow('codex', '2026-09-01T10:00:00.000Z'),
      signinRow('claude-code', '2026-09-01T09:00:00.000Z'),
    ];
    expect(deadSigninRuntimes(rows)).toEqual(['claude-code']);
  });

  it('ignores rows of other kinds', () => {
    const other: NotificationDTO = {
      id: 'n-other',
      kind: 'session.error',
      tier: 'blocking',
      subject: { type: 'session', id: 'claude-code' },
      title: 'A session stopped on an error',
      createdAt: '2026-09-01T11:00:00.000Z',
    };
    expect(deadSigninRuntimes([other])).toEqual([]);
  });
});

/** A provider tree with a transport whose Inbox page the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** A transport answering the Inbox with exactly these rows. */
function transportWith(rows: NotificationDTO[]) {
  const transport = createMockTransport();
  transport.listNotifications = vi
    .fn()
    .mockResolvedValue({ notifications: rows, nextCursor: null, unreadCount: 0 });
  return transport;
}

function findSigninDescriptor(descriptors: BannerDescriptor[]): BannerDescriptor | undefined {
  return descriptors.find((d) => d.id === 'runtime-signin');
}

describe('runtime-signin descriptor', () => {
  it('asks the Inbox for sign-in rows only', async () => {
    const transport = transportWith([]);
    renderHook(() => useAppBanners(null), { wrapper: harness(transport) });

    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
    expect(transport.listNotifications).toHaveBeenCalledWith(
      expect.objectContaining({ kind: ['signin.required'] })
    );
  });

  it('is absent when no sign-in has failed', async () => {
    const transport = transportWith([]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });

    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeUndefined());
  });

  it('outranks every other banner and names the dead runtime', async () => {
    const transport = transportWith([signinRow('claude-code', '2026-09-01T10:00:00.000Z')]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeDefined());

    const descriptor = findSigninDescriptor(result.current)!;
    expect(descriptor.variant).toBe('critical');
    expect(descriptor.priority).toBe(BANNER_PRIORITY.critical);
    expect(descriptor.priority).toBeGreaterThan(BANNER_PRIORITY.warning);

    render(descriptor.render());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your Claude sign-in stopped working. Agents and scheduled tasks stay stuck until you sign in again.'
    );
  });

  it('goes away once the recovery row lands, even though it arrives already read', async () => {
    const transport = transportWith([
      recoveryRow('claude-code', '2026-09-01T10:05:00.000Z'),
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
    ]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });

    await waitFor(() => expect(transport.listNotifications).toHaveBeenCalled());
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeUndefined());
  });

  it('names both runtimes when two sign-ins are dead', async () => {
    const transport = transportWith([
      signinRow('codex', '2026-09-01T10:05:00.000Z'),
      signinRow('claude-code', '2026-09-01T10:00:00.000Z'),
    ]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeDefined());

    render(findSigninDescriptor(result.current)!.render());
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your Codex and Claude sign-ins stopped working.'
    );
  });

  it('counts the rest once more runtimes are dead than the row names', () => {
    // Four is more than DorkOS ships today, which is the point: the line stays
    // one line when a future runtime joins.
    render(
      <RuntimeSigninBanner runtimes={['claude-code', 'codex', 'opencode', 'a-future-runtime']} />
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your Claude, Codex and OpenCode sign-ins stopped working, and 1 more.'
    );
  });

  it('deep-links to Settings → Runtimes', async () => {
    const transport = transportWith([signinRow('claude-code', '2026-09-01T10:00:00.000Z')]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeDefined());

    render(findSigninDescriptor(result.current)!.render());
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(openSettings).toHaveBeenCalledWith('runtimes');
  });

  it('says something different from the transcript sign-in card, so the two never read as one repeated alarm', async () => {
    // `ErrorMessageBlock`'s auth card says "Sign in to Claude again" / "Your
    // Claude login stopped working…" with a "Fix sign-in" button. Both surfaces
    // can be on screen at once, and neither may be a copy of the other.
    const transport = transportWith([signinRow('claude-code', '2026-09-01T10:00:00.000Z')]);
    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findSigninDescriptor(result.current)).toBeDefined());

    render(findSigninDescriptor(result.current)!.render());
    const banner = screen.getByRole('alert');
    expect(banner).not.toHaveTextContent('Sign in to Claude again');
    expect(banner).not.toHaveTextContent('pick up where you left off');
    expect(screen.queryByRole('button', { name: 'Fix sign-in' })).toBeNull();
  });
});
