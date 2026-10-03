/**
 * @vitest-environment jsdom
 *
 * Changing who pays by default changes the model menu of every session left on
 * the default, so a credits choice refreshes the model caches (DOR-2636).
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '../../TransportContext';
import { MODELS_KEY } from '../../../lib/models-query-key';
import { useSetCreditsDefault } from '../use-cloud-credits';

describe('useSetCreditsDefault', () => {
  it('refreshes every model menu once the choice is saved', async () => {
    const transport = createMockTransport({
      setCloudCreditsDefault: vi.fn().mockResolvedValue({ enabled: true }),
    });
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useSetCreditsDefault(), { wrapper });

    await act(() => result.current.mutateAsync({ runtime: 'claude-code', useCredits: true }));

    expect(invalidate).toHaveBeenCalledWith({ queryKey: MODELS_KEY });
  });
});
