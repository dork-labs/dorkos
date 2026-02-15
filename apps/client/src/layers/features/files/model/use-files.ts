import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { FileListResponse } from '@dorkos/shared/types';

export function useFiles(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<FileListResponse>({
    queryKey: ['files', { cwd: cwd ?? null }],
    queryFn: () => transport.listFiles(cwd!),
    enabled: !!cwd,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
