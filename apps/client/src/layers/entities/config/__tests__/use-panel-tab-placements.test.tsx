/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type { ServerConfig } from '@dorkos/shared/types';
import type { MiniAppPlacement, SavedPlacement } from '@dorkos/shared/mini-app-placement';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import {
  usePanelTabPlacements,
  useSetPanelTabPlacement,
  withPanelTabPlacement,
} from '../model/use-panel-tab-placements';

/** A placement that shows in exactly the named rooms. */
function inRooms(...rooms: string[]): MiniAppPlacement {
  return {
    show: { agents: [], rooms, pages: [] },
    hide: { agents: [], rooms: [], pages: [] },
  };
}

function saved(tab: string, placement: MiniAppPlacement): SavedPlacement {
  return { tab, ...placement };
}

function makeServerConfig(panelTabs: SavedPlacement[]): ServerConfig {
  return { ui: { panelTabs, theme: 'dark' } } as unknown as ServerConfig;
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

function cachedPanelTabs(queryClient: QueryClient): readonly SavedPlacement[] | undefined {
  return queryClient.getQueryData<ServerConfig>(configKeys.current())?.ui?.panelTabs;
}

describe('withPanelTabPlacement', () => {
  const a = saved('ext-a:tab', inRooms('R1'));
  const b = saved('ext-b:tab', inRooms('R2'));
  const c = saved('ext-c:tab', inRooms('R3'));

  it('appends a tab that has no saved choice yet', () => {
    const next = withPanelTabPlacement([a, b], 'ext-c:tab', inRooms('R3'));
    expect(next).toEqual([a, b, c]);
  });

  it('replaces an existing choice in place, keeping the order of the others', () => {
    const next = withPanelTabPlacement([a, b, c], 'ext-b:tab', inRooms('R9'));
    expect(next.map((entry) => entry.tab)).toEqual(['ext-a:tab', 'ext-b:tab', 'ext-c:tab']);
    expect(next[1]).toEqual(saved('ext-b:tab', inRooms('R9')));
    expect(next[0]).toBe(a);
    expect(next[2]).toBe(c);
  });

  it('replaces the first entry in place', () => {
    const next = withPanelTabPlacement([a, b, c], 'ext-a:tab', inRooms('R9'));
    expect(next).toEqual([saved('ext-a:tab', inRooms('R9')), b, c]);
  });

  it('removes the saved choice when the placement is null', () => {
    expect(withPanelTabPlacement([a, b, c], 'ext-b:tab', null)).toEqual([a, c]);
  });

  it('leaves the list unchanged when removing a tab that has no choice', () => {
    expect(withPanelTabPlacement([a, b], 'ext-z:tab', null)).toEqual([a, b]);
  });

  it('never mutates the list it was given', () => {
    const list = Object.freeze([a, b]) as readonly SavedPlacement[];
    expect(() => withPanelTabPlacement(list, 'ext-a:tab', inRooms('R9'))).not.toThrow();
    expect(list).toEqual([a, b]);
  });
});

describe('usePanelTabPlacements', () => {
  it('is empty while config has not loaded', () => {
    const transport = createMockTransport({
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { wrapper } = createHarness(transport);
    const { result } = renderHook(() => usePanelTabPlacements(), { wrapper });
    expect(result.current).toEqual([]);
  });

  it('reads `ui.panelTabs` from the loaded config', () => {
    const transport = createMockTransport({
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);
    const entry = saved('ext-a:tab', inRooms('R1'));
    queryClient.setQueryData(configKeys.current(), makeServerConfig([entry]));
    const { result } = renderHook(() => usePanelTabPlacements(), { wrapper });
    expect(result.current).toEqual([entry]);
  });
});

describe('useSetPanelTabPlacement', () => {
  it('sends the whole list with one entry changed and updates the cache first', async () => {
    let resolveWrite!: () => void;
    const write = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const transport = createMockTransport({
      updateConfig: vi.fn().mockReturnValue(write),
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);
    const a = saved('ext-a:tab', inRooms('R1'));
    const b = saved('ext-b:tab', inRooms('R2'));
    const c = saved('ext-c:tab', inRooms('R3'));
    queryClient.setQueryData(configKeys.current(), makeServerConfig([a, b, c]));

    const { result } = renderHook(() => useSetPanelTabPlacement(), { wrapper });

    act(() => {
      result.current.setPlacement('ext-b:tab', inRooms('R7'));
    });

    const expected = [a, saved('ext-b:tab', inRooms('R7')), c];

    // Optimistic: the cache holds the new list while the write is still in flight.
    await waitFor(() => expect(cachedPanelTabs(queryClient)).toEqual(expected));
    expect(result.current.isPending).toBe(true);
    // Other `ui` keys survive the optimistic write.
    expect(queryClient.getQueryData<ServerConfig>(configKeys.current())?.ui).toMatchObject({
      theme: 'dark',
    });

    expect(transport.updateConfig).toHaveBeenCalledTimes(1);
    expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { panelTabs: expected } });

    await act(async () => {
      resolveWrite();
      await write;
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });

  it('drops a saved choice with null, sending the list without it', async () => {
    const transport = createMockTransport({
      updateConfig: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);
    const a = saved('ext-a:tab', inRooms('R1'));
    const b = saved('ext-b:tab', inRooms('R2'));
    queryClient.setQueryData(configKeys.current(), makeServerConfig([a, b]));

    const { result } = renderHook(() => useSetPanelTabPlacement(), { wrapper });
    act(() => {
      result.current.setPlacement('ext-a:tab', null);
    });

    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { panelTabs: [b] } })
    );
    expect(cachedPanelTabs(queryClient)).toEqual([b]);
  });

  it('builds each write from the cache, so two quick changes both land', async () => {
    const transport = createMockTransport({
      updateConfig: vi.fn(() => new Promise<void>(() => {})),
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);
    queryClient.setQueryData(configKeys.current(), makeServerConfig([]));

    const { result } = renderHook(() => useSetPanelTabPlacement(), { wrapper });
    act(() => {
      result.current.setPlacement('ext-a:tab', inRooms('R1'));
    });
    await waitFor(() => expect(cachedPanelTabs(queryClient)).toHaveLength(1));
    act(() => {
      result.current.setPlacement('ext-b:tab', inRooms('R2'));
    });

    const both = [saved('ext-a:tab', inRooms('R1')), saved('ext-b:tab', inRooms('R2'))];
    await waitFor(() => expect(transport.updateConfig).toHaveBeenCalledTimes(2));
    expect(transport.updateConfig).toHaveBeenLastCalledWith({ ui: { panelTabs: both } });
    expect(cachedPanelTabs(queryClient)).toEqual(both);
  });

  it('rolls the cache back when the write fails', async () => {
    let rejectWrite!: (err: Error) => void;
    const write = new Promise<void>((_resolve, reject) => {
      rejectWrite = reject;
    });
    const transport = createMockTransport({
      updateConfig: vi.fn().mockReturnValue(write),
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);
    const a = saved('ext-a:tab', inRooms('R1'));
    queryClient.setQueryData(configKeys.current(), makeServerConfig([a]));

    const { result } = renderHook(() => useSetPanelTabPlacement(), { wrapper });
    act(() => {
      result.current.setPlacement('ext-a:tab', null);
    });
    await waitFor(() => expect(cachedPanelTabs(queryClient)).toEqual([]));

    await act(async () => {
      rejectWrite(new Error('boom'));
      await write.catch(() => {});
    });

    await waitFor(() => expect(cachedPanelTabs(queryClient)).toEqual([a]));
  });

  it('writes nothing before config has loaded, so no saved choice is erased', () => {
    const transport = createMockTransport({
      updateConfig: vi.fn().mockResolvedValue(undefined),
      getConfig: vi.fn(() => new Promise<ServerConfig>(() => {})),
    });
    const { queryClient, wrapper } = createHarness(transport);

    const { result } = renderHook(() => useSetPanelTabPlacement(), { wrapper });
    act(() => {
      result.current.setPlacement('ext-a:tab', inRooms('R1'));
    });

    expect(transport.updateConfig).not.toHaveBeenCalled();
    expect(cachedPanelTabs(queryClient)).toBeUndefined();
  });
});
