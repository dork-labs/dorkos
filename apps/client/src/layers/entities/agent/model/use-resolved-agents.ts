import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { agentKeys } from '../api/queries';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

/**
 * Batch resolve agents for multiple paths.
 * Used by DirectoryPicker to show agent names in the recents list.
 *
 * @param paths - Array of directory paths to resolve
 * @param options.enabled - Ask the server at all. `false` holds the query idle
 *   for a caller that is mounted but not drawing anything.
 */
export function useResolvedAgents(paths: string[], options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery<Record<string, AgentManifest | null>>({
    queryKey: agentKeys.resolved(paths),
    queryFn: () => transport.resolveAgents(paths),
    // Nothing to ask about, or a caller that is mounted but not drawing
    // anything (see `useMeshAgentPaths`' own `enabled`).
    enabled: paths.length > 0 && (options.enabled ?? true),
    staleTime: 60_000,
  });
}
