/**
 * @vitest-environment jsdom
 */
/**
 * The memory-provider-benched descriptor: when it fires, what it renders, and
 * the one thing it must never leak.
 *
 * Testing the banner COMPONENT alone (`MemoryProviderBenchedBanner.test.tsx`)
 * cannot catch a regression in the WIRING between it and the server aggregate
 * — a future edit that starts passing `benchReason` through as a new prop
 * would leave every banner-only test green, since the component's own props
 * carry nothing raw today. This file exercises the actual seam:
 * `useAppBanners` → `useMemoryProviderStatus` → the rendered banner, with a
 * mock transport answering a `benchReason` that would be obviously wrong to
 * show a person.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, renderHook, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';

// The runtime-sign-in descriptor next door reads the Inbox, which subscribes to
// the global `/api/events` stream and so wants the app-level
// `EventStreamProvider` — a whole SSE stack for a subscription nothing in this
// file fires. Everything else in the module is the real thing.
vi.mock('@/layers/shared/model', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/layers/shared/model');
  return { ...actual, useEventSubscription: () => undefined };
});

import { TransportProvider } from '@/layers/shared/model';

import { useAppBanners } from '../model/use-app-banners';
import type { BannerDescriptor } from '../model/banner-descriptor';

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

afterEach(cleanup);

/** A provider tree with a transport whose status read the test controls. */
function harness(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

function findMemoryDescriptor(descriptors: BannerDescriptor[]): BannerDescriptor | undefined {
  return descriptors.find((d) => d.id === 'memory-provider-benched');
}

describe('memory-provider-benched descriptor', () => {
  it('is absent when the configured backend is what is actually serving', async () => {
    const transport = createMockTransport();
    transport.getMemoryProviderStatus = vi.fn().mockResolvedValue({
      configuredId: 'builtin',
      activeId: 'builtin',
      benched: false,
      benchReason: null,
    });

    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });

    // Prove the fetch actually ran, then confirm the descriptor never shows up.
    await waitFor(() => expect(transport.getMemoryProviderStatus).toHaveBeenCalled());
    await waitFor(() => expect(findMemoryDescriptor(result.current)).toBeUndefined());
  });

  it('fires for an unregistered backend even though nothing is benched — the exact silent-fallback case', async () => {
    // The configured id never registered a factory at all (a typo, or a
    // backend module that failed to call `registerMemoryProvider`). The
    // registry has nothing to bench, so `benched` stays false, but
    // `activeId` is honestly `builtin` — the mismatch is what must trigger
    // the banner, not the `benched` flag alone.
    const transport = createMockTransport();
    transport.getMemoryProviderStatus = vi.fn().mockResolvedValue({
      configuredId: 'acme-memory',
      activeId: 'builtin',
      benched: false,
      benchReason: null,
    });

    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findMemoryDescriptor(result.current)).toBeDefined());

    render(findMemoryDescriptor(result.current)!.render());
    expect(screen.getByRole('status')).toHaveTextContent(
      "The acme-memory memory backend isn't installed or didn't register."
    );
  });

  it('fires for a benched backend and never leaks the raw bench reason', async () => {
    const transport = createMockTransport();
    transport.getMemoryProviderStatus = vi.fn().mockResolvedValue({
      configuredId: 'acme-memory',
      activeId: 'builtin',
      benched: true,
      // A reason shaped like the kind of thing that must never reach a
      // screen: connection details.
      benchReason: 'ECONNREFUSED 10.0.0.5:5432 password=hunter2',
    });

    const { result } = renderHook(() => useAppBanners(null), { wrapper: harness(transport) });
    await waitFor(() => expect(findMemoryDescriptor(result.current)).toBeDefined());

    render(findMemoryDescriptor(result.current)!.render());
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('The acme-memory memory backend stopped answering.');
    expect(banner).not.toHaveTextContent('hunter2');
    expect(banner).not.toHaveTextContent('ECONNREFUSED');
    expect(banner).not.toHaveTextContent('10.0.0.5');
  });
});
