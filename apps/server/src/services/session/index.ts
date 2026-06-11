/**
 * Session services — transcript reading/parsing, session broadcasting,
 * locking, and task state management.
 *
 * @module services/session
 */
export { TASK_TOOL_NAMES, buildTaskEvent } from '../runtimes/claude-code/sdk/build-task-event.js';
export { SessionBroadcaster } from '../runtimes/claude-code/sessions/session-broadcaster.js';
export { SessionLockManager } from '../runtimes/claude-code/sessions/session-lock.js';
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
  getOrCreateProjector,
  peekProjector,
  disposeProjector,
  rekeyProjector,
  onProjectorStatusChange,
} from './session-state-projector.js';
export type { RawSessionEvent, ProjectorStatusUpdate } from './session-state-projector.js';
export { EventLog, EVENT_LOG_MAX_EVENTS } from './event-log.js';
export { RingBuffer, RING_BUFFER_MAX_EVENTS, RING_BUFFER_TTL_MS } from './ring-buffer.js';
export { triggerTurn, DetachedTurnLifecycle, CANONICAL_ID_TIMEOUT_MS } from './trigger-turn.js';
export type {
  TriggerTurnDeps,
  TriggerTurnOpts,
  TriggerTurnResult,
  FeedProjector,
} from './trigger-turn.js';
export { createEmbeddedTurnTrigger } from './embedded-turn-trigger.js';
export type { EmbeddedTurnTrigger, EmbeddedTriggerOpts } from './embedded-turn-trigger.js';

// --- Global session-list discovery → unified SSE fan-out (Task #7, ADR-0265) ---
export { SessionListBroadcaster, sessionListBroadcaster } from './session-list-broadcaster.js';
