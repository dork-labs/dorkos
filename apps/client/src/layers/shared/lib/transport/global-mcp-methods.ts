/**
 * Global MCP servers Transport method factory (DOR-3213).
 *
 * The app's side of `/api/mcp-servers`. These are plain calls: the window's `fetch` waits on
 * "Confirm it's you" for a held change, so a caller reads the change's own answer.
 *
 * @module shared/lib/transport/global-mcp-methods
 */
import type {
  GlobalMcpArgsCheckResult,
  GlobalMcpServerInput,
  GlobalMcpServerList,
  GlobalMcpServerPatch,
  GlobalMcpServerView,
  GlobalMcpStandingAllowList,
  GlobalMcpToolsCheck,
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

    checkGlobalMcpArgs(args: readonly string[]): Promise<GlobalMcpArgsCheckResult> {
      return fetchJSON(baseUrl, '/mcp-servers/check-args', {
        method: 'POST',
        body: JSON.stringify({ args }),
      });
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

    checkGlobalMcpServerTools(name: string): Promise<GlobalMcpToolsCheck> {
      // A POST: it may start the server, so no cross-site GET can (DOR-4118).
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}/tools`, {
        method: 'POST',
      });
    },

    listGlobalMcpStandingAllows(name: string): Promise<GlobalMcpStandingAllowList> {
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}/allows`);
    },

    undoGlobalMcpStandingAllow(name: string, agentId: string, rule: string): Promise<void> {
      return fetchNoContent(baseUrl, `/mcp-servers/${encodeURIComponent(name)}/allows`, {
        method: 'DELETE',
        body: JSON.stringify({ agentId, rule }),
      });
    },
  };
}
