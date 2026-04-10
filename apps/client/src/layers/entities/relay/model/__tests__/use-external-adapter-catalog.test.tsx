/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import type { CatalogEntry } from '@dorkos/shared/relay-schemas';
import {
  useExternalAdapterCatalog,
  ADAPTER_CATEGORY_INTERNAL,
} from '../use-external-adapter-catalog';

// --- Fixtures ---

function makeCatalogEntry(
  category: CatalogEntry['manifest']['category'],
  type: string = category
): CatalogEntry {
  return {
    manifest: {
      type,
      displayName: `${type} Adapter`,
      description: 'Test',
      category,
      builtin: true,
      configFields: [],
      multiInstance: false,
    },
    instances: [],
  };
}

// --- Tests ---

describe('useExternalAdapterCatalog', () => {
  let queryClient: QueryClient;
  let mockTransport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mockTransport = createMockTransport();
  });

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      </QueryClientProvider>
    );
  }

  it('filters out adapters with category: internal', async () => {
    /**
     * Verifies the hook strips `category: 'internal'` entries from the catalog.
     * This test is the primary regression guard for the Claude Code bug —
     * if anyone removes or weakens the filter, it will fail.
     */
    const catalogData: CatalogEntry[] = [
      makeCatalogEntry('messaging', 'telegram'),
      makeCatalogEntry('internal', 'claude-code'),
      makeCatalogEntry('automation', 'webhook'),
    ];
    mockTransport.getAdapterCatalog = vi.fn().mockResolvedValue(catalogData);

    const { result } = renderHook(() => useExternalAdapterCatalog(), { wrapper });

    // Wait for data to settle
    await vi.waitFor(() => {
      expect(result.current.data.length).toBeGreaterThan(0);
    });

    expect(result.current.data).toHaveLength(2);
    expect(result.current.data.map((e) => e.manifest.category)).not.toContain('internal');
    expect(result.current.data.map((e) => e.manifest.type)).toContain('telegram');
    expect(result.current.data.map((e) => e.manifest.type)).toContain('webhook');
    expect(result.current.data.map((e) => e.manifest.type)).not.toContain('claude-code');
  });

  it('returns a stable data reference when query data is unchanged', async () => {
    /**
     * Verifies that `data` keeps a stable reference when the underlying query
     * data does not change. This guards against re-render storms if a consumer
     * passes `data` into a `useEffect` dep list or a child component prop.
     */
    const catalogData: CatalogEntry[] = [makeCatalogEntry('messaging', 'telegram')];
    mockTransport.getAdapterCatalog = vi.fn().mockResolvedValue(catalogData);

    const { result, rerender } = renderHook(() => useExternalAdapterCatalog(), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.data.length).toBeGreaterThan(0);
    });

    const firstRef = result.current.data;
    rerender();
    const secondRef = result.current.data;

    // Same reference — memoization is working
    expect(firstRef).toBe(secondRef);
  });

  it('returns empty data when disabled', () => {
    /**
     * Verifies that when the Relay feature is disabled, the hook returns an
     * empty catalog and does not trigger a network request. This guards the
     * "Relay off" code path that ChannelsTab relies on for its empty state.
     */
    mockTransport.getAdapterCatalog = vi.fn();

    const { result } = renderHook(() => useExternalAdapterCatalog(false), { wrapper });

    expect(result.current.data).toEqual([]);
    expect(mockTransport.getAdapterCatalog).not.toHaveBeenCalled();
  });
});

describe('ADAPTER_CATEGORY_INTERNAL', () => {
  it('equals the string "internal"', () => {
    expect(ADAPTER_CATEGORY_INTERNAL).toBe('internal');
  });
});
