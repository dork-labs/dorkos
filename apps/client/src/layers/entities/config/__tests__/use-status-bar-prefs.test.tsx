/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { StatusBarPrefs } from '@dorkos/shared/config-schema';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useStatusBarPrefs, useUpdateStatusBarPrefs } from '../model/use-status-bar-prefs';

function makeServerConfig(statusBar: StatusBarPrefs): ServerConfig {
  return { ui: { statusBar } } as unknown as ServerConfig;
}

function createHarness(transport: Transport) {
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

describe('useStatusBarPrefs', () => {
  it('returns the all-visible defaults when config has not loaded', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { wrapper } = createHarness(transport);
    const { result } = renderHook(() => useStatusBarPrefs(), { wrapper });
    expect(result.current).toEqual(STATUS_BAR_PREFS_DEFAULTS);
  });

  it('selects `ui.statusBar` from the loaded config', () => {
    const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue({}) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(
      configKeys.current(),
      makeServerConfig({ ...STATUS_BAR_PREFS_DEFAULTS, git: false, model: false })
    );
    const { result } = renderHook(() => useStatusBarPrefs(), { wrapper });
    expect(result.current.git).toBe(false);
    expect(result.current.model).toBe(false);
    expect(result.current.cwd).toBe(true);
  });
});

describe('useUpdateStatusBarPrefs', () => {
  it('setVisibility PATCHes the single key and updates the cache optimistically', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(STATUS_BAR_PREFS_DEFAULTS));

    const { result } = renderHook(() => useUpdateStatusBarPrefs(), { wrapper });

    act(() => {
      result.current.setVisibility('git', false);
    });

    // Optimistic cache write (onMutate) flips only `git`.
    await waitFor(() =>
      expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar.git).toBe(
        false
      )
    );
    expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar.cwd).toBe(
      true
    );

    // A partial patch is sent (deep-merged server-side — no other key touched).
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(1));
    expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { statusBar: { git: false } } });
  });

  it('reset PATCHes the full defaults section', async () => {
    const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(
      configKeys.current(),
      makeServerConfig({ ...STATUS_BAR_PREFS_DEFAULTS, cwd: false, git: false })
    );

    const { result } = renderHook(() => useUpdateStatusBarPrefs(), { wrapper });

    act(() => {
      result.current.reset();
    });

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { statusBar: STATUS_BAR_PREFS_DEFAULTS },
      })
    );
    // Optimistic write restores every item to visible.
    await waitFor(() =>
      expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar).toEqual(
        STATUS_BAR_PREFS_DEFAULTS
      )
    );
  });

  it('rolls back to the snapshot when the transport write fails', async () => {
    let rejectWrite!: (err: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const transport = createMockTransport({
      updateConfig: vi.fn().mockReturnValue(pending),
    });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig(STATUS_BAR_PREFS_DEFAULTS));

    const { result } = renderHook(() => useUpdateStatusBarPrefs(), { wrapper });

    act(() => {
      result.current.setVisibility('cwd', false);
    });

    // Optimistic state is applied while the write is in flight.
    await waitFor(() =>
      expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar.cwd).toBe(
        false
      )
    );

    await act(async () => {
      rejectWrite(new Error('boom'));
      await pending.catch(() => {});
    });

    // Rolled back to the pre-mutation snapshot.
    await waitFor(() =>
      expect(queryClient.getQueryData<ServerConfig>(configKeys.current())!.ui!.statusBar.cwd).toBe(
        true
      )
    );
  });
});
