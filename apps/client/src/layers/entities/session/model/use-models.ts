import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ModelOption } from '@dorkos/shared/types';

/** Fetch available models from the server. Long staleTime since models rarely change. */
export function useModels() {
  const transport = useTransport();

  return useQuery<ModelOption[]>({
    queryKey: ['models'],
    queryFn: () => transport.getModels(),
    staleTime: 30 * 60 * 1000,
  });
}
