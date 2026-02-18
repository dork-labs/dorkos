import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/layers/shared/lib';
import type { ReorderRequest } from '@dorkos/shared/roadmap-schemas';
import { ROADMAP_ITEMS_KEY } from './use-roadmap-items';

/** Reorder roadmap items and invalidate the items query on success. */
export function useReorderItems() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: ReorderRequest) =>
      apiClient.post<void>('/items/reorder', body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ROADMAP_ITEMS_KEY });
    },
  });
}
