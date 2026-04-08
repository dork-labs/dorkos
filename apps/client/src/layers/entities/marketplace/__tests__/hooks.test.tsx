/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import type {
  AggregatedPackage,
  InstallResult,
  UninstallResult,
} from '@dorkos/shared/marketplace-schemas';
import {
  useMarketplacePackages,
  useInstallPackage,
  useUninstallPackage,
  useInstalledPackages,
} from '../index';

const mockPackage: AggregatedPackage = {
  name: '@dorkos/code-reviewer',
  source: 'https://github.com/dorkos/code-reviewer.git',
  description: 'Automated PR code review agent',
  version: '1.0.0',
  type: 'agent',
  marketplace: 'dorkos-official',
};

const mockInstallResult: InstallResult = {
  ok: true,
  packageName: '@dorkos/code-reviewer',
  version: '1.0.0',
  type: 'agent',
  installPath: '/tmp/.dork/agents/code-reviewer',
  manifest: {
    name: '@dorkos/code-reviewer',
    version: '1.0.0',
    type: 'agent',
  },
  warnings: [],
};

const mockUninstallResult: UninstallResult = {
  ok: true,
  packageName: '@dorkos/code-reviewer',
  removedFiles: 3,
  preservedData: [],
};

function createWrapper(transport: Transport) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useMarketplacePackages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches packages via transport.listMarketplacePackages', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listMarketplacePackages).mockResolvedValue([mockPackage]);

    const { result } = renderHook(() => useMarketplacePackages(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toHaveLength(1);
    expect(result.current.data?.[0].name).toBe('@dorkos/code-reviewer');
    expect(transport.listMarketplacePackages).toHaveBeenCalledTimes(1);
    expect(transport.listMarketplacePackages).toHaveBeenCalledWith(undefined);
  });

  it('passes filter arguments to the transport', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listMarketplacePackages).mockResolvedValue([mockPackage]);

    const { result } = renderHook(() => useMarketplacePackages({ type: 'agent', q: 'review' }), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.listMarketplacePackages).toHaveBeenCalledWith({
      type: 'agent',
      q: 'review',
    });
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listMarketplacePackages).mockRejectedValue(
      new Error('Marketplace unavailable')
    );

    const { result } = renderHook(() => useMarketplacePackages(), {
      wrapper: createWrapper(transport),
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Marketplace unavailable');
  });
});

describe('useInstallPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.installMarketplacePackage with the provided name and options', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.installMarketplacePackage).mockResolvedValue(mockInstallResult);

    const { result } = renderHook(() => useInstallPackage(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({
      name: '@dorkos/code-reviewer',
      options: { yes: true, force: false },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.installMarketplacePackage).toHaveBeenCalledWith('@dorkos/code-reviewer', {
      yes: true,
      force: false,
    });
    expect(result.current.data).toEqual(mockInstallResult);
  });

  it('invalidates the installed-packages query on success', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([]);
    vi.mocked(transport.installMarketplacePackage).mockResolvedValue(mockInstallResult);

    const wrapper = createWrapper(transport);

    // Prime the installed-packages cache first
    const { result: installedResult } = renderHook(() => useInstalledPackages(), {
      wrapper,
    });
    await waitFor(() => {
      expect(installedResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useInstallPackage(), { wrapper });

    result.current.mutate({ name: '@dorkos/code-reviewer' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Invalidation triggers a refetch — listInstalledPackages called a second time
    await waitFor(() => {
      expect(transport.listInstalledPackages).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.installMarketplacePackage).mockRejectedValue(
      new Error('Install transaction failed')
    );

    const { result } = renderHook(() => useInstallPackage(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ name: '@dorkos/code-reviewer' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Install transaction failed');
  });
});

describe('useUninstallPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls transport.uninstallMarketplacePackage with the provided name and options', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uninstallMarketplacePackage).mockResolvedValue(mockUninstallResult);

    const { result } = renderHook(() => useUninstallPackage(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({
      name: '@dorkos/code-reviewer',
      options: { purge: true },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(transport.uninstallMarketplacePackage).toHaveBeenCalledWith('@dorkos/code-reviewer', {
      purge: true,
    });
    expect(result.current.data).toEqual(mockUninstallResult);
  });

  it('invalidates the installed-packages query on success', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.listInstalledPackages).mockResolvedValue([]);
    vi.mocked(transport.uninstallMarketplacePackage).mockResolvedValue(mockUninstallResult);

    const wrapper = createWrapper(transport);

    // Prime the installed-packages cache first
    const { result: installedResult } = renderHook(() => useInstalledPackages(), {
      wrapper,
    });
    await waitFor(() => {
      expect(installedResult.current.isSuccess).toBe(true);
    });

    const { result } = renderHook(() => useUninstallPackage(), { wrapper });

    result.current.mutate({ name: '@dorkos/code-reviewer' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Invalidation triggers a refetch — listInstalledPackages called a second time
    await waitFor(() => {
      expect(transport.listInstalledPackages).toHaveBeenCalledTimes(2);
    });
  });

  it('exposes error state on transport failure', async () => {
    const transport = createMockTransport();
    vi.mocked(transport.uninstallMarketplacePackage).mockRejectedValue(
      new Error('Uninstall failed')
    );

    const { result } = renderHook(() => useUninstallPackage(), {
      wrapper: createWrapper(transport),
    });

    result.current.mutate({ name: '@dorkos/code-reviewer' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error).toBeInstanceOf(Error);
  });
});
