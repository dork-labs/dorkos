/**
 * What the DorkOS card's Model row offers (spec `one-minute-onboarding` §6.5):
 * the credits catalog only while credits are in use and nothing is configured;
 * an own setup names its model; with neither, nothing to choose.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DoeInferenceStatus } from '@dorkos/shared/runtime-connect';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { doeModelRowCopy, useDoeModelRow } from '../model/use-doe-model-row';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const CATALOG = {
  endpoint: 'https://credits.example/anthropic',
  models: [
    { id: 'm-pick', displayName: 'Pick', contextWindow: 200_000, maxOutputTokens: 16_000 },
    { id: 'm-other', displayName: 'Other', contextWindow: 100_000, maxOutputTokens: 8_000 },
  ],
};

function setup(status: DoeInferenceStatus, enabled = true) {
  const transport = createMockTransport({
    getDoeInference: vi.fn().mockResolvedValue(status),
    getDoeCreditsModels: vi.fn().mockResolvedValue(CATALOG),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const hook = renderHook(() => useDoeModelRow(enabled), { wrapper });
  return { transport, hook };
}

describe('useDoeModelRow', () => {
  it('offers the catalog in the format DorkOS picks in while credits are in use', async () => {
    const { transport, hook } = setup({
      inference: null,
      hasKey: false,
      autoProtocol: 'openai-responses',
    });
    await waitFor(() => expect(hook.result.current.models).toHaveLength(2));
    expect(transport.getDoeCreditsModels).toHaveBeenCalledWith('openai-responses');
    expect(hook.result.current.state).toBe('credits');
  });

  it('has nothing to offer when credits are not in use and nothing is set up', async () => {
    const { transport, hook } = setup({ inference: null, hasKey: false, autoProtocol: null });
    await waitFor(() => expect(hook.result.current.state).toBe('none'));
    expect(transport.getDoeCreditsModels).not.toHaveBeenCalled();
  });

  it('leaves an own-key setup to its form and reads no catalog', async () => {
    const { transport, hook } = setup({
      inference: {
        source: 'api-key',
        provider: 'openai',
        protocol: 'openai-chat-completions',
        endpoint: 'https://api.openai.com/v1',
        model: 'own-model',
        contextWindow: 8192,
        maxOutputTokens: 1024,
      },
      hasKey: true,
      autoProtocol: 'anthropic-messages',
    });
    await waitFor(() => expect(hook.result.current.state).toBe('own'));
    expect(transport.getDoeCreditsModels).not.toHaveBeenCalled();
  });

  it('reads nothing on another runtime’s card', () => {
    const { transport, hook } = setup(
      { inference: null, hasKey: false, autoProtocol: null },
      false
    );
    expect(hook.result.current.state).toBeNull();
    expect(transport.getDoeInference).not.toHaveBeenCalled();
  });

  it('says "Chosen by DorkOS" only while DorkOS picks', () => {
    expect(doeModelRowCopy('credits').inheritLabel).toBe('Chosen by DorkOS');
    expect(doeModelRowCopy('none').inheritLabel).not.toBe('Chosen by DorkOS');
    expect(doeModelRowCopy('own').inheritLabel).toBeUndefined();
  });
});
