/**
 * Session entity — domain hooks for session lifecycle, ID routing, and directory state.
 *
 * @module entities/session
 */
export { useSessions, insertOptimisticSession } from './model/use-sessions';
export { useSessionId } from './model/use-session-id';
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
  DEFAULT_SESSION_STATE,
} from './model/session-chat-store';
export type { SessionState } from './model/session-chat-store';
export { useSessionBorderState } from './model/use-session-border-state';
export type { SessionBorderKind, SessionBorderState } from './model/use-session-border-state';
export { useAgentHottestStatus } from './model/use-agent-hottest-status';
