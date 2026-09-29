import { useQuery } from '@tanstack/react-query';
import type { ProjectInfo } from '@dorkos/shared/project-schemas';
import { useTransport } from '@/layers/shared/model';
import { projectKeys } from '../api/queries';

/**
 * Every project this machine knows whose folder exists, by name (spec
 * `flow-multiproject` §6.1).
 *
 * @returns The TanStack query for the list.
 */
export function useProjects() {
  const transport = useTransport();
  return useQuery<ProjectInfo[]>({
    queryKey: projectKeys.list(),
    queryFn: () => transport.listProjects(),
    staleTime: 60_000,
  });
}
