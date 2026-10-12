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
  AgentDmModeResolver,
  ExecutionSettingsResolver,
  TurnDeskCheck,
  TurnRuntimeTypeResolver,
  SessionRuntimeBinder,
  TurnExecutionSettings,
  LateFollowEnd,
  LateTurn,
  LateTurnSource,
} from './types.js';
export type { ApprovalAuthorizer } from './approval-handler.js';
export type { TraceStoreLike } from '../../types.js';
