import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { McpConfigResponse } from '@dorkos/shared/transport';

/**
 * Fetch MCP server entries from `.mcp.json` in the given project directory.
 * Returns an empty server list when the path is null or the file is absent.
 *
 * @param projectPath - Absolute path to the project directory, or null to skip.
 */
export function useMcpConfig(projectPath: string | null) {
  const transport = useTransport();
  return useQuery<McpConfigResponse>({
    queryKey: ['mcp-config', projectPath],
    queryFn: () => transport.getMcpConfig(projectPath!),
    enabled: !!projectPath,
    staleTime: 30_000,
  });
}
