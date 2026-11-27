/**
 * Global MCP servers Transport method factory (DOR-3213).
 *
 * The app's side of `/api/mcp-servers`. These are plain calls: the window's `fetch` waits on
 * "Confirm it's you" for a held change, so a caller reads the change's own answer. Documented
 * calls go through the generated API client (DOR-5473).
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
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/**
 * Create the global MCP server methods bound to a base URL.
 *
 * @param baseUrl - Server base URL (already includes `/api`).
 */
export function createGlobalMcpMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    // Stays hand-written: `GET /api/mcp-servers` has no operationId (DOR-5473).
    listGlobalMcpServers(): Promise<GlobalMcpServerList> {
      return fetchJSON(baseUrl, '/mcp-servers');
    },

    async checkGlobalMcpArgs(args: readonly string[]): Promise<GlobalMcpArgsCheckResult> {
      const answer = await api.call('mcp.check_global_args', { body: { args: [...args] } });
      // The document also lists the capability mount's 202 approval answer, which
      // the window's `fetch` waits through; the cast keeps today's type.
      return answer as GlobalMcpArgsCheckResult;
    },

    async addGlobalMcpServer(input: GlobalMcpServerInput): Promise<GlobalMcpServerView> {
      const answer = await api.call('mcp.add_global_server', { body: input });
      return answer as GlobalMcpServerView;
    },

    // Stays hand-written: `PATCH /api/mcp-servers/{name}` has no operationId (DOR-5473).
    patchGlobalMcpServer(name: string, patch: GlobalMcpServerPatch): Promise<GlobalMcpServerView> {
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
    },

    async removeGlobalMcpServer(name: string): Promise<void> {
      await api.call('mcp.remove_global_server', { path: { name } });
    },

    // Stays hand-written: a bodyless write, waits for batch 3's no-body client (DOR-5473).
    checkGlobalMcpServerTools(name: string): Promise<GlobalMcpToolsCheck> {
      // A POST: it may start the server, so no cross-site GET can (DOR-4118).
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}/tools`, {
        method: 'POST',
      });
    },

    // Stays hand-written: `GET /api/mcp-servers/{name}/allows` has no operationId (DOR-5473).
    listGlobalMcpStandingAllows(name: string): Promise<GlobalMcpStandingAllowList> {
      return fetchJSON(baseUrl, `/mcp-servers/${encodeURIComponent(name)}/allows`);
    },

    async undoGlobalMcpStandingAllow(name: string, agentId: string, rule: string): Promise<void> {
      // A DELETE carries no body: the agent and the rule go in the query string.
      await api.call('mcp.undo_global_allow', { path: { name }, query: { agentId, rule } });
    },
  };
}
