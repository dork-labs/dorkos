/**
 * Session services — transcript reading/parsing, locking, projection, and
 * task state management.
 *
 * @module services/session
 */
export { TASK_TOOL_NAMES, buildTaskEvent } from '../runtimes/claude-code/sdk/build-task-event.js';
export { SessionLockManager } from './session-lock.js';
export { parseTasks } from '../runtimes/claude-code/sessions/task-reader.js';
export {
  extractToolResultContent,
  extractTextContent,
  extractCommandMeta,
  stripSystemTags,
  parseTranscript,
} from '../runtimes/claude-code/sessions/transcript-parser.js';
export type {
  TranscriptLine,
  ContentBlock,
} from '../runtimes/claude-code/sessions/transcript-parser.js';
export { TranscriptReader } from '../runtimes/claude-code/sessions/transcript-reader.js';
export type {
  HistoryMessage,
  HistoryToolCall,
} from '../runtimes/claude-code/sessions/transcript-reader.js';

// --- Runtime-neutral session-state projection (ADR-0264) ---
export {
  SessionStateProjector,
  CAPABILITY_HOLD_PAUSE_GRACE_MS,
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  rekeyProjector,
  onProjectorRekey,
  onProjectorStatusChange,
  onProjectorInteractionChange,
  listPendingInteractionsAcrossSessions,
  setSessionEventStore,
  getSessionEventStore,
} from './session-state-projector.js';
export type {
  RawSessionEvent,
  ProjectorStatusUpdate,
  InteractionChange,
} from './session-state-projector.js';
export { persistenceModeFor } from './projector-persistence.js';
export type { ProjectorPersistenceMode } from './projector-persistence.js';
export { EventLog, EVENT_LOG_MAX_EVENTS } from './event-log.js';
export { reconstructHistoryFromEvents } from './event-log-history.js';
// --- Durable session-event store for LOG-BACKED runtimes (DOR-189) ---
export { SessionEventStore } from './session-event-store.js';
export { readLogBackedHistory } from './log-backed-history.js';
// --- Answered permission decisions, re-applied to runtime-owned history ---
export { overlayApprovalReceipts } from './approval-receipt-overlay.js';
export { RingBuffer, RING_BUFFER_MAX_EVENTS, RING_BUFFER_TTL_MS } from './ring-buffer.js';
export { DevtoolsCaptureStore, devtoolsCaptureStore } from './devtools-capture-store.js';
export type {
  CaptureBuffer,
  CaptureBufferView,
  DevtoolsScreenshotEntry,
} from './devtools-capture-store.js';
export {
  triggerTurn,
  DetachedTurnLifecycle,
  CANONICAL_ID_TIMEOUT_MS,
  guardTurnErrors,
} from './trigger-turn.js';
export type { TriggerTurnDeps, TriggerTurnOpts, TriggerTurnResult } from './trigger-turn.js';
export {
  resolveSessionDefaults,
  readAgentExecutionDefaults,
  describeExecutionDefaults,
  type AgentExecutionDefaults,
} from './resolve-session-defaults.js';
export { triggerCommandIntent } from './trigger-command-intent.js';
export {
  adoptQueuedMessages,
  dispatchMessage,
  dispatchCommandIntent,
  emitQueueUpdate,
  listQueuedMessages,
  noteSessionOrphaned,
  noteTurnBoundary,
  sweepOrphanedMessageQueues,
  withDispatchMutex,
} from './message-dispatcher.js';
export type {
  AdoptQueuedMessagesOpts,
  DispatchMessageOpts,
  DispatchCommandIntentOpts,
  MessageDispatchResult,
  WhenBusy,
} from './message-dispatcher.js';
export { linkSessionId } from './session-key-registry.js';
export {
  cancelQueuedMessage,
  clearQueuedMessages,
  editQueuedMessage,
} from './queued-message-edits.js';
export type { QueuedMessageEdit } from './queued-message-edits.js';
export {
  MessageQueueStore,
  QUEUE_POSITION_STEP,
  getMessageQueueStore,
  setMessageQueueStore,
  toQueuedMessage,
} from './message-queue-store.js';
export type { EnqueueInput, MoveTarget, QueuedMessageRecord } from './message-queue-store.js';
export type {
  TriggerCommandIntentDeps,
  TriggerCommandIntentOpts,
  TriggerCommandIntentResult,
} from './trigger-command-intent.js';
export { withStallGuard } from './stall-guard.js';
export type { StallGuardOpts } from './stall-guard.js';
export { TurnWindowSignal } from './turn-window-signal.js';
export type { TurnWindowWatcher } from './turn-window-signal.js';
export { toRawSessionEvent, feedProjector } from './session-event-normalizer.js';
export { listPendingInteractions } from './pending-interactions.js';
export type { PendingInteractionEntry } from './pending-interactions.js';
export {
  createEmbeddedTurnTrigger,
  createEmbeddedCommandIntentTrigger,
} from './embedded-turn-trigger.js';
export type {
  EmbeddedTurnTrigger,
  EmbeddedTriggerOpts,
  EmbeddedCommandIntentTrigger,
  EmbeddedCommandIntentOpts,
} from './embedded-turn-trigger.js';

// --- Multi-runtime session-list aggregation (ADR-0310) ---
export { aggregateSessionList, LIST_SESSIONS_TIMEOUT_MS } from './aggregate-session-list.js';
export { fanOutAgentSessions } from './agent-session-fanout.js';
export { listRecentSessions } from './recent-sessions.js';
export { countSessionsPerDay } from './session-daily-counts.js';

// --- Global session-list discovery → unified SSE fan-out (Task #7, ADR-0265) ---
export { SessionListBroadcaster, sessionListBroadcaster } from './session-list-broadcaster.js';
export type { RoomBindingsPort } from './session-list-broadcaster.js';

// --- Session-origin overlays, room then Pulse (session-origin-legibility,
// team-room-home §D2.3, ADR 260808-140954). The composite is the only seam:
// the two halves are ordered, and a caller reaching past this for one of them
// would be choosing an ordering rather than following one (DOR-1141). ---
export {
  applySessionOriginOverlays,
  sessionOriginResolvers,
} from './origin/session-origin-overlays.js';
export type { SessionOriginResolvers } from './origin/session-origin-overlays.js';

// --- "Nobody typed here" gate on userLastMessageAt (BC-16, DOR-1081) ---
export { dropUserLastMessageAtWithoutOperator } from './origin/user-last-message-origin.js';

// --- Persisted per-session settings overlay (ADR-0260, DOR-463) ---
export { overlayStoredSettings, resolveSettingsKey } from './session-settings-overlay.js';
