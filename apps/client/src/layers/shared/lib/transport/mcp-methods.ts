/**
 * Managed-MCP Transport methods factory (HTTP adapter) — per-agent MCP server
 * CRUD (spec `mcp-server-management` §7). Each verb rides its capability's own
 * REST path under `/api/agents/:agentId/mcp-servers`, which the server serves
 * from the capability's declaration; the sign-in verbs and the browser preset
 * declare no path, so they ride `POST /api/capabilities/:id/invoke`. Either
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
import { fetchAllPages, fetchJSON } from './http-client';

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

/** The path of an agent's managed servers, or of one of them. */
function serversPath(agentId: string, name?: string): string {
  const base = `/agents/${encodeURIComponent(agentId)}/mcp-servers`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

/** Create the managed-MCP methods bound to a base URL. */
export function createMcpMethods(baseUrl: string) {
  /**
   * Call one capability's route. `fetchJSON` treats both `200` and `202` as OK
   * (`res.ok`), so the two outcomes are disambiguated by the body shape, not the
   * status code.
   */
  function callCapability<T>(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    body?: unknown,
    approvalToken?: string
  ): Promise<CapabilityInvokeBody<T>> {
    return fetchJSON<CapabilityInvokeBody<T>>(baseUrl, path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // Overriding `headers` replaces `fetchJSON`'s default wholesale, so
      // `Content-Type` must be restated alongside the approval token.
      ...(approvalToken
        ? {
            headers: { 'Content-Type': 'application/json', [APPROVAL_TOKEN_HEADER]: approvalToken },
          }
        : {}),
    });
  }

  /** Run a capability that declares no REST path, through the invoke endpoint. */
  function invokeCapability<T>(id: string, input: unknown): Promise<T> {
    return callCapability<T>(`/capabilities/${id}/invoke`, 'POST', input) as Promise<T>;
  }

  /** Run a destructive verb, mapping the two possible bodies to the result union. */
  async function mutation(
    path: string,
    method: 'POST' | 'PATCH',
    body: unknown,
    approvalToken?: string
  ): Promise<AgentMcpMutationResult> {
    const answer = await callCapability<ManagedMcpServer[]>(path, method, body, approvalToken);
    if (isApprovalRequired(answer)) {
      return { status: 'approval_required', approval: answer };
    }
    return { status: 'ok', servers: answer };
  }

  return {
    // The list comes in pages, in the agent's own order (DOR-4982); the tab shows it whole.
    async listAgentMcpServers(agentId: string): Promise<ManagedMcpServerView[]> {
      type Page = { servers: ManagedMcpServerView[]; nextCursor: string | null };
      const path = serversPath(agentId);
      return (await fetchAllPages(baseUrl, path, {}, (page: Page) => page.servers)).rows;
    },

    getAgentBrowserPreset(): Promise<AgentBrowserPreset> {
      return invokeCapability<AgentBrowserPreset>('mcp.browser_preset', {});
    },

    addAgentMcpServer(
      { agentId, ...server }: AddAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return mutation(serversPath(agentId), 'POST', server, opts?.approvalToken);
    },

    importAgentMcpServer(
      { agentId, name }: ImportAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return mutation(`${serversPath(agentId, name)}/import`, 'POST', {}, opts?.approvalToken);
    },

    updateAgentMcpServer(
      { agentId, name, ...patch }: UpdateAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return mutation(serversPath(agentId, name), 'PATCH', patch, opts?.approvalToken);
    },

    removeAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return callCapability<ManagedMcpServer[]>(serversPath(agentId, name), 'DELETE') as Promise<
        ManagedMcpServer[]
      >;
    },

    enableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return callCapability<ManagedMcpServer[]>(
        `${serversPath(agentId, name)}/enable`,
        'POST',
        {}
      ) as Promise<ManagedMcpServer[]>;
    },

    disableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return callCapability<ManagedMcpServer[]>(
        `${serversPath(agentId, name)}/disable`,
        'POST',
        {}
      ) as Promise<ManagedMcpServer[]>;
    },

    testAgentMcpServer(agentId: string, name: string): Promise<AgentMcpTestResult> {
      return callCapability<AgentMcpTestResult>(
        `${serversPath(agentId, name)}/test`,
        'POST',
        {}
      ) as Promise<AgentMcpTestResult>;
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
      await callCapability(`${serversPath(agentId, name)}/client`, 'PUT', {
        clientId: credentials.clientId,
        // Omitted rather than sent empty: the capability's input rejects an empty
        // secret, and "no secret" is the normal case for a public client.
        ...(credentials.clientSecret ? { clientSecret: credentials.clientSecret } : {}),
      });
    },
  };
}
