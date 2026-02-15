import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/lib';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';

export function useGitStatus(cwd: string | null) {
  const transport = useTransport();

  return useQuery({
    queryKey: ['git-status', cwd],
    queryFn: () => transport.getGitStatus(cwd ?? undefined),
    enabled: !!cwd,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    staleTime: 5_000,
  });
}

export function isGitStatusOk(
  data: GitStatusResponse | GitStatusError | undefined,
): data is GitStatusResponse {
  return !!data && !('error' in data);
}
