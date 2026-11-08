/**
 * Global MCP servers Transport method factory (DOR-3213).
 *
 * The app's side of `/api/mcp-servers`. These are plain calls: the window's `fetch` waits on
 * "Confirm it's you" for a held change, so a caller reads the change's own answer.
 *
 * @module shared/lib/transport/global-mcp-methods
 */
import type {
  GlobalMcpServerInput,
  GlobalMcpServerList,
  GlobalMcpServerPatch,
  GlobalMcpServerView,
} from '@dorkos/shared/global-mcp-schemas';
import { fetchJSON, fetchNoContent } from './http-client';

/**
 * Create the global MCP server methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createGlobalMcpMethods(baseUrl: string) {
  return {
    listGlobalMcpServers(): Promise<GlobalMcpServerList> {
      return fetchJSON(baseUrl, '/mcp-servers');
    },

    addGlobalMcpServer(input: GlobalMcpServerInput): Promise<GlobalMcpServerView> {
      return fetchJSON(baseUrl, '/mcp-servers', { method: 'POST', body: JSON.stringify(input) });
    },

    patchGlobalMcpServer(name: string, patch: GlobalMcpServerPatch): Promise<GlobalMcpServerView> {
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    removeGlobalMcpServer(name: string): Promise<void> {
      return fetchNoContent(baseUrl, `/mcp-servers/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
    },
  };
}
