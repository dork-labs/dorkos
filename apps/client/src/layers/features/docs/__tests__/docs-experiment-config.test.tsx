/**
 * @vitest-environment jsdom
 *
 * The Docs gate end to end: no mock of the experiment hook. A server config
 * whose `experiments` list carries `docs.enabled` (what the Settings →
 * Experiments row, DOR-2982, makes the server send) goes through the real
 * `useConfig` → `isExperimentEnabled` path to the editor props and the save
 * action.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, renderHook, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMockTransport } from '@dorkos/test-utils';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys, TransportProvider } from '@/layers/shared/model';
import { useDocEmbeds } from '../model/use-doc-embeds';
import { DOC_EMBEDS } from '../ui/doc-embed-registry';
import { SaveAsWebPageButton } from '../ui/SaveAsWebPageButton';

afterEach(cleanup);

/** A server config as it arrives, with the Docs experiment listed on or off. */
function configWithDocs(enabled: boolean | undefined): ServerConfig {
  return {
    experiments:
      enabled === undefined
        ? []
        : [{ key: 'docs.enabled', title: 'Docs', description: '', enabled, lockedByEnv: false }],
  } as unknown as ServerConfig;
}

/** Providers serving that config from the cache and the transport alike. */
function withConfig(config: ServerConfig) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(configKeys.current(), config);
  const transport = createMockTransport({ getConfig: vi.fn().mockResolvedValue(config) });
  return function Providers({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={transport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  };
}

describe('the docs.enabled experiment, read from the server config', () => {
  it('hands the editor the embeds and shows Save as web page when it is on', () => {
    const wrapper = withConfig(configWithDocs(true));
    expect(renderHook(() => useDocEmbeds(true), { wrapper }).result.current).toBe(DOC_EMBEDS);
    render(<SaveAsWebPageButton markdown="# Doc" sourcePath="doc.md" />, { wrapper });
    expect(screen.getByRole('button', { name: 'Save as web page' })).toBeInTheDocument();
  });

  it.each([
    ['off', false],
    ['not registered yet', undefined],
  ])('passes nothing when it is %s', (_label, enabled) => {
    const wrapper = withConfig(configWithDocs(enabled));
    expect(renderHook(() => useDocEmbeds(true), { wrapper }).result.current).toBeUndefined();
    render(<SaveAsWebPageButton markdown="# Doc" sourcePath="doc.md" />, { wrapper });
    expect(screen.queryByRole('button', { name: 'Save as web page' })).not.toBeInTheDocument();
  });
});
