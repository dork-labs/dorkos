/**
 * Managed-MCP Transport methods factory (HTTP adapter) — per-agent MCP server
 * CRUD (spec `mcp-server-management` §7). Each verb rides its capability's own
 * REST path under `/api/agents/:agentId/mcp-servers`, which the server serves
 * from the capability's declaration, through the generated API client
 * (DOR-5473); the sign-in verbs and the browser preset declare no path, so they
 * ride `POST /api/capabilities/:id/invoke` by hand. Either
 * way the body is the capability's input (less what the path carries), the
 * response is the plain result, and a destructive verb answers `202` with a
 * {@link CapabilityApprovalRequired} payload when a person must approve first.
 * The approval token rides the `X-DorkOS-Approval` header on the confirming
 * retry.
 *
 * @module shared/lib/transport/mcp-methods
 */
import type {
  AddAgentMcpServerInput,
  AgentMcpMutationResult,
  AgentMcpTestResult,
  CapabilityApprovalRequired,
  ImportAgentMcpServerInput,
  McpClientCredentials,
  McpSigninPollResult,
  StartMcpSigninResult,
  UpdateAgentMcpServerInput,
} from '@dorkos/shared/transport';
import type { ManagedMcpServer, ManagedMcpServerView } from '@dorkos/shared/mesh-schemas';
import type { AgentBrowserPreset } from '@dorkos/shared/agent-browser';
import { LIST_PAGE_LIMIT, readAllPages } from '../read-all-pages';
import { createTransportApiClient } from './api-client';
import { fetchJSON } from './http-client';

/** The header a confirming retry carries its approval token in (matches the server). */
const APPROVAL_TOKEN_HEADER = 'X-DorkOS-Approval';

/**
 * The two body shapes a capability call can return: the capability's own
 * result `T`, or the approval-required envelope. They are disjoint at runtime —
 * the envelope is a non-array object with `status: 'approval_required'` — so a
 * `T` that is an array (the managed-server list) never collides with it.
 */
type CapabilityInvokeBody<T> = T | CapabilityApprovalRequired;

/** Narrow a capability response to the approval-required envelope. */
function isApprovalRequired(body: unknown): body is CapabilityApprovalRequired {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { status?: unknown }).status === 'approval_required'
  );
}

/** The approval token header of a confirming retry; none on a first call. */
function approvalHeaders(approvalToken?: string): { headers?: Record<string, string> } {
  return approvalToken ? { headers: { [APPROVAL_TOKEN_HEADER]: approvalToken } } : {};
}

/**
 * Read a destructive verb's answer. The client treats both `200` and `202` as
 * OK, so the two outcomes are told apart by the body's shape, not the status.
 */
async function mutation(sent: Promise<unknown>): Promise<AgentMcpMutationResult> {
  const answer = (await sent) as CapabilityInvokeBody<ManagedMcpServer[]>;
  if (isApprovalRequired(answer)) {
    return { status: 'approval_required', approval: answer };
  }
  return { status: 'ok', servers: answer };
}

/** Create the managed-MCP methods bound to a base URL. */
export function createMcpMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);

  /** Run a capability that declares no REST path, through the invoke endpoint. */
  function invokeCapability<T>(id: string, input: unknown): Promise<T> {
    return fetchJSON<T>(baseUrl, `/capabilities/${id}/invoke`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * Run a path-only verb (import, enable, disable, test) by hand: each sends a
   * `{}` body the API document does not describe (DOR-5473).
   */
  function postEmpty<T>(agentId: string, name: string, verb: string, approvalToken?: string) {
    const path = `/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(name)}`;
    return fetchJSON<T>(baseUrl, `${path}/${verb}`, {
      method: 'POST',
      body: '{}',
      ...approvalHeaders(approvalToken),
    });
  }

  return {
    // The list comes in pages, in the agent's own order (DOR-4982); the tab shows it whole.
    async listAgentMcpServers(agentId: string): Promise<ManagedMcpServerView[]> {
      type Page = { servers: ManagedMcpServerView[]; nextCursor: string | null };
      const { rows } = await readAllPages(
        async (cursor) =>
          (await api.call('mcp.list', {
            path: { agentId },
            query: { cursor, limit: LIST_PAGE_LIMIT },
          })) as Page,
        (page) => page.servers,
        `/agents/${encodeURIComponent(agentId)}/mcp-servers`
      );
      return rows;
    },

    getAgentBrowserPreset(): Promise<AgentBrowserPreset> {
      return invokeCapability<AgentBrowserPreset>('mcp.browser_preset', {});
    },

    addAgentMcpServer(
      { agentId, ...server }: AddAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      const headers = approvalHeaders(opts?.approvalToken);
      return mutation(api.call('mcp.add', { path: { agentId }, body: server, ...headers }));
    },

    importAgentMcpServer(
      { agentId, name }: ImportAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return mutation(postEmpty(agentId, name, 'import', opts?.approvalToken));
    },

    updateAgentMcpServer(
      { agentId, name, ...patch }: UpdateAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      const headers = approvalHeaders(opts?.approvalToken);
      return mutation(api.call('mcp.update', { path: { agentId, name }, body: patch, ...headers }));
    },

    async removeAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return (await api.call('mcp.remove', { path: { agentId, name } })) as ManagedMcpServer[];
    },

    enableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return postEmpty<ManagedMcpServer[]>(agentId, name, 'enable');
    },

    disableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return postEmpty<ManagedMcpServer[]>(agentId, name, 'disable');
    },

    testAgentMcpServer(agentId: string, name: string): Promise<AgentMcpTestResult> {
      return postEmpty<AgentMcpTestResult>(agentId, name, 'test');
    },

    startMcpSignin(agentId: string, name: string): Promise<StartMcpSigninResult> {
      return invokeCapability<StartMcpSigninResult>('mcp.signin', { agentId, name });
    },

    pollMcpSignin(flowId: string): Promise<McpSigninPollResult> {
      return invokeCapability<McpSigninPollResult>('mcp.poll_signin', { flowId });
    },

    async setMcpClientCredentials(
      agentId: string,
      name: string,
      credentials: McpClientCredentials
    ): Promise<void> {
      await api.call('mcp.set_client', {
        path: { agentId, name },
        body: {
          clientId: credentials.clientId,
          // Omitted rather than sent empty: the capability's input rejects an empty
          // secret, and "no secret" is the normal case for a public client.
          ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
        },
      });
    },
  };
}
