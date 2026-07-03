/**
 * Session entity — domain hooks for session lifecycle, ID routing, and directory state.
 *
 * @module entities/session
 */
export { useSessions, useSessionListWarnings, insertOptimisticSession } from './model/use-sessions';
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
  useSessionRekeyTarget,
} from './model/session-list-store';
export {
  initSessionStreamBinding,
  resetSessionStreamBinding,
} from './model/session-stream-binding';
export { useGlobalSessionStream } from './model/use-global-session-stream';

export { useSessionBorderState } from './model/use-session-border-state';
export type { SessionBorderKind, SessionBorderState } from './model/use-session-border-state';
export { useAgentHottestStatus } from './model/use-agent-hottest-status';
export { usePulseMotion } from './model/use-pulse-motion';
export { useRenameSession } from './model/use-rename-session';

// UI — session row display primitive
export { SessionRow } from './ui/SessionRow';
export type { SessionRowProps } from './ui/SessionRow';
