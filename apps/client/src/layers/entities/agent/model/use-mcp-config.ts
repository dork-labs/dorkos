import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { McpConfigResponse } from '@dorkos/shared/transport';

/**
 * Fetch MCP server entries for the given project directory.
 * Returns an empty server list when the path is null or the file is absent.
 *
 * @param projectPath - Absolute path to the project directory, or null to skip.
 * @param runtime - Optional runtime type (e.g. `'codex'`) that owns the agent.
 *   Scopes the MCP list to the runtime so a Codex agent sees its own servers
 *   rather than the default runtime's, and keys the cache so switching runtime
 *   refetches instead of serving a stale list.
 */
export function useMcpConfig(projectPath: string | null, runtime?: string | null) {
  const transport = useTransport();
  return useQuery<McpConfigResponse>({
    queryKey: ['mcp-config', projectPath, runtime ?? null],
    queryFn: () => transport.getMcpConfig(projectPath!, { runtime: runtime ?? undefined }),
    enabled: !!projectPath,
    staleTime: 30_000,
  });
}
