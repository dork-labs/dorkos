/**
 * @vitest-environment jsdom
 *
 * `useInstalledUpdatesView` against the real entity hooks, a mock transport and
 * a real QueryClient: when the check runs, when it goes stale, and what a
 * failed check shows.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { Transport } from '@dorkos/shared/transport';
import type { InstallationUpdateCheck, InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '@/layers/entities/marketplace';
import { TransportProvider } from '@/layers/shared/model';

import { useInstalledUpdatesView } from '../model/use-installed-updates-view';

const ROW: InstalledPackage = {
  name: 'flow',
  version: '0.7.2',
  type: 'plugin',
  installPath: '/p/flow',
  scope: 'global',
};

const STALE: InstallationUpdateCheck = {
  packageName: 'flow',
  installedVersion: '0.7.2',
  latestVersion: '0.7.3',
  hasUpdate: true,
  marketplace: 'dorkos-community',
  status: 'update-available',
  installedVersionSource: 'package',
  latestVersionSource: 'package',
  installPath: '/p/flow',
  type: 'plugin',
  scope: 'global',
};

function setup(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('useInstalledUpdatesView', () => {
  it('never checks when nothing is installed', async () => {
    // Purpose: the check reaches out to every package's source; with nothing
    // installed there is nothing to ask about.
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([]);
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdatesView(), { wrapper });

    await waitFor(() => expect(transport.listInstalledPackages).toHaveBeenCalled());
    await act(async () => {});
    expect(transport.checkMarketplaceUpdates).not.toHaveBeenCalled();
    expect(result.current.summary.available).toEqual([]);
  });

  it('checks once, and counts what it found', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([ROW]);
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [STALE] });
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdatesView(), { wrapper });

    await waitFor(() => expect(result.current.summary.available).toHaveLength(1));
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
  });

  it('marks the check stale, without re-running it, when the installed list changes', async () => {
    // Purpose: a package updated elsewhere moves the list; the next view to
    // mount must ask again, but a list refresh must not set off a sweep.
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages)
      .mockResolvedValueOnce([ROW])
      .mockResolvedValue([{ ...ROW, version: '0.7.3' }]);
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [STALE] });
    const { queryClient, wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdatesView(), { wrapper });
    await waitFor(() => expect(result.current.summary.available).toHaveLength(1));
    expect(queryClient.getQueryState(marketplaceKeys.updates())?.isInvalidated).toBe(false);

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
    });

    await waitFor(() =>
      expect(queryClient.getQueryState(marketplaceKeys.updates())?.isInvalidated).toBe(true)
    );
    expect(transport.checkMarketplaceUpdates).toHaveBeenCalledTimes(1);
    // The old answer no longer describes the listed 0.7.3, so it stops counting.
    expect(result.current.summary.available).toEqual([]);
  });

  it('leaves the check alone when a refresh finds the list unchanged', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([ROW]);
    vi.mocked(transport.checkMarketplaceUpdates).mockResolvedValue({ checks: [STALE] });
    const { queryClient, wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdatesView(), { wrapper });
    await waitFor(() => expect(result.current.summary.available).toHaveLength(1));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: marketplaceKeys.installed() });
    });

    expect(queryClient.getQueryState(marketplaceKeys.updates())?.isInvalidated).toBe(false);
  });

  it('shows no earlier answer once a check fails', async () => {
    // Purpose: after a failed "Check again", the previous answer is not
    // current, so rows read as unchecked and the count disappears.
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([ROW]);
    vi.mocked(transport.checkMarketplaceUpdates)
      .mockResolvedValueOnce({ checks: [STALE] })
      .mockRejectedValueOnce(new Error('offline'));
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledUpdatesView(), { wrapper });
    await waitFor(() => expect(result.current.summary.available).toHaveLength(1));
    act(() => result.current.recheck());

    await waitFor(() => expect(result.current.error?.message).toBe('offline'));
    expect(result.current.checks.size).toBe(0);
    expect(result.current.summary.available).toEqual([]);
  });
});
