import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import type { FileListResponse } from '@dorkos/shared/types';

/** Fetch the file listing for a given working directory. */
export function useFiles(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<FileListResponse>({
    queryKey: ['files', { cwd: cwd ?? null }],
    queryFn: () => transport.listFiles(cwd!),
    enabled: !!cwd,
    staleTime: QUERY_TIMING.FILES_STALE_TIME_MS,
    gcTime: QUERY_TIMING.FILES_GC_TIME_MS,
  });
}
