/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRoadmapItems, ROADMAP_ITEMS_KEY } from '../model/use-roadmap-items';
import { useRoadmapMeta, ROADMAP_META_KEY } from '../model/use-roadmap-meta';
import { useCreateItem } from '../model/use-create-item';
import { useDeleteItem } from '../model/use-delete-item';
import { createMockRoadmapItem } from '@dorkos/test-utils';

// Mock apiClient
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/layers/shared/lib', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    patch: vi.fn(),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useRoadmapItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches items from /items endpoint', async () => {
    const items = [createMockRoadmapItem({ title: 'Item A' })];
    mockGet.mockResolvedValue(items);

    const { result } = renderHook(() => useRoadmapItems(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(items);
    });

    expect(mockGet).toHaveBeenCalledWith('/items');
  });

  it('exports the correct query key', () => {
    expect(ROADMAP_ITEMS_KEY).toEqual(['roadmap-items']);
  });
});

describe('useRoadmapMeta', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches meta from /meta endpoint', async () => {
    const meta = { projectName: 'Test', projectSummary: '', lastUpdated: '2025-01-01T00:00:00.000Z', timeHorizons: { now: { label: 'Now', description: '' }, next: { label: 'Next', description: '' }, later: { label: 'Later', description: '' } } };
    mockGet.mockResolvedValue(meta);

    const { result } = renderHook(() => useRoadmapMeta(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toEqual(meta);
    });

    expect(mockGet).toHaveBeenCalledWith('/meta');
  });

  it('exports the correct query key', () => {
    expect(ROADMAP_META_KEY).toEqual(['roadmap-meta']);
  });
});

describe('useCreateItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts to /items endpoint', async () => {
    const newItem = createMockRoadmapItem({ title: 'Created' });
    mockPost.mockResolvedValue(newItem);

    const { result } = renderHook(() => useCreateItem(), {
      wrapper: createWrapper(),
    });

    result.current.mutate({
      title: 'Created',
      type: 'feature',
      moscow: 'must-have',
      status: 'not-started',
      health: 'on-track',
      timeHorizon: 'now',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockPost).toHaveBeenCalledWith('/items', expect.objectContaining({ title: 'Created' }));
  });
});

describe('useDeleteItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls delete endpoint with item id', async () => {
    mockDelete.mockResolvedValue(undefined);

    const { result } = renderHook(() => useDeleteItem(), {
      wrapper: createWrapper(),
    });

    result.current.mutate('test-id-123');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockDelete).toHaveBeenCalledWith('/items/test-id-123');
  });
});
