/**
 * What only the hub may do to an agent computer, in one table (DOR-2940,
 * `specs/everything-is-a-space/design-agent-computers.md`).
 *
 * An agent computer runs a hub's agents. Who those agents are, what they may
 * do, what is installed and what is scheduled are the hub's to decide, so an
 * agent working there cannot change them for itself. Two lists say which:
 *
 * - {@link HUB_OWNED_ACTIONS}: capability ids and hand-registered MCP tool
 *   names. Every gate that runs an action asks
 *   {@link agentComputerActionRefusal} first: `registry.invoke` (every
 *   registry capability, trusted callers included) and `runGate` in
 *   `mcp-tool-gate.ts` (every hand-registered tool, on both MCP servers).
 *   Every `destructive` action is refused there too: it waits for a person's
 *   approval, and nobody on an agent computer can give one, so it answers at
 *   once instead of hanging.
 * - The writes an agent may make over HTTP are the other way round: every
 *   write is refused unless `./agent-writes.ts` lists it, so a route added
 *   later is the hub's until someone decides otherwise. That covers every
 *   route that writes settings, connections, schedules and sign-ins.
 *
 * The event streams are refused by a list of their paths in the agent gate
 * (`./agent-gate.ts`); they are reads, so a new stream is open to agents
 * until it is added there.
 *
 * Left alone on purpose: the terminal (its socket is authorized by an id a
 * gated route mints, and an agent already has a shell here) and A2A (its own
 * authorizer, `middleware/mcp-auth.ts`, decides it as it decides `/mcp`).
 *
 * @module services/core/agent-computer/hub-owned
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { TierDeniedPayload } from '../capabilities/tier-enforcement.js';
import { isAgentComputer } from '../server-role/role-checks.js';

/** The refusal code of every write or action an agent computer refuses. */
export const HUB_OWNED_CODE = 'AGENT_COMPUTER_HUB_OWNED';

/**
 * Actions only the hub may take on an agent computer, by capability id or
 * MCP tool name, each with what it changes.
 */
export const HUB_OWNED_ACTIONS: ReadonlyMap<string, string> = new Map([
  ['create_agent', 'agents'],
  ['operator.update_agent', 'agents'],
  ['operator.update_agent_boundaries', 'agents'],
  ['operator.update_agent_execution', 'agents'],
  ['mesh_register', 'agents'],
  ['mesh_unregister', 'agents'],
  ['mesh_deny', 'agents'],
  ['tasks_create', 'schedules'],
  ['tasks_update', 'schedules'],
  ['tasks_delete', 'schedules'],
  ['create_extension', 'extensions'],
  ['reload_extensions', 'extensions'],
  ['test_extension', 'extensions'],
  ['marketplace.install', 'packages'],
  ['marketplace.update', 'packages'],
  ['marketplace.uninstall', 'packages'],
  ['marketplace.link', 'packages'],
  ['permissions.change', 'permissions'],
  ['permissions.request_access', 'permissions'],
  ['operator.config_patch', 'settings'],
  ['mcp.add', 'MCP servers'],
  ['mcp.import', 'MCP servers'],
  ['mcp.update', 'MCP servers'],
  ['mcp.enable', 'MCP servers'],
  ['mcp.disable', 'MCP servers'],
  ['mcp.remove', 'MCP servers'],
  ['mcp.test', 'MCP servers'],
  ['mcp.browser_preset', 'MCP servers'],
  ['mcp.signin', 'sign-ins'],
  ['mcp.set_client', 'sign-ins'],
  ['connectors.request_connection', 'connections'],
  ['relay_enable_adapter', 'connections'],
  ['relay_disable_adapter', 'connections'],
  ['relay_reload_adapters', 'connections'],
  ['binding_create', 'connections'],
  ['binding_delete', 'connections'],
]);

/** The sentence a refused hub-owned action carries. */
function hubOwnedMessage(what: string): string {
  return `This is an agent computer. Only its hub changes its ${what}.`;
}

/** The facts about an action {@link agentComputerActionRefusal} reads. */
export interface SealableAction {
  /** Capability id or MCP tool name. */
  readonly id: string;
  /** Human-facing title. */
  readonly title: string;
  /** Permission tier. */
  readonly tier: CapabilityTier;
}

/**
 * The refusal for an action on an agent computer, or `null` when it may go
 * on. Refused: every hub-owned action, and every `destructive` one, since
 * nobody there can approve it. Never approvable, so an agent does not ask
 * again.
 *
 * Carried as a `permission_blocked` denial, the shape every surface already
 * renders (a `403` over HTTP, an error result over MCP).
 *
 * @param action - The action about to run.
 */
export function agentComputerActionRefusal(action: SealableAction): TierDeniedPayload | null {
  if (!isAgentComputer()) return null;
  const what = HUB_OWNED_ACTIONS.get(action.id);
  if (what === undefined && action.tier !== 'destructive') return null;
  return {
    status: 'denied',
    capabilityId: action.id,
    capabilityTitle: action.title,
    tier: action.tier,
    reason: 'permission_blocked',
    approvable: false,
    message:
      what === undefined
        ? 'This is an agent computer. Nobody here can approve this, so it does not run.'
        : hubOwnedMessage(what),
  };
}
