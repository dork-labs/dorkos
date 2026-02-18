import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import { ROADMAP_ITEMS_KEY } from './use-roadmap-items';
import { ROADMAP_META_KEY } from './use-roadmap-meta';

/** Delete a roadmap item by ID and invalidate items + meta queries on success. */
export function useDeleteItem() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/items/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROADMAP_ITEMS_KEY });
      queryClient.invalidateQueries({ queryKey: ROADMAP_META_KEY });
    },
  });
}
