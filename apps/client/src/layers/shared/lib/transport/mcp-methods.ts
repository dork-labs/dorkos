/**
 * Managed-MCP Transport methods factory (HTTP adapter) — per-agent MCP server
 * CRUD over the generic capability-invoke path (spec `mcp-server-management`
 * §7). Every verb rides `POST /api/capabilities/:id/invoke`: the body is the
 * capability's raw input, the response is the plain result, and a destructive
 * verb answers `202` with a {@link CapabilityApprovalRequired} payload when a
 * person must approve first.
 *
 * The client never calls a dedicated `/api/agents/:id/mcp-servers` route — those
 * are not mounted. The generic invoke endpoint is the working path, and the
 * approval token rides the `X-DorkOS-Approval` header on the confirming retry.
 *
 * @module shared/lib/transport/mcp-methods
 */
import type {
  AddAgentMcpServerInput,
  AgentMcpMutationResult,
  AgentMcpTestResult,
  CapabilityApprovalRequired,
  UpdateAgentMcpServerInput,
} from '@dorkos/shared/transport';
import type { ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import { fetchJSON } from './http-client';

/** The header a confirming retry carries its approval token in (matches the server). */
const APPROVAL_TOKEN_HEADER = 'X-DorkOS-Approval';

/**
 * The two body shapes a capability invoke can return: the capability's own
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

/** Create the managed-MCP methods bound to a base URL. */
export function createMcpMethods(baseUrl: string) {
  /**
   * Invoke a capability by id. `fetchJSON` treats both `200` and `202` as OK
   * (`res.ok`), so the two outcomes are disambiguated by the body shape, not the
   * status code.
   */
  function invokeCapability<T>(
    id: string,
    input: unknown,
    approvalToken?: string
  ): Promise<CapabilityInvokeBody<T>> {
    return fetchJSON<CapabilityInvokeBody<T>>(baseUrl, `/capabilities/${id}/invoke`, {
      method: 'POST',
      body: JSON.stringify(input),
      // Overriding `headers` replaces `fetchJSON`'s default wholesale, so
      // `Content-Type` must be restated alongside the approval token.
      ...(approvalToken
        ? {
            headers: { 'Content-Type': 'application/json', [APPROVAL_TOKEN_HEADER]: approvalToken },
          }
        : {}),
    });
  }

  /** Run a destructive verb, mapping the two possible bodies to the result union. */
  async function invokeMutation(
    id: string,
    input: unknown,
    approvalToken?: string
  ): Promise<AgentMcpMutationResult> {
    const body = await invokeCapability<ManagedMcpServer[]>(id, input, approvalToken);
    if (isApprovalRequired(body)) {
      return { status: 'approval_required', approval: body };
    }
    return { status: 'ok', servers: body };
  }

  return {
    listAgentMcpServers(agentId: string): Promise<ManagedMcpServer[]> {
      return invokeCapability<ManagedMcpServer[]>('mcp.list', { agentId }).then(
        (body) => body as ManagedMcpServer[]
      );
    },

    addAgentMcpServer(
      input: AddAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return invokeMutation('mcp.add', input, opts?.approvalToken);
    },

    updateAgentMcpServer(
      input: UpdateAgentMcpServerInput,
      opts?: { approvalToken?: string }
    ): Promise<AgentMcpMutationResult> {
      return invokeMutation('mcp.update', input, opts?.approvalToken);
    },

    removeAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return invokeCapability<ManagedMcpServer[]>('mcp.remove', { agentId, name }).then(
        (body) => body as ManagedMcpServer[]
      );
    },

    enableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return invokeCapability<ManagedMcpServer[]>('mcp.enable', { agentId, name }).then(
        (body) => body as ManagedMcpServer[]
      );
    },

    disableAgentMcpServer(agentId: string, name: string): Promise<ManagedMcpServer[]> {
      return invokeCapability<ManagedMcpServer[]>('mcp.disable', { agentId, name }).then(
        (body) => body as ManagedMcpServer[]
      );
    },

    testAgentMcpServer(agentId: string, name: string): Promise<AgentMcpTestResult> {
      return invokeCapability<AgentMcpTestResult>('mcp.test', { agentId, name }).then(
        (body) => body as AgentMcpTestResult
      );
    },
  };
}
