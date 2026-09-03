// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import { MODELS_KEY } from '@/layers/shared/lib';
import { TransportProvider } from '@/layers/shared/model';
import { useStoreOpenRouterKey } from '../model/use-openrouter-connect';
import { useConnectOllama, useConnectDirectProvider } from '../model/use-opencode-provider';
import { useGuidedOllamaPull } from '../model/use-guided-ollama-pull';
import { useProvisionOllama } from '../model/use-provision-ollama';
// The credential/login hooks moved down to `entities/runtime` (DOR-1651): the
// chat auth-error card signs in too, and a feature may not reach into a
// sibling feature's model.
import {
  useProvisionRuntime,
  useStoreRuntimeCredential,
  useDelegateRuntimeLogin,
} from '@/layers/entities/runtime';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A cached model catalog, keyed exactly the way `modelsQueryOptions` keys it. */
const CACHED_CATALOG_KEY = [...MODELS_KEY, null, null] as const;

/**
 * Render a connect hook with a query client whose model catalog is already
 * cached, so a test can ask whether the connection marked it stale.
 */
function renderConnectHook<T>(
  hook: () => T,
  overrides: Partial<Parameters<typeof createMockTransport>[0]> = {}
) {
  const transport = createMockTransport(overrides);
  const queryClient = new QueryClient({
    // gcTime must NOT be 0 here: the cached catalog has no observer in a hook
    // test, and a zero gcTime would collect it before the mutation could mark
    // it stale — the assertion would then pass for the wrong reason.
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 30 * 60 * 1000 },
      mutations: { retry: false },
    },
  });
  // Warm the catalog: the bug is that a 30-minute staleTime kept THIS entry
  // being served after the connection changed what the server would return.
  queryClient.setQueryData(CACHED_CATALOG_KEY, [
    { value: 'stale/model', displayName: 'Stale', description: '' },
  ]);

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  const rendered = renderHook(hook, { wrapper });
  const catalogInvalidated = () =>
    queryClient.getQueryState([...CACHED_CATALOG_KEY])?.isInvalidated === true;
  return { ...rendered, transport, queryClient, catalogInvalidated };
}

describe('model catalog invalidation on connect (DOR-1660)', () => {
  it('refreshes the catalog after a runtime API key is stored', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() =>
      useStoreRuntimeCredential('claude-code')
    );
    expect(catalogInvalidated()).toBe(false);

    act(() => result.current.store('sk-test'));

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after a delegated vendor login', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() =>
      useDelegateRuntimeLogin('codex')
    );

    act(() => result.current.login());

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after an OpenRouter key unlocks the frontier list', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useStoreOpenRouterKey());

    act(() => result.current.store('sk-or-test'));

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after selecting a local Ollama model', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useConnectOllama());

    act(() => result.current.connect('qwen2.5-coder:7b'));

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after a direct provider key is stored', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useConnectDirectProvider());

    act(() => result.current.connect({ providerId: 'openai', key: 'sk-test' }));

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after a guided Ollama pull adds a model', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useGuidedOllamaPull(), {
      pullOllamaModel: vi.fn().mockResolvedValue({ ok: true }),
    });

    act(() => result.current.pull('qwen2.5-coder:7b'));

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after Ollama is installed', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useProvisionOllama(), {
      provisionOllama: vi.fn().mockResolvedValue({ ok: true }),
    });

    act(() => result.current.provision());

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('refreshes the catalog after a runtime binary is installed', async () => {
    // Installing the binary is what gives a runtime a catalog at all — before
    // it, getSupportedModels() answers []. This one needed MODELS_KEY to live in
    // `shared`: an entity may not import a sibling entity, so while the key sat
    // in entities/session this call site could not reach it.
    const { result, catalogInvalidated } = renderConnectHook(() => useProvisionRuntime('opencode'));

    act(() => result.current.provision());

    await waitFor(() => expect(catalogInvalidated()).toBe(true));
  });

  it('leaves the catalog alone when the connection fails', async () => {
    const { result, catalogInvalidated } = renderConnectHook(() => useStoreOpenRouterKey(), {
      storeOpenRouterKey: vi.fn().mockResolvedValue({ ok: false, error: 'nope' }),
    });

    act(() => result.current.store('sk-or-bad'));

    await waitFor(() => expect(result.current.isError).toBe(true));
    // A rejected key changed nothing, so the cached menu is still correct.
    expect(catalogInvalidated()).toBe(false);
  });
});
