import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

/** TanStack Query key for the roadmap items list. */
export const ROADMAP_ITEMS_KEY = ['roadmap-items'] as const;

/** Fetch and cache the full list of roadmap items from the server. */
export function useRoadmapItems() {
  return useQuery({
    queryKey: ROADMAP_ITEMS_KEY,
    queryFn: () => apiClient.get<RoadmapItem[]>('/items'),
  });
}
