/**
 * @vitest-environment jsdom
 *
 * The person's time zone comes from the browser, once, and a zone already set
 * is never overwritten (spec `heartbeats` §3.5).
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import {
  browserTimeZone,
  resetTimezoneSeedForTests,
  useSeedProfileTimezone,
} from '../model/use-seed-profile-timezone';

/** Mount the hook over a transport whose config answers `profile`. */
function mount(
  profile: Record<string, unknown>,
  updateConfig = vi.fn().mockResolvedValue(undefined)
) {
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

/** Let pending effects and promises run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => resetTimezoneSeedForTests());
afterEach(cleanup);

describe('useSeedProfileTimezone', () => {
  it.each([
    ['null', { roles: [], timezone: null }],
    ['missing', { roles: [] }],
  ])('writes the browser zone when the stored zone is %s', async (_shape, profile) => {
    const zone = browserTimeZone();
    expect(zone).toBeTruthy();
    const { updateConfig } = mount(profile);
    await waitFor(() => expect(updateConfig).toHaveBeenCalledWith({ profile: { timezone: zone } }));
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('writes once per load, even when the config is read again or the hook remounts', async () => {
    const first = mount({ timezone: null });
    await waitFor(() => expect(first.updateConfig).toHaveBeenCalledTimes(1));
    first.view.rerender();
    first.view.unmount();
    const second = mount({ timezone: null });
    await settle();
    expect(first.updateConfig).toHaveBeenCalledTimes(1);
    expect(second.updateConfig).not.toHaveBeenCalled();
  });

  it('does not try again after a failed write, and says nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn().mockRejectedValue(new Error('Validation failed'));
    const first = mount({ timezone: null }, failing);
    await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
    first.view.unmount();
    mount({ timezone: null }, failing);
    await settle();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('never overwrites a zone that is already set', async () => {
    const { updateConfig, transport } = mount({ timezone: 'Pacific/Auckland' });
    await waitFor(() => expect(transport.getConfig).toHaveBeenCalled());
    await settle();
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
