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
  ExecutionSettingsResolver,
  TurnExecutionSettings,
} from './types.js';
export type { TraceStoreLike } from '../../types.js';
