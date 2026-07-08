/**
 * Fetch a `ui://` MCP App resource for rendering (spec `mcp-apps-host` §2.1).
 * Thin wrapper over `transport.fetchMcpAppResource`; the server performs the
 * actual MCP read and returns the HTML plus sandbox metadata. Cached by
 * `(sessionId, serverName, uri)` — App resources are effectively immutable for
 * the life of a tool result.
 *
 * @module features/mcp-apps/model/use-mcp-app-resource
 */
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { McpAppResourceResponse } from '@dorkos/shared/schemas';

/**
 * Read a `ui://` MCP App resource. Disabled until `enabled` is true so rendering
 * can wait behind first-use consent (no fetch happens before the user agrees).
 *
 * @param params - The owning `sessionId`, the `serverName`, the `ui://` `uri`,
 *   and whether the fetch is `enabled` (defaults to true).
 */
export function useMcpAppResource(params: {
  sessionId: string;
  serverName: string;
  uri: string;
  enabled?: boolean;
}) {
  const transport = useTransport();
  const { sessionId, serverName, uri, enabled = true } = params;

  return useQuery<McpAppResourceResponse>({
    queryKey: ['mcp-app-resource', sessionId, serverName, uri],
    queryFn: () => transport.fetchMcpAppResource(sessionId, { serverName, uri }),
    enabled: enabled && Boolean(sessionId && serverName && uri),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
