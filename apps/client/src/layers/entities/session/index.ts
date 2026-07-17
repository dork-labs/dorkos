/**
 * Session entity — domain hooks for session lifecycle, ID routing, and directory state.
 *
 * @module entities/session
 */
export { useSessions, useSessionListWarnings, insertOptimisticSession } from './model/use-sessions';
export { useAgentSessions } from './model/use-agent-sessions';
export { selectAgentSessions } from './lib/select-agent-sessions';
// Context-health — the one client source for context percent, thresholds, and severity.
export {
  CONTEXT_WARNING_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
  contextSeverity,
  deriveContextPercent,
  resolveDisplayContextPercent,
} from './lib/context-health';
export type { ContextSeverity } from './lib/context-health';
export { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from './lib/session-display-title';
export { useSessionRuntime } from './model/use-session-runtime';
export { useSessionId } from './model/use-session-id';
export type { SetSessionIdOptions } from './model/use-session-id';
export { useSessionStatus } from './model/use-session-status';
export type { SessionStatusData } from './model/use-session-status';
export { useDefaultCwd } from './model/use-default-cwd';
export { useDirectoryState } from './model/use-directory-state';
export type { SetDirOptions } from './model/use-directory-state';
export { useModels } from './model/use-models';
export { useSubagents } from './model/use-subagents';
export { useSessionSearch } from './model/use-session-search';
export {
  useSessionChatStore,
  useSessionChatState,
  useSessionMessages,
  useSessionStatus as useSessionChatStatus,
  useHasConfirmedAuto,
  DEFAULT_SESSION_STATE,
} from './model/session-chat-store';
export type { SessionState } from './model/session-chat-store';
// Session-stream infrastructure (spec chat-stream-reconnection, Phase 3).
export {
  useSessionStreamStore,
  useSessionStreamState,
  useSessionStreamStatus,
  useSessionStreamConnection,
  useSessionQueue,
  DEFAULT_SESSION_STREAM_STATE,
} from './model/session-stream-store';
export type { SessionStreamState, QueuedMessage } from './model/session-stream-store';
export {
  useSessionListStore,
  useSessionListSessions,
  useSessionListStatus,
  useSessionContextReading,
  useSessionRekeyTarget,
} from './model/session-list-store';
export type { SessionContextReading } from './model/session-list-store';
export {
  initSessionStreamBinding,
  resetSessionStreamBinding,
} from './model/session-stream-binding';
export { useGlobalSessionStream } from './model/use-global-session-stream';

export { useSessionBorderState } from './model/use-session-border-state';
export type { SessionBorderKind, SessionBorderState } from './model/use-session-border-state';
export { useAgentHottestStatus } from './model/use-agent-hottest-status';
// Context-health merge resolver (list vs live, live wins) + its pure core.
export {
  useSessionContextHealth,
  resolveSessionContextHealth,
} from './model/use-session-context-health';
export type { SessionContextHealth } from './model/use-session-context-health';
// Fleet-level context rollup — runtime-neutral counts for the summary surfaces.
export { useFleetContextRollup } from './model/use-fleet-context-rollup';
export type { FleetContextRollup } from './model/use-fleet-context-rollup';
export { usePulseMotion } from './model/use-pulse-motion';
export { useRenameSession } from './model/use-rename-session';

// UI — session row display primitive
export { SessionRow } from './ui/SessionRow';
export type { SessionRowProps } from './ui/SessionRow';
export { SessionContextGauge } from './ui/SessionContextGauge';
