/**
 * Session entity — domain hooks for session lifecycle, ID routing, and directory state.
 *
 * @module entities/session
 */
export { useSessions, useSessionListWarnings, insertOptimisticSession } from './model/use-sessions';
export { useAgentSessions } from './model/use-agent-sessions';
export { selectAgentSessions } from './lib/select-agent-sessions';
export { switchAgentCwd } from './lib/switch-agent-cwd';
export {
  resolveSessionForCwd,
  cachedSessionForCwd,
  notifySessionLookupFailed,
  SESSION_LOOKUP_FAILED_MESSAGE,
} from './lib/resolve-session-for-cwd';
export type { ResolveSessionDeps, ResolvedSession } from './lib/resolve-session-for-cwd';
export { beginSessionNavigation } from './lib/session-navigation-intent';
export type { CockpitLocation } from './lib/session-navigation-intent';
export type { SwitchAgentCwdStore, SwitchAgentCwdDeps } from './lib/switch-agent-cwd';
// Context-health — the one client source for context percent, thresholds, and severity.
export {
  CONTEXT_WARNING_PERCENT,
  CONTEXT_CRITICAL_PERCENT,
  CONTEXT_PROMOTE_PERCENT,
  CONTEXT_ACTION_PERCENT,
  contextSeverity,
  deriveContextPercent,
  resolveDisplayContextPercent,
} from './lib/context-health';
export type { ContextSeverity } from './lib/context-health';
export { deriveStatusBarValues } from './lib/derive-status-bar';
export { selectRenderedStatus } from './lib/select-rendered-status';
export { useSessionRenderedStatus } from './model/use-session-rendered-status';
export { sessionDisplayTitle, UNTITLED_SESSION_LABEL } from './lib/session-display-title';
export { useSessionRuntime } from './model/use-session-runtime';
export { useSessionId, useStartNewSession } from './model/use-session-id';
export type { SetSessionIdOptions } from './model/use-session-id';
export { useSessionStatus } from './model/use-session-status';
export type { SessionStatusData } from './model/use-session-status';
// Query-key factory — the one place a session cache key is built, so a reader
// can never look in an entry no writer fills (DOR-482).
export { sessionKeys } from './api/query-keys';
// Permission mode — the single client answer to "will this agent ask me first?".
// `isBypassPermissionMode` is in `shared/lib`, not here: an integration binding is
// an entity and cannot import a sibling entity, and it is one of the three surfaces
// that must agree about what a bypass mode covers.
//
// `FULL_POWER_MARK_LABEL` is published so the row tests assert the exact shipped
// string instead of re-hardcoding it — one source of truth for the mark's copy.
export { FULL_POWER_MARK_LABEL } from './lib/permission-mode';
export { useSessionDetail } from './model/use-session-detail';
// The store itself is published (tests reset it between cases); the per-session
// selector and its types stay slice-private — `useSessionStatus` is the only
// legitimate reader of a pending change.
export { useSessionSettingsOverridesStore } from './model/session-settings-overrides';
export { useDefaultCwd } from './model/use-default-cwd';
export { useDirectoryState } from './model/use-directory-state';

export type { SetDirOptions } from './model/use-directory-state';
export { useModels, modelsQueryOptions } from './model/use-models';
export { useSubagents } from './model/use-subagents';
export { useSessionSearch } from './model/use-session-search';
export {
  useSessionChatStore,
  useSessionChatState,
  useSessionMessages,
  useSessionStatus as useSessionChatStatus,
  useHasConfirmedAuto,
  useHasConfirmedAutonomy,
  useHasDismissedDefaultStopOffer,
  useModeBeforePlan,
  DEFAULT_SESSION_STATE,
} from './model/session-chat-store';
export type { SessionState } from './model/session-chat-store';
// Session-stream infrastructure (spec chat-stream-reconnection, Phase 3).
export {
  useSessionStreamStore,
  useSessionStreamState,
  useSessionStreamStatus,
  useSessionStreamLifecycle,
  useSessionSteerable,
  useSessionAwaitingDecision,
  useSessionStreamConnection,
  useSessionLastEventSeq,
  useSessionLastEventAt,
  useSessionSnapshotCursor,
  useSessionTriggerPending,
  useSessionInProgressTurn,
  useSessionQueue,
  useSessionQueueOutcomes,
  DEFAULT_SESSION_STREAM_STATE,
} from './model/session-stream-store';
export type { SessionStreamState } from './model/session-stream-store';
export {
  useSessionListStore,
  useSessionListSessions,
  useSessionListStatus,
  useSessionToolActivity,
  selectSessionActivity,
  useSessionContextReading,
  useSessionRekeyTarget,
} from './model/session-list-store';
export type { SessionContextReading } from './model/session-list-store';
export {
  initSessionStreamBinding,
  resetSessionStreamBinding,
} from './model/session-stream-binding';
export { useGlobalSessionStream } from './model/use-global-session-stream';
export { RECENT_SESSIONS_WINDOW, useRecentSessions } from './model/use-recent-sessions';

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
export { useAgentsAggregateStatus } from './model/use-agents-aggregate-status';
export type { UseAgentsAggregateStatusOptions } from './model/use-agents-aggregate-status';
export { usePulseMotion } from './model/use-pulse-motion';
// Attention-signal model (DOR-339) — single source of per-agent "does this
// need my eyes?" truth for filters, reveal rows, rollup dots, and mute.
export {
  deriveAttention,
  useAgentAttentionMap,
  ATTENTION_THRESHOLDS,
} from './model/agent-attention';
export type { AttentionState, LiveBorderKind } from './model/agent-attention';
export { useRenameSession } from './model/use-rename-session';

// UI — session row display primitive
export { SessionRow } from './ui/SessionRow';
export type { SessionRowProps } from './ui/SessionRow';
// The session row in the sidebar's own grammar (`shared/ui/SidebarRow`). Kept
// out of `SessionRow`'s `variant` union on purpose: this one renders its own
// list item, so it belongs inside a `SidebarMenu` and nowhere a `<div>` row goes.
export { SessionRowSidebar } from './ui/SessionRowSidebar';
export type { SessionRowSidebarProps } from './ui/SessionRowSidebar';
export { SessionContextGauge } from './ui/SessionContextGauge';
// The leaf that holds the live verb, so the sidebar model never has to (R1).
export { SessionVerbLine } from './ui/SessionVerbLine';
export type { SessionVerbLineProps } from './ui/SessionVerbLine';

// Origin — session-origin-legibility: descriptor registry, the row glyph, and the sidebar partition selector.
export { ORIGIN_DESCRIPTORS, getOriginDescriptor } from './config/origin-descriptors';
export type { OriginDescriptor } from './config/origin-descriptors';
export { SessionOriginMark } from './ui/SessionOriginMark';
export {
  humanOriginSessionIds,
  partitionSessionsByOrigin,
} from './lib/partition-sessions-by-origin';
export type { SessionOriginPartition } from './lib/partition-sessions-by-origin';
export { useSessionOrigin } from './model/use-sessions';
export type { SessionOriginData } from './model/use-sessions';
