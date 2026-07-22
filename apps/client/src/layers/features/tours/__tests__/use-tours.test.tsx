/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';

import { useTours } from '../model/use-tours';
import { useTourStore } from '../model/tour-store';

function createWrapper(transport = createMockTransport()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

function transportWithTours(tours: { seen?: string[]; declined?: string[] }) {
  const transport = createMockTransport();
  vi.mocked(transport.getConfig).mockResolvedValue({
    tours: { seen: tours.seen ?? [], declined: tours.declined ?? [] },
  } as never);
  return transport;
}

beforeEach(() => {
  vi.clearAllMocks();
  useTourStore.setState({ runningTourId: null, activeIndex: 0, pendingOfferId: null });
});

describe('useTours', () => {
  it('runTour launches the general tour on demand', async () => {
    const { result } = renderHook(() => useTours(), { wrapper: createWrapper() });
    act(() => result.current.runTour('general'));
    expect(result.current.runningDefinition?.id).toBe('general');
    expect(result.current.activeIndex).toBe(0);
  });

  it('acceptOffer marks the tour seen and runs it', async () => {
    const transport = transportWithTours({ seen: [] });
    const { result } = renderHook(() => useTours(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current.seen).toEqual([]));

    act(() => result.current.acceptOffer('tasks'));

    expect(result.current.runningDefinition?.id).toBe('tasks');
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ tours: { seen: ['tasks'] } })
    );
  });

  it('declineOffer marks the tour declined and withdraws the offer', async () => {
    const transport = transportWithTours({ declined: [] });
    useTourStore.setState({ pendingOfferId: 'relay' });
    const { result } = renderHook(() => useTours(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current.declined).toEqual([]));

    act(() => result.current.declineOffer('relay'));

    expect(useTourStore.getState().pendingOfferId).toBeNull();
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ tours: { declined: ['relay'] } })
    );
  });

  it('isSuppressed reflects both seen and declined', async () => {
    const transport = transportWithTours({ seen: ['tasks'], declined: ['mesh'] });
    const { result } = renderHook(() => useTours(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current.seen).toEqual(['tasks']));

    expect(result.current.isSuppressed('tasks')).toBe(true);
    expect(result.current.isSuppressed('mesh')).toBe(true);
    expect(result.current.isSuppressed('relay')).toBe(false);
  });

  it('does not re-write an already seen tour', async () => {
    const transport = transportWithTours({ seen: ['tasks'] });
    const { result } = renderHook(() => useTours(), { wrapper: createWrapper(transport) });
    await waitFor(() => expect(result.current.seen).toEqual(['tasks']));

    act(() => result.current.acceptOffer('tasks'));
    expect(transport.updateConfig).not.toHaveBeenCalled();
  });
});
