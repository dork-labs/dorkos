/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type { InstalledPackage } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys, useInstalledIntegrity, usePreparePackage } from '../index';

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

const LEGACY: InstalledPackage = {
  name: 'flow',
  version: '0.7.3',
  type: 'plugin',
  installPath: '/home/.dork/plugins/flow',
  integrity: { status: 'unknown', reason: 'no-record' },
};

describe('useInstalledIntegrity (DOR-2197)', () => {
  // Purpose: the Installed view asks once, with verification, for every
  // scope, and looks each row's integrity up by its installPath.
  it('verifies every installation in one request and indexes it by installPath', async () => {
    const transport = createMockTransport({
      listInstalledPackages: vi.fn().mockResolvedValue([LEGACY]),
    });
    const { wrapper } = setup(transport);

    const { result } = renderHook(() => useInstalledIntegrity(), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(transport.listInstalledPackages).toHaveBeenCalledWith(undefined, { verify: true });
    expect(result.current.data?.get('/home/.dork/plugins/flow')).toEqual({
      status: 'unknown',
      reason: 'no-record',
    });
  });

  // Purpose: the verified list lives under the installed key, so everything
  // that refreshes the installed list (install, uninstall, update) refreshes it.
  it('is keyed under the installed list', () => {
    expect(marketplaceKeys.integrity().slice(0, 2)).toEqual(marketplaceKeys.installed());
  });
});

describe('usePreparePackage (DOR-2320)', () => {
  // Purpose: preparing names the one installation, and refreshes the verified
  // list afterwards so the row stops saying it needs preparing.
  it('prepares the installation and refreshes its integrity', async () => {
    const transport = createMockTransport({
      prepareMarketplacePackage: vi
        .fn()
        .mockResolvedValue({ outcome: 'rebuilt', message: 'DorkOS now knows.' }),
    });
    const { queryClient, wrapper } = setup(transport);
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    const { result } = renderHook(() => usePreparePackage(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({
        name: 'flow',
        options: { installRoot: '/home/.dork/plugins/flow' },
      });
    });

    expect(transport.prepareMarketplacePackage).toHaveBeenCalledWith('flow', {
      installRoot: '/home/.dork/plugins/flow',
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: marketplaceKeys.integrity() });
  });
});
