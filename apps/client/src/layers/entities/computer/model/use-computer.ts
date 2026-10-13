import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export const COMPUTER_QUERY_KEY = ['computer', 'local'] as const;

/** Reconcile lifecycle observations without assuming an action means readiness. */
export function useComputer() {
  const transport = useTransport();
  return useQuery({
    queryKey: COMPUTER_QUERY_KEY,
    queryFn: () => transport.getComputer(),
    networkMode: 'always',
    refetchInterval: 2000,
    retry: false,
  });
}
