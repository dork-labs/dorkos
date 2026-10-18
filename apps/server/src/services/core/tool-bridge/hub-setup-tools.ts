/**
 * Which DorkOS tools set up the hub, and so are refused to an agent working on
 * an agent computer (DOR-2939 part 6, `specs/everything-is-a-space/
 * design-agent-computers.md` §3).
 *
 * An agent computer runs agent code and packages, so the hub treats what it
 * sends as untrusted. Its agents keep their everyday tools (rooms, tasks,
 * messages, their own chat, running extensions), each run on the hub through
 * the normal gate. What they lose is the power to change the hub itself:
 *
 * - every `act` or `destructive` action whose area is one of
 *   {@link HUB_SETUP_AREAS} (settings, permissions, safety, packages,
 *   connections), so a tool added to those areas is a setup tool by default;
 * - and a named set ({@link HUB_SETUP_AGENT_ACTIONS}): creating, changing,
 *   registering and pausing agents, and routing document events. The rest of
 *   the `agents` area (starting a chat, scanning, the sidebar) stays agent work.
 *
 * Reads are never setup tools. The rule is worked out from tier and area,
 * never listed tool by tool, and `__tests__/hub-setup-tools.test.ts` pins its
 * answer for every registered capability and hand tool, so a change of tier or
 * area that moves a tool fails a test.
 *
 * DorkBot alone, and only once its owner granted it (`setup-grants-store.ts`),
 * may use the setup set from an agent computer, and only while it is the only
 * agent that works on that computer: everything on one computer can reach
 * everything else there, so a grant to DorkBot on a shared computer would be a
 * grant to every agent beside it. Its destructive calls still raise their card.
 *
 * The named set also takes in pausing and resuming an agent and routing
 * document events to one, whose area is none of the above.
 *
 * @module services/core/tool-bridge/hub-setup-tools
 */
import type { CapabilityTier } from '@dorkos/shared/capabilities';
import type { PermissionAreaId } from '@dorkos/shared/permissions';
import type { CapabilityDefinition } from '../capabilities/index.js';
import { MCP_TOOL_TIERS, gatedActionForMcpTool } from '../mcp-tool-tiers.js';

/** The areas whose `act` and `destructive` actions set up the hub. */
export const HUB_SETUP_AREAS: ReadonlySet<PermissionAreaId> = new Set<PermissionAreaId>([
  'settings',
  'permissions',
  'safety',
  'packages',
  'connections',
]);

/**
 * The actions outside those areas that set up the hub, by capability id or
 * hand tool name, whatever their area: what agents exist and how each is set
 * up, whether an agent is paused, and which document events reach an agent.
 */
export const HUB_SETUP_AGENT_ACTIONS: ReadonlySet<string> = new Set([
  'create_agent',
  'operator.update_agent',
  'operator.update_agent_execution',
  'mesh_register',
  'mesh_unregister',
  'mesh_deny',
  'agent.pause',
  'agent.resume',
  'ui.configure_doc_channel',
  'ui.approve_doc_route',
]);

/** The refusal an agent gets for a setup tool it may not use. */
export const HUB_SETUP_REFUSAL =
  'Only DorkBot, with your OK, can set things up from a cloud computer.';

/**
 * The refusal DorkBot gets, grant and all, while another agent works on its
 * computer: the grant reaches whatever runs there, so it holds only while
 * DorkBot is the only agent on it.
 */
export const DORKBOT_NEEDS_OWN_COMPUTER = "DorkBot's setup level needs its own cloud computer.";

/** The refusal code that rides beside {@link HUB_SETUP_REFUSAL}. */
export const HUB_SETUP_REFUSAL_CODE = 'setup_refused';

/** One action as the bridge sees it: a capability or a hand-registered tool. */
export interface BridgeAction {
  /** The capability id (`domain.verb`) or the hand tool's name. */
  readonly id: string;
  /** The name the agent calls it by. */
  readonly toolName: string;
  /** Human-facing title. */
  readonly title: string;
  /** Permission tier. */
  readonly tier: CapabilityTier;
  /** Permission area, or `null` when its tier alone decides. */
  readonly area: PermissionAreaId | null;
  /** The other areas one call reaches, decided from its input. */
  readonly areasForInput?: (input: unknown) => readonly PermissionAreaId[];
}

/** Whether a tier changes anything. */
function writes(tier: CapabilityTier): boolean {
  return tier === 'act' || tier === 'destructive';
}

/**
 * Whether an action sets up the hub, from its tier and area alone.
 *
 * @param action - The action's id, tier and area.
 */
export function isHubSetupAction(action: Pick<BridgeAction, 'id' | 'tier' | 'area'>): boolean {
  if (!writes(action.tier)) return false;
  if (action.area !== null && HUB_SETUP_AREAS.has(action.area)) return true;
  return HUB_SETUP_AGENT_ACTIONS.has(action.id);
}

/**
 * Whether one call sets up the hub: the action itself is a setup action, or
 * its input reaches a setup area (a settings patch that touches permissions).
 *
 * @param action - The action.
 * @param input - The call's input.
 */
export function isHubSetupCall(action: BridgeAction, input: unknown): boolean {
  if (isHubSetupAction(action)) return true;
  if (!writes(action.tier) || !action.areasForInput) return false;
  try {
    return action.areasForInput(input).some((area) => HUB_SETUP_AREAS.has(area));
  } catch {
    // An input the action cannot read reaches nothing it can name; the gate
    // refuses it on its own.
    return false;
  }
}

/** Who is calling a setup tool, as {@link hubSetupToolRefusal} reads it. */
export interface HubSetupCaller {
  /** Whether the calling agent is DorkBot (the system agent). */
  readonly agentIsDorkBot: boolean;
  /** Whether the owner granted DorkBot its setup level. */
  readonly setupGranted: boolean;
  /** Whether the calling agent is the only agent that works on its computer. */
  readonly aloneOnComputer: boolean;
}

/**
 * The refusal for a call from an agent computer, or `null` when it may go on
 * to the normal gate. A setup call runs only for DorkBot with its owner's
 * grant; every other agent is refused, grant or not.
 *
 * @param action - The action about to run.
 * @param who - Whether the caller is DorkBot, and whether it holds the grant.
 * @param input - The call's input, for an action whose reach depends on it.
 */
export function hubSetupToolRefusal(
  action: BridgeAction,
  who: HubSetupCaller,
  input?: unknown
): string | null {
  if (!isHubSetupCall(action, input)) return null;
  if (!who.agentIsDorkBot || !who.setupGranted) return HUB_SETUP_REFUSAL;
  return who.aloneOnComputer ? null : DORKBOT_NEEDS_OWN_COMPUTER;
}

/**
 * The bridge's view of a capability.
 *
 * @param capability - A registered capability.
 */
export function bridgeActionForCapability(capability: CapabilityDefinition): BridgeAction {
  return {
    id: capability.id,
    toolName: capability.surfaces.mcp?.toolName ?? capability.id,
    title: capability.title,
    tier: capability.tier,
    area: capability.area,
    ...(capability.areasForInput ? { areasForInput: capability.areasForInput } : {}),
  };
}

/**
 * A hand-registered MCP tool, as the bridge sees it.
 *
 * @param name - A name in `MCP_TOOL_TIERS`.
 */
function handToolBridgeAction(name: string): BridgeAction {
  const gated = gatedActionForMcpTool(name);
  return { id: name, toolName: name, title: gated.title, tier: gated.tier, area: gated.area };
}

/** Every hand-registered MCP tool, as the bridge sees it. */
export function handToolBridgeActions(): BridgeAction[] {
  return Object.keys(MCP_TOOL_TIERS).map(handToolBridgeAction);
}

/**
 * The action an agent means by a tool name: a capability by its MCP tool name
 * or its id, else a hand-registered tool, else `null`.
 *
 * @param tool - The name the agent called.
 * @param capabilities - The registered capabilities, extension tools included.
 */
export function bridgeActionFor(
  tool: string,
  capabilities: readonly CapabilityDefinition[]
): BridgeAction | null {
  const capability = capabilities.find(
    (candidate) => candidate.surfaces.mcp?.toolName === tool || candidate.id === tool
  );
  if (capability) return bridgeActionForCapability(capability);
  return Object.hasOwn(MCP_TOOL_TIERS, tool) ? handToolBridgeAction(tool) : null;
}

/** The request tool: it re-invokes the action an agent names in its input. */
export const REQUEST_ACCESS_CAPABILITY_ID = 'permissions.request_access';

/**
 * The tool a request-for-access call asks to run, by bare name, or `null` for
 * any other call. The bridge decides that tool too, so asking a person cannot
 * carry a setup tool past the refusal.
 *
 * @param action - The action being called.
 * @param input - Its input.
 */
export function forwardedToolName(action: BridgeAction, input: unknown): string | null {
  if (action.id !== REQUEST_ACCESS_CAPABILITY_ID) return null;
  const named =
    typeof input === 'object' && input !== null ? (input as { action?: unknown }).action : null;
  if (typeof named !== 'string' || named.length === 0) return null;
  // As the request tool reads it: an `mcp__server__tool` name means `tool`.
  return named.includes('__') ? named.slice(named.lastIndexOf('__') + 2) : named;
}
