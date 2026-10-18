/**
 * The hub's side of the tool bridge (DOR-2939 part 6, `specs/everything-is-
 * a-space/design-agent-computers.md` §3): running an agent computer's DorkOS
 * tool calls on the hub as that agent, refusing the hub's setup tools to all
 * but DorkBot with its owner's grant, and the owner-only grants file.
 *
 * @module services/core/tool-bridge
 */
export {
  HUB_SETUP_AGENT_ACTIONS,
  HUB_SETUP_AREAS,
  HUB_SETUP_REFUSAL,
  HUB_SETUP_REFUSAL_CODE,
  bridgeActionFor,
  bridgeActionForCapability,
  handToolBridgeActions,
  hubSetupToolRefusal,
  isHubSetupAction,
  isHubSetupCall,
  type BridgeAction,
  type HubSetupCaller,
} from './hub-setup-tools.js';
export {
  AgentPairBodySchema,
  AgentPairSchema,
  DorkBotSetupBodySchema,
  MAX_AGENT_PAIRS,
  NO_SETUP_GRANTS,
  SetupGrantsSchema,
  allowAgentPair,
  isPairAllowed,
  readSetupGrants,
  removeAgentPair,
  setDorkBotSetupGrant,
  setupGrantsPath,
  type AgentPair,
  type SetupGrants,
  type SetupGrantsWriteOptions,
} from './setup-grants-store.js';
export { tierForCrossComputerTurn, type CrossComputerTurnTier } from './pair-allowance.js';
export {
  AGENT_COMPUTER_CALLER,
  handleBridgedToolCall,
  handleBridgedToolList,
  type BridgedAgent,
  type BridgedCallOrigin,
  type BridgedRefusal,
  type BridgedToolCall,
  type BridgedToolDeps,
  type BridgedToolListResult,
  type BridgedToolRun,
  type BridgedToolRunner,
  type BridgedTurn,
} from './bridged-tool-call.js';
export { createMcpBridgedToolRunner, outcomeOfToolResult } from './mcp-tool-runner.js';
export {
  BRIDGE_CALLS_PER_COMPUTER_PER_MINUTE,
  BRIDGE_CALLS_PER_TURN_PER_MINUTE,
  createBridgedToolRateLimits,
  type BridgedToolRateLimits,
} from './bridge-guards.js';
