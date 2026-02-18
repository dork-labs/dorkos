import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import type { RoadmapMeta } from '@dorkos/shared/roadmap-schemas';

/** TanStack Query key for the roadmap metadata. */
export const ROADMAP_META_KEY = ['roadmap-meta'] as const;

/** Fetch and cache the roadmap project metadata from the server. */
export function useRoadmapMeta() {
  return useQuery({
    queryKey: ROADMAP_META_KEY,
    queryFn: () => apiClient.get<RoadmapMeta>('/meta'),
  });
}
