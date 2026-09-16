import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** Local query keys; refs keep different communities' otherwise identical IDs separate. */
export const communityKeys = {
  all: ['communities'] as const,
  connections: ['communities', 'connections'] as const,
  approval: (ref: string) => ['communities', ref, 'approval'] as const,
  remote: (ref: string) => ['communities', ref] as const,
};

/** Read only browser-safe descriptors from the local server. */
export function useCommunityConnections(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: communityKeys.connections,
    queryFn: () => transport.listCommunityConnections(),
    enabled,
  });
}
