import { useQuery } from '@tanstack/react-query';
import type { HarnessStatusResponse } from '@dorkos/shared/harness-schemas';
import { useTransport } from '@/layers/shared/model';
import { harnessKeys } from '../api/query-keys';

/**
 * Read what every agent tool does with every agent file in one project.
 *
 * `staleTime` matches the marketplace hooks beside it: the answer is three
 * filesystem walks, and a person who opens the page twice inside half a minute
 * is looking at the same tree. It still refetches on mount, because the tree is
 * edited by agents between visits and a stale chip is the one failure this whole
 * page exists to end.
 *
 * @param projectPath - The agent's project directory, absolute.
 */
export function useHarnessStatus(projectPath: string) {
  const transport = useTransport();
  return useQuery<HarnessStatusResponse>({
    queryKey: harnessKeys.status(projectPath),
    queryFn: () => transport.getHarnessStatus(projectPath),
    staleTime: 30_000,
    refetchOnMount: 'always',
  });
}
