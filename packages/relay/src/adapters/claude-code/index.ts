/**
 * Claude Code adapter module.
 *
 * @module relay/adapters/claude-code
 */
export { ClaudeCodeAdapter, CLAUDE_CODE_MANIFEST } from './claude-code-adapter.js';
export type {
  ClaudeCodeAdapterConfig,
  ClaudeCodeAdapterDeps,
  AgentRuntimeLike,
  AgentSessionStoreLike,
  TasksStoreLike,
  RefusedAskReporter,
  ExecutionSettingsResolver,
  TurnDeskCheck,
  TurnRuntimeTypeResolver,
  SessionRuntimeBinder,
  TurnStartNote,
  TurnExecutionSettings,
  LateFollowEnd,
  LateTurn,
  LateTurnSource,
} from './types.js';
export type { ApprovalAuthorizer } from './approval-handler.js';
export { HTTP_RELAY_SENDER, TURN_SHAPING_PAYLOAD_FIELDS } from './turn-shaping-sender.js';
export { resolveAgentTurnIdentity } from './agent-handler.js';
export type { TraceStoreLike } from '../../types.js';
