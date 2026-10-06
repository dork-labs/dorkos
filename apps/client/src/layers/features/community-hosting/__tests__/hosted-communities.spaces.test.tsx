/**
 * @vitest-environment jsdom
 *
 * The hosted-community list while the spaces experiment is off (DOR-2740).
 *
 * The server refuses the route then, so the list must never be asked for, even
 * on a linked account. Fails if `useHostedCommunities` stops reading the switch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport, spacesExperiment, withSpacesExperiment } from '@dorkos/test-utils';
import { configKeys, TransportProvider } from '@/layers/shared/model';
import { useHostedCommunities } from '../model/hosted-communities';

afterEach(cleanup);

function mountWith(spaces: boolean) {
  const listHostedCommunities = vi
    .fn()
    .mockResolvedValue({ available: true, communities: [], moves: [], allowance: null });
  const transport = withSpacesExperiment(createMockTransport({ listHostedCommunities }), spaces);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The config has answered, so "off" below is a decision, not a wait.
  client.setQueryData(configKeys.current(), { experiments: spacesExperiment(spaces) });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  // Linked, so the only thing that can hold the read back is the experiment.
  const hook = renderHook(() => useHostedCommunities(true), { wrapper });
  return { hook, listHostedCommunities };
}

describe('useHostedCommunities and the spaces experiment', () => {
  it('never asks for the list while spaces are off', async () => {
    const { hook, listHostedCommunities } = mountWith(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(listHostedCommunities).not.toHaveBeenCalled();
    expect(hook.result.current.data).toBeUndefined();
  });

  it('asks for it once spaces are on (the control)', async () => {
    const { hook, listHostedCommunities } = mountWith(true);
    await waitFor(() => expect(hook.result.current.data?.available).toBe(true));
    expect(listHostedCommunities).toHaveBeenCalledTimes(1);
  });
});
