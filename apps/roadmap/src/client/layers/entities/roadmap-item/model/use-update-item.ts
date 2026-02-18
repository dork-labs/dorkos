import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import type { UpdateItemRequest, RoadmapItem } from '@dorkos/shared/roadmap-schemas';
import { ROADMAP_ITEMS_KEY } from './use-roadmap-items';
import { ROADMAP_META_KEY } from './use-roadmap-meta';

interface UpdateItemArgs {
  id: string;
  body: UpdateItemRequest;
}

/** Update a roadmap item by ID and invalidate items + meta queries on success. */
export function useUpdateItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, body }: UpdateItemArgs) =>
      apiClient.patch<RoadmapItem>(`/items/${id}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROADMAP_ITEMS_KEY });
      queryClient.invalidateQueries({ queryKey: ROADMAP_META_KEY });
    },
  });
}
