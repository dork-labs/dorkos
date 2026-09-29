import { useQuery } from '@tanstack/react-query';
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import { useTransport } from '@/layers/shared/model';
import { projectKeys } from '../api/queries';

/** What {@link useProjectForCwd} answers. */
export interface ProjectForCwd {
  /** The folder's project, or null for no project, a refused folder, or while resolving. */
  project: ProjectRef | null;
  /** True until the server has answered for this folder. */
  isResolving: boolean;
}

/**
 * The project a folder belongs to: its git main checkout (spec
 * `flow-multiproject` §6.4).
 *
 * Asked once per folder and kept for the life of the tab (`staleTime:
 * Infinity`): which repository a folder sits in does not change while you look
 * at it, and the server caches the answer too. A folder the server refuses
 * (outside the directory boundary) reads as no project rather than an error,
 * because nothing a person can do here would change the answer.
 *
 * @param cwd - The folder, or null when there is none.
 */
export function useProjectForCwd(cwd: string | null | undefined): ProjectForCwd {
  const transport = useTransport();
  const query = useQuery({
    queryKey: projectKeys.forCwd(cwd ?? ''),
    queryFn: () => transport.resolveProject(cwd as string),
    enabled: Boolean(cwd),
    staleTime: Infinity,
    retry: false,
  });
  return {
    project: query.data ?? null,
    isResolving: Boolean(cwd) && query.isPending,
  };
}
