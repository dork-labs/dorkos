/**
 * @vitest-environment jsdom
 *
 * The person's time zone comes from the browser, once, and a zone already set
 * is never overwritten (spec `heartbeats` §3.5).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { browserTimeZone, useSeedProfileTimezone } from '../model/use-seed-profile-timezone';

/** Mount the hook over a transport whose config answers `profile`. */
function mount(profile: Record<string, unknown>) {
  const updateConfig = vi.fn().mockResolvedValue(undefined);
  const transport = createMockTransport({
    getConfig: vi.fn().mockResolvedValue({ profile }),
    updateConfig,
  } as Partial<Transport>);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }
  const view = renderHook(() => useSeedProfileTimezone(), { wrapper: Wrapper });
  return { updateConfig, transport, view };
}

afterEach(cleanup);

describe('useSeedProfileTimezone', () => {
  it('writes the browser zone when none is set', async () => {
    const zone = browserTimeZone();
    expect(zone).toBeTruthy();
    const { updateConfig } = mount({ roles: [], timezone: null });
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ profile: { timezone: zone } }));
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('writes once per load, even when the config is read again', async () => {
    const { updateConfig, view } = mount({ timezone: null });
    await waitFor(() => expect(updateConfig).toHaveBeenCalledTimes(1));
    view.rerender();
    view.rerender();
    // The invalidation after the write refetches a config that still says null
    // in this mock; the hook must not write a second time.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('never overwrites a zone that is already set', async () => {
    const { updateConfig, transport } = mount({ timezone: 'Pacific/Auckland' });
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('writes nothing for a server whose config has no such field', async () => {
    const { updateConfig, transport } = mount({ roles: [] });
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
