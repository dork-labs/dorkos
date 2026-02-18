import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import type { CreateItemRequest, RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { ROADMAP_ITEMS_KEY } from './use-roadmap-items';
import { ROADMAP_META_KEY } from './use-roadmap-meta';

/** Create a new roadmap item and invalidate items + meta queries on success. */
export function useCreateItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: CreateItemRequest) =>
      apiClient.post<RoadmapItem>('/items', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROADMAP_ITEMS_KEY });
      queryClient.invalidateQueries({ queryKey: ROADMAP_META_KEY });
    },
  });
}
