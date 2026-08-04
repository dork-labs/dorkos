import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { Transport } from '@dorkos/shared/transport';
import type {
  AddAgentMcpServerInput,
  AgentMcpMutationResult,
  AgentMcpTestResult,
  CapabilityApprovalRequired,
  ImportAgentMcpServerInput,
  UpdateAgentMcpServerInput,
} from '@dorkos/shared/transport';
import type { ManagedMcpServer } from '@dorkos/shared/mesh-schemas';
import { agentKeys } from '../api/queries';

/**
 * Refresh the managed roster and the live MCP status after a config change: the
 * managed list ({@link agentKeys.mcpServers}) and every `mcp-config` query
 * (keyed by project path + runtime, which a mutation does not know).
 */
function invalidateAgentMcp(queryClient: QueryClient, agentId: string): void {
  void queryClient.invalidateQueries({ queryKey: agentKeys.mcpServers(agentId) });
  void queryClient.invalidateQueries({ queryKey: ['mcp-config'] });
}

/** Variables for a destructive add/update: the input, plus the approval on the confirming retry. */
interface DestructiveVars<TInput> {
  /** The capability input. */
  input: TInput;
  /** Present on the confirming retry — grant it, then retry with its token. */
  approval?: CapabilityApprovalRequired;
}

/**
 * Run a destructive managed-MCP verb, folding the operator's own approval into
 * the mutation: with an `approval` present it grants it first (the operator IS
 * the approver) then retries with the token; otherwise it makes the first call,
 * whose result may be `{ status: 'approval_required' }` for the caller to confirm.
 */
function useDestructiveMcpMutation<TInput extends { agentId: string }>(
  run: (
    transport: Transport,
    input: TInput,
    approvalToken?: string
  ) => Promise<AgentMcpMutationResult>
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<AgentMcpMutationResult, Error, DestructiveVars<TInput>>({
    mutationFn: async ({ input, approval }) => {
      if (approval) {
        await transport.grantApproval(approval.approvalId);
        return run(transport, input, approval.approvalToken);
      }
      return run(transport, input);
    },
    onSuccess: (result, { input }) => {
      if (result.status === 'ok') invalidateAgentMcp(queryClient, input.agentId);
    },
  });
}

/**
 * Add a managed MCP server to an agent (destructive `mcp.add`). The first call
 * may resolve to `{ status: 'approval_required' }`; pass the returned `approval`
 * back in to grant and complete the write.
 */
export function useAddAgentMcpServer() {
  return useDestructiveMcpMutation<AddAgentMcpServerInput>((transport, input, approvalToken) =>
    transport.addAgentMcpServer(input, approvalToken ? { approvalToken } : undefined)
  );
}

/**
 * Import a discovered `.mcp.json` server into DorkOS management (destructive
 * `mcp.import`). The server-side handler resolves the connection from the name,
 * so the input carries only `{ agentId, name }`; the approval → grant → retry
 * flow is identical to {@link useAddAgentMcpServer}. On success both the managed
 * list and the discovered/live roster are invalidated, so the row moves from
 * discovered to managed.
 */
export function useImportAgentMcpServer() {
  return useDestructiveMcpMutation<ImportAgentMcpServerInput>((transport, input, approvalToken) =>
    transport.importAgentMcpServer(input, approvalToken ? { approvalToken } : undefined)
  );
}

/**
 * Update a managed MCP server (destructive `mcp.update`). Changing the
 * connection re-prompts approval, handled the same way as {@link useAddAgentMcpServer}.
 */
export function useUpdateAgentMcpServer() {
  return useDestructiveMcpMutation<UpdateAgentMcpServerInput>((transport, input, approvalToken) =>
    transport.updateAgentMcpServer(input, approvalToken ? { approvalToken } : undefined)
  );
}

/** Variables shared by the act-tier single-server verbs. */
interface ServerVars {
  /** ULID of the owning agent. */
  agentId: string;
  /** Name of the target server. */
  name: string;
}

/** Build an act-tier mutation (remove/enable/disable) that refreshes the roster on success. */
function useServerActionMutation(
  action: (transport: Transport, agentId: string, name: string) => Promise<ManagedMcpServer[]>
) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation<ManagedMcpServer[], Error, ServerVars>({
    mutationFn: ({ agentId, name }) => action(transport, agentId, name),
    onSuccess: (_result, { agentId }) => invalidateAgentMcp(queryClient, agentId),
  });
}

/** Remove a managed MCP server (`mcp.remove`). Reversible, so not approval-gated. */
export function useRemoveAgentMcpServer() {
  return useServerActionMutation((transport, agentId, name) =>
    transport.removeAgentMcpServer(agentId, name)
  );
}

/** Enable a managed MCP server (`mcp.enable`). */
export function useEnableAgentMcpServer() {
  return useServerActionMutation((transport, agentId, name) =>
    transport.enableAgentMcpServer(agentId, name)
  );
}

/** Disable a managed MCP server (`mcp.disable`). */
export function useDisableAgentMcpServer() {
  return useServerActionMutation((transport, agentId, name) =>
    transport.disableAgentMcpServer(agentId, name)
  );
}

/**
 * Probe a managed MCP server (`mcp.test`): whether it connects and how many
 * tools it exposes. Read-only, so it invalidates nothing.
 */
export function useTestAgentMcpServer() {
  const transport = useTransport();
  return useMutation<AgentMcpTestResult, Error, ServerVars>({
    mutationFn: ({ agentId, name }) => transport.testAgentMcpServer(agentId, name),
  });
}
